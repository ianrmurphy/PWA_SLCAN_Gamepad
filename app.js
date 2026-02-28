const $ = (id) => document.getElementById(id);

const APP_BUILD_VERSION = "2026-02-28.7";
const DEFAULT_SERIAL_BAUD_RATE = 2000000;
const AXIS_EPSILON = 0.04;
const BUTTON_EPSILON = 0.02;
const GAMEPAD_POLL_INTERVAL_MS = 10;
const MAX_SERIAL_QUEUE = 512;
const MISSION_TIMER_TICK_MS = 10;
const DEBUG_RENDER_INTERVAL_MS = 100;
const DUAL_INPUT_THRESHOLD = 0.2;
const SLCAN_ACK_TIMEOUT_MS = 750;
const SLCAN_INIT_ACK_TIMEOUT_MS = 2000;
const MAX_SERIAL_LOG_LINES = 200;
const SERIAL_RX_POLL_INTERVAL_MS = 20;
const SERIAL_LOAD_SAMPLE_MS = 1000;
const DEFAULT_CONTROL_MODE = "state";

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
let serialReader = null;
let serialQueue = [];
let serialDrainPromise = null;
let serialReadLoopPromise = null;
let serialReadBuffer = "";
let serialAckWaiters = [];
let serialLogLines = [];
const serialEncoder = new TextEncoder();
const serialDecoder = new TextDecoder();

let txCount = 0;

const gamepadSnapshots = new Map();
let gamepadPollLoop = null;

let periodicFrames = [];
let canTxLoops = [];
let controlLogic = null;
let activeControlMode = DEFAULT_CONTROL_MODE;
let vcu2AiStatusId = 0x520;
let slcanBitrateCode = "6";
let serialReceivePollLoop = null;
let slcanAutoPollEnabled = false;
let serialLoadMonitorLoop = null;
let serialLoadWindowStartedAt = performance.now();
let serialRxBytesSinceSample = 0;
let serialTxBytesSinceSample = 0;
let missionTimerLoop = null;
let lastDebugRenderAt = 0;
let debugRenderTimeoutHandle = 0;
let lastGamepadLiveText = "";

