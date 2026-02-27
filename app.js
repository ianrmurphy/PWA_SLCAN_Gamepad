const $ = (id) => document.getElementById(id);

const SERIAL_BAUD_RATE = 115200;
const AXIS_EPSILON = 0.04;
const BUTTON_EPSILON = 0.02;
const MAX_SERIAL_QUEUE = 512;

const DEFAULT_PERIODIC_FRAMES = [
  { id: 0x510, intervalMs: 20 },
  { id: 0x512, intervalMs: 20 },
  { id: 0x513, intervalMs: 20 },
  { id: 0x514, intervalMs: 20 },
];

const GAMEPAD_EVENT = {
  connect: 0x01,
  disconnect: 0x02,
  button: 0x10,
  axis: 0x20,
};

let serialPort = null;
let serialWriter = null;
let serialQueue = [];
let serialDrainPromise = null;
const serialEncoder = new TextEncoder();

let txCount = 0;

const gamepadSnapshots = new Map();
let gamepadLoopHandle = 0;

let periodicFrames = [];
let canTxLoops = [];
let stateMachine = null;

// Bytes 0..6 are gamepad-derived; byte 7 carries the current state value.
let latestGamepadPayload = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

async function cleanupLegacyPwaArtifacts() {
  if ("serviceWorker" in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    } catch {}
  }

  if ("caches" in window) {
    try {
      const cacheNames = await caches.keys();
      const legacyCacheNames = cacheNames.filter((name) => name.startsWith("basic-pwa-cache-"));
      await Promise.all(legacyCacheNames.map((name) => caches.delete(name)));
    } catch {}
  }
}

function setCodeState(id, text, className = "") {
  const elem = $(id);
  if (!elem) return;
  elem.textContent = text;
  elem.className = className;
}

function setSerialState(text, className) {
  setCodeState("serialState", text, className);
}

function setGamepadState(text, className) {
  setCodeState("gamepadState", text, className);
}

function setSchedulerState(text, className) {
  setCodeState("txSchedulerState", text, className);
}

function setFrameConfigState(text, className) {
  setCodeState("frameConfig", text, className);
}

function setStateMachineConfigState(text, className) {
  setCodeState("stateMachineConfig", text, className);
}

function setStateMachineState(text, className) {
  setCodeState("stateMachineState", text, className);
}

function setTxCount(value) {
  setCodeState("txCount", String(value));
}

function setLastFrame(value) {
  setCodeState("lastFrame", value);
}

function clampByte(value) {
  const intValue = Number(value);
  if (!Number.isFinite(intValue)) return 0;
  if (intValue < 0) return 0;
  if (intValue > 255) return 255;
  return intValue | 0;
}

function parseCanIdValue(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value >= 0x000 && value <= 0x7ff) return value;
    return null;
  }

  if (typeof value !== "string") return null;

  const normalized = value.trim().replace(/^0x/i, "");
  if (!/^[0-9A-Fa-f]{1,3}$/.test(normalized)) return null;

  const parsed = Number.parseInt(normalized, 16);
  if (Number.isNaN(parsed) || parsed < 0x000 || parsed > 0x7ff) return null;
  return parsed;
}

function normalizeFrameConfig(frame, fallback) {
  if (!frame || typeof frame !== "object") return fallback;

  const id = parseCanIdValue(frame.id);
  const intervalMs = Number(frame.intervalMs);
  if (id === null || !Number.isFinite(intervalMs) || intervalMs <= 0) return fallback;

  return {
    id,
    intervalMs: Math.max(1, Math.round(intervalMs)),
  };
}

function loadPeriodicFrames() {
  const rawFrames = window.APP_CONFIG?.can?.periodicFrames;
  if (!Array.isArray(rawFrames) || !rawFrames.length) {
    return DEFAULT_PERIODIC_FRAMES.slice();
  }

  const normalized = rawFrames
    .map((frame, index) => normalizeFrameConfig(frame, DEFAULT_PERIODIC_FRAMES[index] ?? null))
    .filter(Boolean);

  return normalized.length ? normalized : DEFAULT_PERIODIC_FRAMES.slice();
}

