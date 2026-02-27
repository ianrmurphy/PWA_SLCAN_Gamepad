const $ = (id) => document.getElementById(id);

const STORAGE_KEYS = {
  count: "basic_pwa_count",
  note: "basic_pwa_note",
};
let deferredInstallPrompt = null;

const SERIAL_BAUD_RATE = 115200;
const AXIS_EPSILON = 0.04;
const BUTTON_EPSILON = 0.02;
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
let txSequence = 0;

const gamepadSnapshots = new Map();
let gamepadLoopHandle = 0;

function loadState() {
  const count = Number(localStorage.getItem(STORAGE_KEYS.count) ?? "0");
  const note = localStorage.getItem(STORAGE_KEYS.note) ?? "";
  return { count, note };
}

function saveCount(count) {
  localStorage.setItem(STORAGE_KEYS.count, String(count));
}

function saveNote(note) {
  localStorage.setItem(STORAGE_KEYS.note, note);
}

function render({ count, note }) {
  $("count").textContent = String(count);
  $("note").value = note;
}

function setCodeState(id, text, className) {
  const elem = $(id);
  if (!elem) return;
  elem.textContent = text;
  elem.className = className ?? "";
}

function updateNetworkStatus() {
  setCodeState("netState", navigator.onLine ? "online" : "offline", navigator.onLine ? "ok" : "warn");
  $("status").textContent = navigator.onLine
    ? "Online: you can load/update the cache."
    : "Offline: this page is served from cache.";
}

function isStandaloneMode() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function setInstallState(text, className) {
  setCodeState("installState", text, className);
}

function updateInstallUI() {
  const installBtn = $("install");
  if (!installBtn) return;

  if (isStandaloneMode()) {
    installBtn.hidden = true;
    setInstallState("installed", "ok");
    return;
  }

  if (deferredInstallPrompt) {
    installBtn.hidden = false;
    installBtn.disabled = false;
    setInstallState("available", "ok");
    return;
  }

  installBtn.hidden = true;
  setInstallState("not available yet", "warn");
}

function setupInstallFlow() {
  const installBtn = $("install");
  if (!installBtn) return;

  installBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;

    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    installBtn.disabled = true;

    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;

      if (choice?.outcome === "accepted") {
        setInstallState("accepted, installing...", "ok");
      } else {
        setInstallState("dismissed", "warn");
      }
    } catch (e) {
      setInstallState(`error: ${e?.message ?? e}`, "warn");
    }

    updateInstallUI();
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    updateInstallUI();
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    updateInstallUI();
  });

  updateInstallUI();
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    setCodeState("swState", "not supported", "warn");
    return;
  }

  try {
    const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });

    // Note: first install may not control the page until reload.
    const controlled = !!navigator.serviceWorker.controller;

    setCodeState("swState", controlled ? "active (controlling)" : "installed (reload once)", "ok");

    reg.addEventListener("updatefound", () => {
      setCodeState("swState", "updating...", "warn");
    });

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      setCodeState("swState", "active (controlling)", "ok");
    });
  } catch (e) {
    setCodeState("swState", "failed", "warn");
    $("status").textContent = `Service worker error: ${e?.message ?? e}`;
  }
}

function setSerialState(text, className) {
  setCodeState("serialState", text, className);
}