async function cleanupLegacyPwaArtifacts() {
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

function setAppVersion(text, className) {
  setCodeState("appVersion", text, className);
}

function setGamepadState(text, className) {
  setCodeState("gamepadState", text, className);
}

function setGamepadPollingState(text, className) {
  setCodeState("gamepadPollingState", text, className);
}

function setGamepadLiveDisplay(text, className) {
  if (text === lastGamepadLiveText) return;
  lastGamepadLiveText = text;
  setCodeState("gamepadLiveDisplay", text, className);
}

function setPageFocusState(text, className) {
  setCodeState("pageFocusState", text, className);
}

function setDualInputBanner(active) {
  const banner = $("dualInputBanner");
  if (!banner) return;
  banner.classList.toggle("show", !!active);
}

function setSchedulerState(text, className) {
  setCodeState("txSchedulerState", text, className);
}

function setSerialLoadState(text, className) {
  setCodeState("serialLoadState", text, className);
}

function setFrameConfigState(text, className) {
  setCodeState("frameConfig", text, className);
}

function setRxConfigState(text, className) {
  setCodeState("rxConfig", text, className);
}

function setLogicConfigState(text, className) {
  setCodeState("logicConfig", text, className);
}

function setAsStateDisplay(text, className) {
  setCodeState("asStateDisplay", text, className);
}

function getSelectedControlMode() {
  const selectedValue = $("controlMode")?.value;
  return selectedValue === "raw" ? "raw" : DEFAULT_CONTROL_MODE;
}

function applyControlLogicSnapshot(snapshot) {
  if (!snapshot) {
    setAsStateDisplay("unavailable", "warn");
    refreshOutputStateDisplay();
    refreshCanDebugData();
    return;
  }

  const stateSummary = [
    `AS_STATE:${snapshot.asState}`,
    `AMI_STATE:${snapshot.amiState}`,
    `HANDSHAKE:${snapshot.handshake ? 1 : 0}`,
    `GO_SIGNAL:${snapshot.goSignal ? 1 : 0}`,
  ].join(" ");
  setAsStateDisplay(stateSummary, "ok");
  refreshOutputStateDisplay();
  refreshCanDebugData();
}

function buildControlLogicStatusText(mode) {
  if (mode === "raw") {
    return "raw manual, direct gamepad";
  }
  return `switch(AS_STATE), source VCU2AI_Status ${formatCanId(vcu2AiStatusId)}`;
}

function createControlLogicForMode(mode) {
  const switchingToRaw = mode === "raw" && activeControlMode !== "raw";
  const provider = mode === "raw" ? window.ControlRawLogic : window.ControlLogic;
  if (!provider?.create) {
    const missingName = mode === "raw" ? "raw control" : "control logic";
    setLogicConfigState(`${missingName} unavailable`, "warn");
    setAsStateDisplay("unavailable", "warn");
    refreshOutputStateDisplay();
    refreshCanDebugData();
    controlLogic = null;
    activeControlMode = mode;
    return;
  }

  activeControlMode = mode;
  controlLogic = provider.create({
    resetOnCreate: switchingToRaw,
    onLogicChanged(snapshot) {
      applyControlLogicSnapshot(snapshot);
    },
  });

  setLogicConfigState(buildControlLogicStatusText(mode), "ok");
}

function refreshOutputStateDisplay() {
  const appGlobals = window.AppGlobals;
  if (!appGlobals) {
    setCodeState("missionStatusDisplay", "unavailable", "warn");
    setCodeState("steerRequestDisplay", "unavailable", "warn");
    setCodeState("torqueRequestDisplay", "unavailable", "warn");
    setCodeState("speedRequestDisplay", "unavailable", "warn");
    setCodeState("brakeRequestDisplay", "unavailable", "warn");
    setCodeState("directionRequestDisplay", "unavailable", "warn");
    setCodeState("estopRequestDisplay", "unavailable", "warn");
    return;
  }

  setCodeState("missionStatusDisplay", String(appGlobals.MISSION_STATUS ?? 0), "ok");
  setCodeState("steerRequestDisplay", String(appGlobals.STEER_REQUEST ?? 0), "ok");
  setCodeState("torqueRequestDisplay", String(appGlobals.TORQUE_REQUEST ?? 0), "ok");
  setCodeState("speedRequestDisplay", String(appGlobals.SPEED_REQUEST ?? 0), "ok");
  setCodeState("brakeRequestDisplay", String(appGlobals.BRAKE_REQUEST ?? 0), "ok");
  setCodeState("directionRequestDisplay", String(appGlobals.DIRECTION_REQUEST ?? 0), "ok");
  setCodeState("estopRequestDisplay", String(appGlobals.ESTOP_REQUEST ?? 0), "ok");
}

function setTxCount(value) {
  setCodeState("txCount", String(value));
}

function setAdapterVersion(text, className) {
  setCodeState("adapterVersion", text, className);
}

function setLastFrame(value) {
  setCodeState("lastFrame", value);
}

function setLastRxFrame(value, className) {
  setCodeState("lastRxFrame", value, className);
}

function setCanDebugData(value) {
  const elem = $("canDebugData");
  if (!elem) return;
  elem.textContent = value;
}

function setSerialConsoleData(value) {
  const elem = $("serialConsole");
  if (!elem) return;
  elem.textContent = value;
  elem.scrollTop = elem.scrollHeight;
}

function isPanelOpen(id) {
  return !!$(id)?.open;
}

function refreshSerialConsole(force = false) {
  if (!force && !isPanelOpen("serialConsolePanel")) return;
  setSerialConsoleData(serialLogLines.length ? serialLogLines.join("\n") : "waiting for serial traffic...");
}

function appendSerialLog(direction, text) {
  const now = new Date();
  const timestamp = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
  serialLogLines.push(`${timestamp} ${direction} ${text}`);
  if (serialLogLines.length > MAX_SERIAL_LOG_LINES) {
    serialLogLines.splice(0, serialLogLines.length - MAX_SERIAL_LOG_LINES);
  }
  refreshSerialConsole();
}

function parseCanIdValue(value) {
  if (window.CanEncoding?.parseCanIdValue) {
    return window.CanEncoding.parseCanIdValue(value);
  }
  return null;
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

function loadVcu2AiStatusId() {
  const parsed = parseCanIdValue(window.APP_CONFIG?.can?.vcu2AiStatusId);
  return parsed ?? (window.CanEncoding?.VCU2AI_STATUS_ID ?? 0x520);
}

function describePeriodicFrames(frames) {
  return frames
    .map((frame) => `0x${frame.id.toString(16).toUpperCase()}@${frame.intervalMs}ms`)
    .join(", ");
}

function formatCanId(canId) {
  return `0x${canId.toString(16).toUpperCase().padStart(3, "0")}`;
}

function formatPayloadHex(data) {
  if (!Array.isArray(data)) return "-";
  if (!data.length) return "(empty)";
  if (window.CanEncoding?.formatPayloadBytes) {
    return window.CanEncoding.formatPayloadBytes(data);
  }
  return data
    .map((byte) => Number(byte || 0).toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
}

function formatUiTimestamp(date = new Date()) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function formatLastTxFrameDisplay(canId, payloadBytes, date = new Date()) {
  return `${formatUiTimestamp(date)} ${formatCanId(canId)} ${formatPayloadHex(payloadBytes)}`;
}

function buildCanDebugSnapshot() {
  const appGlobals = window.AppGlobals;
  if (!appGlobals) {
    return { status: "AppGlobals unavailable" };
  }

  const txFrames = {};
  for (const frame of periodicFrames) {
    const payload = window.CanEncoding?.buildOutgoingPayloadBytes
      ? window.CanEncoding.buildOutgoingPayloadBytes(frame.id)
      : [];
    txFrames[formatCanId(frame.id)] = {
      intervalMs: frame.intervalMs,
      payloadHex: formatPayloadHex(payload),
    };
  }

  return {
    canRx: {
      filterId: formatCanId(vcu2AiStatusId),
      decodedGlobals: {
        HANDSHAKE: appGlobals.HANDSHAKE,
        GO_SIGNAL: appGlobals.GO_SIGNAL,
        AS_STATE: appGlobals.AS_STATE,
        AMI_STATE: appGlobals.AMI_STATE,
      },
      vcu2AiStatusData: {
        matchedId:
          typeof appGlobals.vcu2AiStatusData?.matchedId === "number"
            ? formatCanId(appGlobals.vcu2AiStatusData.matchedId)
            : null,
        lastTimestamp: appGlobals.vcu2AiStatusData?.lastTimestamp ?? "",
        lastPayloadHex: formatPayloadHex(appGlobals.vcu2AiStatusData?.lastPayloadBytes),
      },
      rxFrameStats: {
        totalFrames: appGlobals.rxFrameStats?.totalFrames ?? 0,
        lastSeenId:
          typeof appGlobals.rxFrameStats?.lastSeenId === "number"
            ? formatCanId(appGlobals.rxFrameStats.lastSeenId)
            : null,
        lastSeenTimestamp: appGlobals.rxFrameStats?.lastSeenTimestamp ?? "",
        countsById: appGlobals.rxFrameStats?.countsById ?? {},
      },
    },
    canTx: {
      sourceGlobals: {
        MISSION_STATUS: appGlobals.MISSION_STATUS,
        STEER_REQUEST: appGlobals.STEER_REQUEST,
        TORQUE_REQUEST: appGlobals.TORQUE_REQUEST,
        SPEED_REQUEST: appGlobals.SPEED_REQUEST,
        BRAKE_REQUEST: appGlobals.BRAKE_REQUEST,
        DIRECTION_REQUEST: appGlobals.DIRECTION_REQUEST,
        ESTOP_REQUEST: appGlobals.ESTOP_REQUEST,
        mission_timer: appGlobals.mission_timer,
      },
      txFrames,
    },
    otherGlobals: {
      GAMEPAD_BUTTON_0_PRESSED: appGlobals.GAMEPAD_BUTTON_0_PRESSED,
      GAMEPAD_BUTTON_1_PRESSED: appGlobals.GAMEPAD_BUTTON_1_PRESSED,
      GAMEPAD_BUTTON_2_PRESSED: appGlobals.GAMEPAD_BUTTON_2_PRESSED,
      GAMEPAD_BUTTON_3_PRESSED: appGlobals.GAMEPAD_BUTTON_3_PRESSED,
      GAMEPAD_X_AXIS: appGlobals.GAMEPAD_X_AXIS,
      GAMEPAD_Y_AXIS: appGlobals.GAMEPAD_Y_AXIS,
      controlLogicData: appGlobals.controlLogicData,
    },
  };
}

function renderCanDebugDataNow() {
  if (debugRenderTimeoutHandle) {
    clearTimeout(debugRenderTimeoutHandle);
    debugRenderTimeoutHandle = 0;
  }

  lastDebugRenderAt = performance.now();
  setCanDebugData(JSON.stringify(buildCanDebugSnapshot(), null, 2));
}

function refreshCanDebugData(force = false) {
  if (!force && !isPanelOpen("debugGlobalsPanel")) return;

  const elapsedMs = performance.now() - lastDebugRenderAt;
  if (force || elapsedMs >= DEBUG_RENDER_INTERVAL_MS) {
    renderCanDebugDataNow();
    return;
  }

  if (debugRenderTimeoutHandle) return;
  debugRenderTimeoutHandle = window.setTimeout(() => {
    debugRenderTimeoutHandle = 0;
    if (!isPanelOpen("debugGlobalsPanel")) return;
    renderCanDebugDataNow();
  }, DEBUG_RENDER_INTERVAL_MS - elapsedMs);
}

function setupCollapsiblePanels() {
  $("serialConsolePanel")?.addEventListener("toggle", (event) => {
    if (event.currentTarget?.open) {
      refreshSerialConsole(true);
    }
  });

  $("debugGlobalsPanel")?.addEventListener("toggle", (event) => {
    if (event.currentTarget?.open) {
      lastDebugRenderAt = 0;
      refreshCanDebugData(true);
    }
  });
}

function isSerialConnected() {
  return !!(serialPort && serialWriter);
}

function updateSerialUI() {
  const connectBtn = $("serialConnect");
  const disconnectBtn = $("serialDisconnect");
  const baudRateSelect = $("serialBaudRate");
  const webSerialSupported = "serial" in navigator;

  if (connectBtn) connectBtn.disabled = !webSerialSupported || isSerialConnected();
  if (disconnectBtn) disconnectBtn.disabled = !isSerialConnected();
  if (baudRateSelect) baudRateSelect.disabled = !webSerialSupported || isSerialConnected();
}

function loadSlcanBitrateCode() {
  const value = String(window.APP_CONFIG?.serial?.slcanBitrate ?? "6");
  return /^[0-8]$/.test(value) ? value : "6";
}

function getSerialBaudRate() {
  const rawValue = $("serialBaudRate")?.value ?? String(DEFAULT_SERIAL_BAUD_RATE);
  const parsed = Number.parseInt(rawValue, 10);
  if (![115200, 250000, 500000, 1000000, 2000000].includes(parsed)) {
    return DEFAULT_SERIAL_BAUD_RATE;
  }
  return parsed;
}

function resetSerialLoadStats() {
  serialLoadWindowStartedAt = performance.now();
  serialRxBytesSinceSample = 0;
  serialTxBytesSinceSample = 0;
}

function recordSerialTraffic(direction, byteCount) {
  const bytes = Number(byteCount);
  if (!Number.isFinite(bytes) || bytes <= 0) return;

  if (direction === "rx") {
    serialRxBytesSinceSample += bytes;
    return;
  }

  if (direction === "tx") {
    serialTxBytesSinceSample += bytes;
  }
}

function sampleSerialLoad() {
  const now = performance.now();
  const elapsedMs = Math.max(1, now - serialLoadWindowStartedAt);
  const rxBytes = serialRxBytesSinceSample;
  const txBytes = serialTxBytesSinceSample;
  resetSerialLoadStats();

  if (!isSerialConnected()) {
    setSerialLoadState("idle", "");
    return;
  }

  const baudRate = getSerialBaudRate();
  const totalBitsPerSecond = ((rxBytes + txBytes) * 10 * 1000) / elapsedMs;
  const utilization = baudRate > 0 ? totalBitsPerSecond / baudRate : 0;
  const utilizationText = `${Math.round(utilization * 100)}%`;
  const rxRate = Math.round((rxBytes * 1000) / elapsedMs);
  const txRate = Math.round((txBytes * 1000) / elapsedMs);

  if (utilization >= 0.85) {
    setSerialLoadState(`high ${utilizationText} (overrun risk, rx ${rxRate}B/s tx ${txRate}B/s)`, "warn");
    return;
  }

  if (utilization >= 0.65) {
    setSerialLoadState(`elevated ${utilizationText} (rx ${rxRate}B/s tx ${txRate}B/s)`, "warn");
    return;
  }

  setSerialLoadState(`${utilizationText} (rx ${rxRate}B/s tx ${txRate}B/s)`, "ok");
}

async function sendSlcanCommand(command) {
  const waitForAck = arguments[1]?.waitForAck ?? false;
  const allowAckError = arguments[1]?.allowAckError ?? false;
  const ackTimeoutMs = arguments[1]?.ackTimeoutMs ?? SLCAN_ACK_TIMEOUT_MS;
  if (!serialWriter) throw new Error("SLCAN writer is not available");

  let waiter = null;
  let ackPromise = null;

  if (waitForAck) {
    ackPromise = new Promise((resolve, reject) => {
      waiter = {
        command,
        allowAckError,
        resolve,
        reject,
        timeoutHandle: 0,
      };
      waiter.timeoutHandle = window.setTimeout(() => {
        const index = serialAckWaiters.indexOf(waiter);
        if (index >= 0) {
          serialAckWaiters.splice(index, 1);
        }
        reject(new Error(`SLCAN command "${command}" timed out waiting for acknowledgement`));
      }, ackTimeoutMs);
      serialAckWaiters.push(waiter);
    });
  }

  try {
    appendSerialLog("TX", command);
    const encoded = serialEncoder.encode(`${command}\r`);
    await serialWriter.write(encoded);
    recordSerialTraffic("tx", encoded.length);
  } catch (e) {
    if (waiter) {
      const index = serialAckWaiters.indexOf(waiter);
      if (index >= 0) {
        serialAckWaiters.splice(index, 1);
      }
      clearTimeout(waiter.timeoutHandle);
    }
    throw e;
  }

  if (ackPromise) {
    return ackPromise;
  }

  return true;
}

function resetSerialQueue() {
  serialQueue = [];
  serialDrainPromise = null;
}

function rejectSerialAckWaiter(waiter, error) {
  if (!waiter) return;
  clearTimeout(waiter.timeoutHandle);
  waiter.reject(error);
}

function resolveSerialAckWaiter(waiter, value) {
  if (!waiter) return;
  clearTimeout(waiter.timeoutHandle);
  waiter.resolve(value);
}

function clearSerialAckWaiters(reason = "serial acknowledgements cleared") {
  const pendingWaiters = serialAckWaiters;
  serialAckWaiters = [];
  for (const waiter of pendingWaiters) {
    rejectSerialAckWaiter(waiter, new Error(reason));
  }
}

function settleNextSerialAck(success, resolvedValue = success) {
  const waiter = serialAckWaiters.shift();
  if (!waiter) {
    if (!success) {
      console.debug("Ignoring unsolicited SLCAN error acknowledgement");
    }
    return;
  }

  if (success || waiter.allowAckError) {
    resolveSerialAckWaiter(waiter, resolvedValue);
    return;
  }

  rejectSerialAckWaiter(
    waiter,
    new Error(`SLCAN command "${waiter.command}" rejected by adapter`)
  );
}

function matchPendingAckLine(trimmedLine) {
  const waiter = serialAckWaiters[0];
  if (!waiter) return false;

  const upperLine = trimmedLine.toUpperCase();
  if (upperLine === "OK") {
    settleNextSerialAck(true);
    return true;
  }

  if (upperLine === "ERROR" || upperLine === "ERR") {
    settleNextSerialAck(false);
    return true;
  }

  if (waiter.command === "V") {
    const firstChar = trimmedLine[0] ?? "";
    if (
      firstChar === "t" ||
      firstChar === "T" ||
      firstChar === "r" ||
      firstChar === "R" ||
      upperLine === "Z" ||
      upperLine === "A"
    ) {
      return false;
    }
    settleNextSerialAck(true, trimmedLine);
    return true;
  }

  if (upperLine === waiter.command.toUpperCase()) {
    settleNextSerialAck(true);
    return true;
  }

  return false;
}

function allowImplicitOpenAck(trimmedLine) {
  const waiter = serialAckWaiters[0];
  if (!waiter || waiter.command !== "O") return false;

  const upperLine = trimmedLine.toUpperCase();
  if (upperLine === "ERR" || upperLine === "ERROR") return false;

  settleNextSerialAck(true);
  return true;
}

async function configureSlcanReceiveFilter() {
  try {
    await sendSlcanCommand("M00000000");
    await sendSlcanCommand("mFFFFFFFF");
    setRxConfigState(`adapter open, VCU2AI_Status ${formatCanId(vcu2AiStatusId)}`, "ok");
  } catch (e) {
    console.warn("SLCAN receive filter setup skipped", e);
    setRxConfigState(`adapter RX unknown, VCU2AI_Status ${formatCanId(vcu2AiStatusId)}`, "warn");
  }
}

function queueSerialLine(line, options) {
  if (!isSerialConnected()) return;

  const logTraffic = options?.log !== false;
  if (logTraffic) {
    appendSerialLog("TX", line);
  }

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
    const encoded = serialEncoder.encode(next);
    await serialWriter.write(encoded);
    recordSerialTraffic("tx", encoded.length);
  }
}

function refreshControlLogicDisplay() {
  if (!controlLogic) {
    applyControlLogicSnapshot(null);
    return;
  }

  const snapshot = controlLogic.refresh();
  applyControlLogicSnapshot(snapshot);
}

function processSerialLine(rawLine) {
  const trimmedLine = rawLine.trim();
  if (!trimmedLine) {
    if (serialAckWaiters.length) {
      appendSerialLog("RX", "<CR>");
    }
    settleNextSerialAck(true);
    return;
  }

  appendSerialLog("RX", trimmedLine);

  if (matchPendingAckLine(trimmedLine)) {
    return;
  }

  allowImplicitOpenAck(trimmedLine);

  if (trimmedLine === "z" || trimmedLine === "Z") {
    if (!slcanAutoPollEnabled) {
      slcanAutoPollEnabled = true;
      stopSerialReceivePolling();
    }
    return;
  }

  if (trimmedLine === "A") {
    return;
  }

  let sawFrame = false;
  let matchedFrame = null;
  for (let offset = 0; offset < trimmedLine.length; offset += 1) {
    const marker = trimmedLine[offset];
    if (marker !== "t" && marker !== "T") continue;

    const candidateLine = trimmedLine.slice(offset);
    const parsedFrame = window.CanEncoding?.parseIncomingSlcanFrame?.(candidateLine) ?? null;
    if (!parsedFrame) continue;

    sawFrame = true;
    matchedFrame = window.CanEncoding?.tryConsumeIncomingLine(candidateLine, vcu2AiStatusId) ?? null;
    if (matchedFrame || parsedFrame) {
      break;
    }
  }

  if (matchedFrame) {
    setLastRxFrame(window.AppGlobals.vcu2AiStatusData.lastDisplayText, "ok");
    refreshControlLogicDisplay();
    return;
  }

  if (sawFrame) {
    refreshCanDebugData();
  }
}

function consumeSerialInput(chunk) {
  recordSerialTraffic("rx", chunk?.length ?? 0);
  const decoded = serialDecoder.decode(chunk, { stream: true });

  for (const char of decoded) {
    if (char === "\r") {
      processSerialLine(serialReadBuffer);
      serialReadBuffer = "";
      continue;
    }

    if (char === "\n") {
      if (serialReadBuffer.length) {
        processSerialLine(serialReadBuffer);
        serialReadBuffer = "";
      }
      continue;
    }

    if (char === "\u0007") {
      if (serialReadBuffer.length) {
        processSerialLine(serialReadBuffer);
        serialReadBuffer = "";
      }
      appendSerialLog("RX", "<BEL>");
      settleNextSerialAck(false);
      continue;
    }

    serialReadBuffer += char;
  }
}

function startSerialReadLoop() {
  if (!serialPort?.readable || serialReader) return;

  const reader = serialPort.readable.getReader();
  serialReader = reader;
  serialReadBuffer = "";

  serialReadLoopPromise = (async () => {
    let readError = "";

    try {
      while (serialReader === reader) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.length) {
          consumeSerialInput(value);
        }
      }
    } catch (e) {
      if (serialReader === reader) {
        readError = e?.message ?? String(e);
      }
    } finally {
      if (serialReader === reader) {
        serialReader = null;
      }

      try {
        reader.releaseLock();
      } catch {}

      serialReadLoopPromise = null;

      if (readError) {
        void disconnectSerial(`serial read failed: ${readError}`, "warn", false);
      }
    }
  })();
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

function stopSerialReceivePolling() {
  if (serialReceivePollLoop) {
    serialReceivePollLoop.stop();
    serialReceivePollLoop = null;
  }
}

function startSerialReceivePolling() {
  stopSerialReceivePolling();

  if (!isSerialConnected() || slcanAutoPollEnabled) return;

  serialReceivePollLoop = createAsyncLoop(SERIAL_RX_POLL_INTERVAL_MS, async () => {
    if (!isSerialConnected()) return;
    if (serialQueue.length >= MAX_SERIAL_QUEUE) return;
    queueSerialLine("A", { log: false });
  });
  serialReceivePollLoop.start();
}

function startSerialLoadMonitorLoop() {
  if (serialLoadMonitorLoop) return;

  resetSerialLoadStats();
  serialLoadMonitorLoop = createAsyncLoop(SERIAL_LOAD_SAMPLE_MS, () => {
    sampleSerialLoad();
  });
  serialLoadMonitorLoop.start();
}

function tickMissionTimer() {
  if (!controlLogic) return;

  const shouldTickMissionTimer = controlLogic?.shouldTickMissionTimer
    ? controlLogic.shouldTickMissionTimer()
    : window.AppGlobals.AS_STATE === 0x3;

  if (shouldTickMissionTimer) {
    window.AppGlobals.mission_timer += MISSION_TIMER_TICK_MS;
  }

  refreshControlLogicDisplay();
}

function startMissionTimerLoop() {
  if (missionTimerLoop) return;

  missionTimerLoop = createAsyncLoop(MISSION_TIMER_TICK_MS, () => {
    tickMissionTimer();
  });
  missionTimerLoop.start();
}

function getConnectedGamepads() {
  if (!("getGamepads" in navigator)) return [];
  return Array.from(navigator.getGamepads()).filter(Boolean);
}

function updatePrimaryGamepadInputs(pads) {
  const primary = pads.length
    ? pads.slice().sort((left, right) => left.index - right.index)[0]
    : null;

  window.AppGlobals.GAMEPAD_BUTTON_0_PRESSED = !!primary?.buttons?.[0]?.pressed;
  window.AppGlobals.GAMEPAD_BUTTON_1_PRESSED = !!primary?.buttons?.[1]?.pressed;
  window.AppGlobals.GAMEPAD_BUTTON_2_PRESSED = !!primary?.buttons?.[2]?.pressed;
  window.AppGlobals.GAMEPAD_BUTTON_3_PRESSED = !!primary?.buttons?.[3]?.pressed;
  window.AppGlobals.GAMEPAD_X_AXIS = Number(primary?.axes?.[0] ?? 0);
  window.AppGlobals.GAMEPAD_X2_AXIS = Number(primary?.axes?.[2] ?? 0);
  window.AppGlobals.GAMEPAD_Y_AXIS = Number(primary?.axes?.[1] ?? 0);
  if (!Number.isFinite(window.AppGlobals.GAMEPAD_X_AXIS)) {
    window.AppGlobals.GAMEPAD_X_AXIS = 0;
  }
  if (!Number.isFinite(window.AppGlobals.GAMEPAD_X2_AXIS)) {
    window.AppGlobals.GAMEPAD_X2_AXIS = 0;
  }
  if (!Number.isFinite(window.AppGlobals.GAMEPAD_Y_AXIS)) {
    window.AppGlobals.GAMEPAD_Y_AXIS = 0;
  }

  const dualInputActive =
    Math.abs(window.AppGlobals.GAMEPAD_X_AXIS) >= DUAL_INPUT_THRESHOLD &&
    Math.abs(window.AppGlobals.GAMEPAD_X2_AXIS) >= DUAL_INPUT_THRESHOLD &&
    Math.sign(window.AppGlobals.GAMEPAD_X_AXIS) !== Math.sign(window.AppGlobals.GAMEPAD_X2_AXIS);
  setDualInputBanner(dualInputActive);

  const liveText = `pads:${pads.length} X:${window.AppGlobals.GAMEPAD_X_AXIS.toFixed(2)} X2:${window.AppGlobals.GAMEPAD_X2_AXIS.toFixed(2)} Y:${window.AppGlobals.GAMEPAD_Y_AXIS.toFixed(2)} B0:${window.AppGlobals.GAMEPAD_BUTTON_0_PRESSED ? 1 : 0}`;
  setGamepadLiveDisplay(liveText, pads.length ? "ok" : "warn");
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  const isSecureContextLike =
    window.isSecureContext ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1";
  if (!isSecureContextLike) return;

  try {
    await navigator.serviceWorker.register("sw.js");
  } catch (e) {
    console.warn("service worker registration failed", e);
  }
}

function stopPeriodicTransmit() {
  canTxLoops.forEach((loop) => loop.stop());
  canTxLoops = [];
  setSchedulerState("stopped", "warn");
}

async function sendPeriodicFrame(frameConfig) {
  if (!isSerialConnected()) return;
  if (!window.CanEncoding?.packPeriodicTxFrame) return;

  const payloadBytes = window.CanEncoding?.buildOutgoingPayloadBytes
    ? window.CanEncoding.buildOutgoingPayloadBytes(frameConfig.id)
    : [];
  const frame = window.CanEncoding.packPeriodicTxFrame(frameConfig.id);
  queueSerialLine(frame);
  txCount += 1;
  setTxCount(txCount);
  setLastFrame(formatLastTxFrameDisplay(frameConfig.id, payloadBytes));
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
  stopSerialReceivePolling();
  slcanAutoPollEnabled = false;
  resetSerialLoadStats();

  const port = serialPort;
  const writer = serialWriter;
  const reader = serialReader;
  const readLoop = serialReadLoopPromise;

  if (sendClose && writer) {
    if (reader) {
      try {
        await sendSlcanCommand("C", { waitForAck: true, allowAckError: true, ackTimeoutMs: 150 });
      } catch {}
    } else {
      try {
        appendSerialLog("TX", "C");
        const encoded = serialEncoder.encode("C\r");
        await writer.write(encoded);
        recordSerialTraffic("tx", encoded.length);
      } catch {}
    }
  }

  serialPort = null;
  serialWriter = null;
  serialReader = null;
  clearSerialAckWaiters("serial disconnected");
  resetSerialQueue();
  serialReadBuffer = "";
  updateSerialUI();

  if (reader) {
    try {
      await reader.cancel();
    } catch {}
  }

  if (readLoop) {
    try {
      await readLoop;
    } catch {}
  }

  if (writer) {
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
  if (!isSerialConnected()) {
    setSerialLoadState("idle", "");
  }
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
    await port.open({ baudRate: getSerialBaudRate() });

    const writer = port.writable?.getWriter();
    if (!writer) throw new Error("serial port is not writable");

    serialPort = port;
    serialWriter = writer;
    resetSerialQueue();
    startSerialReadLoop();
    resetSerialLoadStats();
    window.CanEncoding?.resetReceivedFrameStats?.();
    txCount = 0;
    setTxCount(0);
    setLastFrame("-");
    setLastRxFrame("-", "");
    setAdapterVersion("querying...", "warn");
    refreshCanDebugData();

    const adapterVersion = await sendSlcanCommand("V", {
      waitForAck: true,
      ackTimeoutMs: SLCAN_INIT_ACK_TIMEOUT_MS,
    });
    setAdapterVersion(String(adapterVersion || "-"), "ok");

    try {
      await sendSlcanCommand("C", { waitForAck: true, allowAckError: true, ackTimeoutMs: 150 });
    } catch {}
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    await sendSlcanCommand(`S${slcanBitrateCode}`);
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    await configureSlcanReceiveFilter();

    slcanAutoPollEnabled = false;
    await sendSlcanCommand("X1");
    await sendSlcanCommand("O");

    startSerialReceivePolling();

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

function setGamepadData(eventType, padIndex, controlIndex, d0 = 0, d1 = 0, d2 = 0, d3 = 0) {
  if (!window.CanEncoding?.updateGamepadData) return;

  window.CanEncoding.updateGamepadData(eventType, padIndex, controlIndex, d0, d1, d2, d3);
  refreshCanDebugData();
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

  updatePrimaryGamepadInputs(pads);

  for (const gamepad of pads) {
    const index = gamepad.index;
    seenIndices.add(index);
    const previous = gamepadSnapshots.get(index);

    if (!previous) {
      gamepadSnapshots.set(index, cloneGamepadState(gamepad));
      setGamepadData(
        GAMEPAD_EVENT.connect,
        index,
        0xff,
        gamepad.buttons.length,
        gamepad.axes.length
      );
      setGamepadState(
        `connected #${index} (${gamepad.buttons.length} buttons, ${gamepad.axes.length} axes)`,
        "ok"
      );
      continue;
    }

    for (let buttonIndex = 0; buttonIndex < gamepad.buttons.length; buttonIndex += 1) {
      const button = gamepad.buttons[buttonIndex];
      const previousButton = previous.buttons[buttonIndex] ?? { pressed: false, value: 0 };
      const pressedChanged = button.pressed !== previousButton.pressed;
      const analogChanged = Math.abs(button.value - previousButton.value) >= BUTTON_EPSILON;

      if (pressedChanged || analogChanged) {
        if (button.pressed && !previousButton.pressed) {
          if (buttonIndex === 0) {
            window.AppGlobals.GAMEPAD_BUTTON_0_PRESS_COUNT += 1;
          } else if (buttonIndex === 1) {
            window.AppGlobals.GAMEPAD_BUTTON_1_PRESS_COUNT += 1;
          } else if (buttonIndex === 2) {
            window.AppGlobals.GAMEPAD_BUTTON_2_PRESS_COUNT += 1;
          } else if (buttonIndex === 3) {
            window.AppGlobals.GAMEPAD_BUTTON_3_PRESS_COUNT += 1;
          }
        }

        setGamepadData(
          GAMEPAD_EVENT.button,
          index,
          buttonIndex,
          button.pressed ? 1 : 0,
          Math.round(button.value * 255)
        );
        setGamepadState(
          `button #${buttonIndex} on #${index}: ${button.pressed ? "pressed" : "released"} (${button.value.toFixed(2)})`,
          "ok"
        );
      }
    }

    for (let axisIndex = 0; axisIndex < gamepad.axes.length; axisIndex += 1) {
      const currentValue = gamepad.axes[axisIndex];
      const previousValue = previous.axes[axisIndex] ?? 0;
      if (Math.abs(currentValue - previousValue) < AXIS_EPSILON) continue;

      const [lo, hi] = axisToBytes(currentValue);
      setGamepadData(GAMEPAD_EVENT.axis, index, axisIndex, lo, hi);
      setGamepadState(`axis #${axisIndex} on #${index}: ${currentValue.toFixed(2)}`, "ok");
    }

    gamepadSnapshots.set(index, cloneGamepadState(gamepad));
  }

  for (const [index, previous] of gamepadSnapshots.entries()) {
    if (seenIndices.has(index)) continue;

    setGamepadData(
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

}

function setupGamepadBridge() {
  if (!("getGamepads" in navigator)) {
    setGamepadState("Gamepad API not supported", "warn");
    setGamepadPollingState("unavailable", "warn");
    setGamepadLiveDisplay("unavailable", "warn");
    return;
  }

  setGamepadState("waiting", "warn");
  setGamepadPollingState("ready", "warn");
    setGamepadLiveDisplay("pads:0 X:0.00 X2:0.00 Y:0.00 B0:0", "warn");
  window.addEventListener("gamepadconnected", (event) => {
    setGamepadState(`connected #${event.gamepad.index}`, "ok");
  });
  window.addEventListener("gamepaddisconnected", (event) => {
    setGamepadState(`disconnected #${event.gamepad.index}`, "warn");
  });

  if (!gamepadPollLoop) {
    gamepadPollLoop = createAsyncLoop(GAMEPAD_POLL_INTERVAL_MS, () => {
      processGamepads();
    });
    gamepadPollLoop.start();
    setGamepadPollingState(`polling @ ${GAMEPAD_POLL_INTERVAL_MS}ms`, "ok");
  }
}

function refreshPageFocusState() {
  const isVisible = document.visibilityState === "visible";
  const hasFocus = document.hasFocus();
  const focusWarningActive = !isVisible || !hasFocus;

  document.body?.classList.toggle("focus-warning-active", focusWarningActive);

  if (!isVisible) {
    setPageFocusState("hidden", "warn");
    return;
  }

  if (hasFocus) {
    setPageFocusState("focused", "ok");
    return;
  }

  setPageFocusState("visible, unfocused", "warn");
}

function setupPageFocusMonitoring() {
  refreshPageFocusState();
  document.addEventListener("visibilitychange", refreshPageFocusState);
  window.addEventListener("focus", refreshPageFocusState);
  window.addEventListener("blur", refreshPageFocusState);
}

function setupConfig() {
  periodicFrames = loadPeriodicFrames();
  vcu2AiStatusId = loadVcu2AiStatusId();
  slcanBitrateCode = loadSlcanBitrateCode();
  setFrameConfigState(describePeriodicFrames(periodicFrames), periodicFrames.length ? "ok" : "warn");
  setRxConfigState(`VCU2AI_Status ${formatCanId(vcu2AiStatusId)}`, "ok");

  if (!window.CanEncoding) {
    setFrameConfigState("CAN encoding unavailable", "warn");
    setRxConfigState("CAN encoding unavailable", "warn");
  }

  createControlLogicForMode(getSelectedControlMode());
}

function setupControlModeSwitch() {
  const controlModeSelect = $("controlMode");
  if (!controlModeSelect) return;

  controlModeSelect.value = getSelectedControlMode();
  controlModeSelect.addEventListener("change", () => {
    createControlLogicForMode(getSelectedControlMode());
  });
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
  setSerialLoadState("idle", "");
  setAdapterVersion("-", "");
  refreshSerialConsole();
  setSchedulerState("stopped", "warn");
  setTxCount(0);
  setLastFrame("-");
  setLastRxFrame("-", "");
  refreshCanDebugData();
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
  setAppVersion(APP_BUILD_VERSION, "ok");
  void cleanupLegacyPwaArtifacts();
  void registerServiceWorker();
  setupCollapsiblePanels();
  setupPageFocusMonitoring();
  setupControlModeSwitch();
  setupConfig();
  startMissionTimerLoop();
  startSerialLoadMonitorLoop();
  setupSerialBridge();
  setupGamepadBridge();
}

main();