function describePeriodicFrames(frames) {
  return frames
    .map((frame) => `0x${frame.id.toString(16).toUpperCase()}@${frame.intervalMs}ms`)
    .join(", ");
}

function isSerialConnected() {
  return !!(serialPort && serialWriter);
}

function updateSerialUI() {
  const connectBtn = $("serialConnect");
  const disconnectBtn = $("serialDisconnect");
  const webSerialSupported = "serial" in navigator;

  if (connectBtn) connectBtn.disabled = !webSerialSupported || isSerialConnected();
  if (disconnectBtn) disconnectBtn.disabled = !isSerialConnected();
}

function getBitrateCode() {
  const value = $("slcanBitrate")?.value ?? "4";
  return /^[0-8]$/.test(value) ? value : "4";
}

async function sendSlcanCommand(command) {
  if (!serialWriter) throw new Error("SLCAN writer is not available");
  await serialWriter.write(serialEncoder.encode(`${command}\r`));
}

function resetSerialQueue() {
  serialQueue = [];
  serialDrainPromise = null;
}

function queueSerialLine(line) {
  if (!isSerialConnected()) return;

  if (serialQueue.length >= MAX_SERIAL_QUEUE) {
    serialQueue.shift();
  }

  serialQueue.push(`${line}\r`);
  if (!serialDrainPromise) {
    serialDrainPromise = drainSerialQueue()
      .catch(async (e) => {
        const message = e?.message ?? String(e);
        await disconnectSerial(`serial write failed: ${message}`, "warn", false);
      })
      .finally(() => {
        serialDrainPromise = null;
      });
  }
}

async function drainSerialQueue() {
  while (serialQueue.length && serialWriter) {
    const next = serialQueue.shift();
    await serialWriter.write(serialEncoder.encode(next));
  }
}

function encodeSlcanDataFrame(canId, data) {
  const idHex = canId.toString(16).toUpperCase().padStart(3, "0");
  const dlc = Math.min(8, data.length);
  const dataHex = data
    .slice(0, dlc)
    .map((byte) => clampByte(byte).toString(16).toUpperCase().padStart(2, "0"))
    .join("");
  return `t${idHex}${dlc.toString(16).toUpperCase()}${dataHex}`;
}

function createAsyncLoop(intervalMs, task) {
  let active = false;
  let timeoutHandle = 0;

  async function run() {
    if (!active) return;

    const startedAt = performance.now();
    try {
      await task();
    } catch (e) {
      console.error(e);
    }

    if (!active) return;

    const elapsed = performance.now() - startedAt;
    const nextDelay = Math.max(0, intervalMs - elapsed);
    timeoutHandle = window.setTimeout(run, nextDelay);
  }

  return {
    start() {
      if (active) return;
      active = true;
      timeoutHandle = window.setTimeout(run, intervalMs);
    },

    stop() {
      active = false;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = 0;
      }
    },
  };
}

function getConnectedGamepads() {
  if (!("getGamepads" in navigator)) return [];
  return Array.from(navigator.getGamepads()).filter(Boolean);
}

function getPrimaryGamepad() {
  const pads = getConnectedGamepads();
  if (!pads.length) return null;

  pads.sort((left, right) => left.index - right.index);
  return pads[0];
}

function stopPeriodicTransmit() {
  canTxLoops.forEach((loop) => loop.stop());
  canTxLoops = [];
  setSchedulerState("stopped", "warn");
}

function buildPeriodicFrameData() {
  const stateValue = stateMachine ? stateMachine.getCurrentStateValue() : 0;

  return [
    latestGamepadPayload[0],
    latestGamepadPayload[1],
    latestGamepadPayload[2],
    latestGamepadPayload[3],
    latestGamepadPayload[4],
    latestGamepadPayload[5],
    latestGamepadPayload[6],
    stateValue,
  ];
}

async function sendPeriodicFrame(frameConfig) {
  if (!isSerialConnected()) return;

  const frame = encodeSlcanDataFrame(frameConfig.id, buildPeriodicFrameData());
  queueSerialLine(frame);
  txCount += 1;
  setTxCount(txCount);
  setLastFrame(frame);
}