function setGamepadState(text, className) {
  setCodeState("gamepadState", text, className);
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

function parseCanId() {
  const raw = $("canId")?.value?.trim() ?? "";
  if (!/^[0-9A-Fa-f]{1,3}$/.test(raw)) return null;

  const canId = Number.parseInt(raw, 16);
  if (Number.isNaN(canId) || canId < 0x000 || canId > 0x7ff) return null;
  return canId;
}

function normalizeCanIdInput() {
  const canIdInput = $("canId");
  if (!canIdInput) return;

  const parsed = parseCanId();
  if (parsed === null) return;
  canIdInput.value = parsed.toString(16).toUpperCase().padStart(3, "0");
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

  // Keep queue bounded if gamepad updates spike.
  if (serialQueue.length >= 512) {
    serialQueue.shift();
  }

  serialQueue.push(`${line}\r`);
  if (!serialDrainPromise) {
    serialDrainPromise = drainSerialQueue().finally(() => {
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

async function disconnectSerial(stateText = "not connected", stateClass = "warn") {
  const port = serialPort;
  const writer = serialWriter;
  serialPort = null;
  serialWriter = null;
  resetSerialQueue();
  updateSerialUI();

  if (writer) {
    try {
      await writer.write(serialEncoder.encode("C\r"));
    } catch {}

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

  const canId = parseCanId();
  if (canId === null) {
    setSerialState("invalid CAN ID (hex 000-7FF)", "warn");
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
    txSequence = 0;

    await sendSlcanCommand(`S${getBitrateCode()}`);
    await sendSlcanCommand("O");

    setSerialState("connected (channel open)", "ok");
  } catch (e) {
    const message = e?.message ?? String(e);
    await disconnectSerial(`connect failed: ${message}`, "warn");
  }

  updateSerialUI();
}

function clampByte(value) {
  const intValue = Number(value);
  if (!Number.isFinite(intValue)) return 0;
  if (intValue < 0) return 0;
  if (intValue > 255) return 255;
  return intValue | 0;
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

function axisToBytes(value) {
  const clamped = Math.max(-1, Math.min(1, value));
  const scaled = Math.round(clamped * 32767);
  const twos = scaled < 0 ? 0x10000 + scaled : scaled;
  return [twos & 0xff, (twos >> 8) & 0xff];
}

function queueGamepadFrame(eventType, padIndex, controlIndex, d0 = 0, d1 = 0, d2 = 0, d3 = 0) {
  if (!isSerialConnected()) return;

  const canId = parseCanId();
  if (canId === null) {
    setSerialState("invalid CAN ID (hex 000-7FF)", "warn");
    return;
  }

  const frameData = [
    eventType,
    padIndex & 0xff,
    controlIndex & 0xff,
    clampByte(d0),
    clampByte(d1),
    clampByte(d2),
    clampByte(d3),
    txSequence & 0xff,
  ];
  txSequence = (txSequence + 1) & 0xff;
  queueSerialLine(encodeSlcanDataFrame(canId, frameData));
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
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const seenIndices = new Set();

  for (const gamepad of pads) {
    if (!gamepad) continue;
    const index = gamepad.index;
    seenIndices.add(index);
    const previous = gamepadSnapshots.get(index);

    if (!previous) {
      gamepadSnapshots.set(index, cloneGamepadState(gamepad));
      queueGamepadFrame(
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
        queueGamepadFrame(
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
      queueGamepadFrame(GAMEPAD_EVENT.axis, index, axisIndex, lo, hi);
    }

    gamepadSnapshots.set(index, cloneGamepadState(gamepad));
  }

  for (const [index, previous] of gamepadSnapshots.entries()) {
    if (seenIndices.has(index)) continue;
    queueGamepadFrame(
      GAMEPAD_EVENT.disconnect,
      index,
      0xff,
      previous.buttons.length,
      previous.axes.length
    );
    gamepadSnapshots.delete(index);
    setGamepadState(`disconnected #${index}`, "warn");
  }

  if (!pads.some(Boolean) && gamepadSnapshots.size === 0) {
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

function setupSerialBridge() {
  const connectBtn = $("serialConnect");
  const disconnectBtn = $("serialDisconnect");
  const canIdInput = $("canId");

  if (!connectBtn || !disconnectBtn || !canIdInput) return;

  if (!("serial" in navigator)) {
    setSerialState("WebSerial not supported", "warn");
    updateSerialUI();
    return;
  }

  setSerialState("ready to connect", "warn");
  updateSerialUI();

  connectBtn.addEventListener("click", () => {
    void connectSerial();
  });

  disconnectBtn.addEventListener("click", () => {
    void disconnectSerial();
  });

  canIdInput.addEventListener("input", () => {
    if (parseCanId() === null) {
      setSerialState("invalid CAN ID (hex 000-7FF)", "warn");
      return;
    }
    if (!isSerialConnected()) {
      setSerialState("ready to connect", "warn");
    }
  });

  canIdInput.addEventListener("blur", normalizeCanIdInput);

  navigator.serial.addEventListener("disconnect", (event) => {
    if (serialPort && event.port === serialPort) {
      void disconnectSerial("device disconnected", "warn");
    }
  });
}

function main() {
  let state = loadState();
  render(state);

  $("inc").addEventListener("click", () => {
    state.count += 1;
    saveCount(state.count);
    render(state);
  });

  $("dec").addEventListener("click", () => {
    state.count -= 1;
    saveCount(state.count);
    render(state);
  });

  $("reset").addEventListener("click", () => {
    state.count = 0;
    state.note = "";
    saveCount(state.count);
    saveNote(state.note);
    render(state);
  });

  $("note").addEventListener("input", (e) => {
    state.note = e.target.value;
    saveNote(state.note);
  });

  window.addEventListener("online", updateNetworkStatus);
  window.addEventListener("offline", updateNetworkStatus);
  updateNetworkStatus();

  setupInstallFlow();
  setupSerialBridge();
  setupGamepadBridge();
  registerServiceWorker();
}

main();