function startPeriodicTransmit() {
  stopPeriodicTransmit();

  if (!isSerialConnected()) return;
  if (!periodicFrames.length) {
    setSchedulerState("no frames configured", "warn");
    return;
  }

  canTxLoops = periodicFrames.map((frameConfig) => {
    const loop = createAsyncLoop(frameConfig.intervalMs, async () => {
      await sendPeriodicFrame(frameConfig);
    });
    loop.start();
    return loop;
  });

  setSchedulerState(`running (${periodicFrames.length} loops)`, "ok");
}

async function disconnectSerial(stateText = "not connected", stateClass = "warn", sendClose = true) {
  stopPeriodicTransmit();

  const port = serialPort;
  const writer = serialWriter;
  serialPort = null;
  serialWriter = null;
  resetSerialQueue();
  updateSerialUI();

  if (writer) {
    if (sendClose) {
      try {
        await writer.write(serialEncoder.encode("C\r"));
      } catch {}
    }

    try {
      writer.releaseLock();
    } catch {}
  }

  if (port) {
    try {
      await port.close();
    } catch {}
  }

  setSerialState(stateText, stateClass);
}

async function connectSerial() {
  if (!("serial" in navigator)) {
    setSerialState("WebSerial not supported", "warn");
    updateSerialUI();
    return;
  }

  if (isSerialConnected()) return;

  if (!periodicFrames.length) {
    setSerialState("no valid TX frame config", "warn");
    return;
  }

  try {
    setSerialState("requesting port...", "warn");
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: SERIAL_BAUD_RATE });

    const writer = port.writable?.getWriter();
    if (!writer) throw new Error("serial port is not writable");

    serialPort = port;
    serialWriter = writer;
    resetSerialQueue();
    txCount = 0;
    setTxCount(0);
    setLastFrame("-");

    await sendSlcanCommand(`S${getBitrateCode()}`);
    await sendSlcanCommand("O");

    startPeriodicTransmit();
    setSerialState("connected (channel open)", "ok");
  } catch (e) {
    const message = e?.message ?? String(e);
    await disconnectSerial(`connect failed: ${message}`, "warn");
  }

  updateSerialUI();
}

function axisToBytes(value) {
  const clamped = Math.max(-1, Math.min(1, value));
  const scaled = Math.round(clamped * 32767);
  const twos = scaled < 0 ? 0x10000 + scaled : scaled;
  return [twos & 0xff, (twos >> 8) & 0xff];
}

function updateGamepadPayload(eventType, padIndex, controlIndex, d0 = 0, d1 = 0, d2 = 0, d3 = 0) {
  latestGamepadPayload = [
    clampByte(eventType),
    clampByte(padIndex),
    clampByte(controlIndex),
    clampByte(d0),
    clampByte(d1),
    clampByte(d2),
    clampByte(d3),
  ];
}

function cloneGamepadState(gamepad) {
  return {
    axes: gamepad.axes.slice(),
    buttons: gamepad.buttons.map((button) => ({
      pressed: button.pressed,
      value: button.value,
    })),
  };
}

function processGamepads() {
  const pads = getConnectedGamepads();
  const seenIndices = new Set();

  for (const gamepad of pads) {
    const index = gamepad.index;
    seenIndices.add(index);
    const previous = gamepadSnapshots.get(index);

    if (!previous) {
      gamepadSnapshots.set(index, cloneGamepadState(gamepad));
      updateGamepadPayload(
        GAMEPAD_EVENT.connect,
        index,
        0xff,
        gamepad.buttons.length,
        gamepad.axes.length
      );
      setGamepadState(`connected #${index}`, "ok");
      continue;
    }

    for (let buttonIndex = 0; buttonIndex < gamepad.buttons.length; buttonIndex += 1) {
      const button = gamepad.buttons[buttonIndex];
      const previousButton = previous.buttons[buttonIndex] ?? { pressed: false, value: 0 };
      const pressedChanged = button.pressed !== previousButton.pressed;
      const analogChanged = Math.abs(button.value - previousButton.value) >= BUTTON_EPSILON;

      if (pressedChanged || analogChanged) {
        updateGamepadPayload(
          GAMEPAD_EVENT.button,
          index,
          buttonIndex,
          button.pressed ? 1 : 0,
          Math.round(button.value * 255)
        );
      }
    }

    for (let axisIndex = 0; axisIndex < gamepad.axes.length; axisIndex += 1) {
      const currentValue = gamepad.axes[axisIndex];
      const previousValue = previous.axes[axisIndex] ?? 0;
      if (Math.abs(currentValue - previousValue) < AXIS_EPSILON) continue;

      const [lo, hi] = axisToBytes(currentValue);
      updateGamepadPayload(GAMEPAD_EVENT.axis, index, axisIndex, lo, hi);
    }

    gamepadSnapshots.set(index, cloneGamepadState(gamepad));
  }

  for (const [index, previous] of gamepadSnapshots.entries()) {
    if (seenIndices.has(index)) continue;

    updateGamepadPayload(
      GAMEPAD_EVENT.disconnect,
      index,
      0xff,
      previous.buttons.length,
      previous.axes.length
    );
    gamepadSnapshots.delete(index);
    setGamepadState(`disconnected #${index}`, "warn");
  }

  if (!pads.length && gamepadSnapshots.size === 0) {
    setGamepadState("waiting", "warn");
  }

  gamepadLoopHandle = requestAnimationFrame(processGamepads);
}

function setupGamepadBridge() {
  if (!("getGamepads" in navigator)) {
    setGamepadState("Gamepad API not supported", "warn");
    return;
  }

  setGamepadState("waiting", "warn");
  window.addEventListener("gamepadconnected", (event) => {
    setGamepadState(`connected #${event.gamepad.index}`, "ok");
  });
  window.addEventListener("gamepaddisconnected", (event) => {
    setGamepadState(`disconnected #${event.gamepad.index}`, "warn");
  });

  if (!gamepadLoopHandle) {
    gamepadLoopHandle = requestAnimationFrame(processGamepads);
  }
}

function setupConfig() {
  periodicFrames = loadPeriodicFrames();
  setFrameConfigState(describePeriodicFrames(periodicFrames), periodicFrames.length ? "ok" : "warn");

  if (!window.AppStateMachine?.create) {
    setStateMachineConfigState("state machine unavailable", "warn");
    setStateMachineState("unavailable", "warn");
    stateMachine = null;
    return;
  }

  stateMachine = window.AppStateMachine.create({
    config: window.APP_CONFIG?.stateMachine,
    getPrimaryGamepad,
    onConfigLoaded({ description }) {
      setStateMachineConfigState(description, "ok");
    },
    onStateChanged({ label }) {
      setStateMachineState(label, "ok");
    },
  });
}

function startStateMachine() {
  if (!stateMachine) return;
  stateMachine.start();
}

function setupSerialBridge() {
  const connectBtn = $("serialConnect");
  const disconnectBtn = $("serialDisconnect");

  if (!connectBtn || !disconnectBtn) return;

  if (!("serial" in navigator)) {
    setSerialState("WebSerial not supported", "warn");
    setSchedulerState("unavailable", "warn");
    updateSerialUI();
    return;
  }

  setSerialState("ready to connect", "warn");
  setSchedulerState("stopped", "warn");
  setTxCount(0);
  setLastFrame("-");
  updateSerialUI();

  connectBtn.addEventListener("click", () => {
    void connectSerial();
  });

  disconnectBtn.addEventListener("click", () => {
    void disconnectSerial();
  });

  navigator.serial.addEventListener("disconnect", (event) => {
    if (serialPort && event.port === serialPort) {
      void disconnectSerial("device disconnected", "warn", false);
    }
  });
}

function main() {
  void cleanupLegacyPwaArtifacts();
  setupConfig();
  startStateMachine();
  setupSerialBridge();
  setupGamepadBridge();
}

main();
