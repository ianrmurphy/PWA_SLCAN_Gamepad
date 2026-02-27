// CAN-encoded data variables.
// These shared globals are the source of truth for values packed into
// outgoing frames and for example data decoded from incoming frames.
const stateMachineData = window.AppGlobals.stateMachineData;
const gamepadData = window.AppGlobals.gamepadData;
const receivedData = window.AppGlobals.receivedData;

function clampCanByte(value) {
  const intValue = Number(value);
  if (!Number.isFinite(intValue)) return 0;
  if (intValue < 0) return 0;
  if (intValue > 255) return 255;
  return intValue | 0;
}

function parseCanIdValueForEncoding(value) {
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

function formatTimestampForEncoding(date = new Date()) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function formatPayloadBytes(data) {
  if (!Array.isArray(data) || !data.length) return "(empty)";

  return data
    .map((byte) => clampCanByte(byte).toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
}

function updateGamepadData(eventType, padIndex, controlIndex, d0 = 0, d1 = 0, d2 = 0, d3 = 0) {
  gamepadData.eventType = clampCanByte(eventType);
  gamepadData.gamepadIndex = clampCanByte(padIndex);
  gamepadData.controlIndex = clampCanByte(controlIndex);
  gamepadData.data0 = clampCanByte(d0);
  gamepadData.data1 = clampCanByte(d1);
  gamepadData.data2 = clampCanByte(d2);
  gamepadData.data3 = clampCanByte(d3);
}

function buildOutgoingPayloadBytes() {
  return [
    gamepadData.eventType,
    gamepadData.gamepadIndex,
    gamepadData.controlIndex,
    gamepadData.data0,
    gamepadData.data1,
    gamepadData.data2,
    gamepadData.data3,
    clampCanByte(stateMachineData.stateValue),
  ];
}

function encodeSlcanDataFrame(canId, data) {
  const idHex = canId.toString(16).toUpperCase().padStart(3, "0");
  const dlc = Math.min(8, data.length);
  const dataHex = data
    .slice(0, dlc)
    .map((byte) => clampCanByte(byte).toString(16).toUpperCase().padStart(2, "0"))
    .join("");

  return `t${idHex}${dlc.toString(16).toUpperCase()}${dataHex}`;
}

function packPeriodicTxFrame(canId) {
  return encodeSlcanDataFrame(canId, buildOutgoingPayloadBytes());
}

function parseIncomingSlcanFrame(line) {
  if (typeof line !== "string" || line.length < 5) return null;
  if (line[0] !== "t") return null;

  const canId = parseCanIdValueForEncoding(line.slice(1, 4));
  if (canId === null) return null;

  const dlc = Number.parseInt(line[4], 16);
  if (Number.isNaN(dlc) || dlc < 0 || dlc > 8) return null;

  const expectedLength = 5 + dlc * 2;
  if (line.length < expectedLength) return null;

  const data = [];
  for (let index = 0; index < dlc; index += 1) {
    const offset = 5 + index * 2;
    const value = Number.parseInt(line.slice(offset, offset + 2), 16);
    if (Number.isNaN(value)) return null;
    data.push(value);
  }

  return {
    id: canId,
    data,
  };
}

function applyReceivedFrame(frame) {
  if (!frame) return;

  receivedData.matchedId = frame.id;
  receivedData.lastPayloadBytes = frame.data.slice();
  receivedData.lastTimestamp = formatTimestampForEncoding();

  // Example decoded fields to be consumed elsewhere.
  receivedData.exampleRemoteAdvanceRequest = frame.data[0] ?? 0x00;
  receivedData.exampleRemoteModeRequest = frame.data[1] ?? 0x00;
  receivedData.exampleRemoteSetpoint = (frame.data[2] ?? 0x00) | ((frame.data[3] ?? 0x00) << 8);
  receivedData.exampleRemoteFlags = frame.data[4] ?? 0x00;

  receivedData.lastDisplayText = `${receivedData.lastTimestamp} ${formatPayloadBytes(frame.data)}`;
}

function tryConsumeIncomingLine(line, expectedId) {
  const frame = parseIncomingSlcanFrame(line);
  if (!frame || frame.id !== expectedId) return null;

  applyReceivedFrame(frame);
  return frame;
}

window.CanEncoding = {
  applyReceivedFrame,
  buildOutgoingPayloadBytes,
  clampByte: clampCanByte,
  encodeSlcanDataFrame,
  formatPayloadBytes,
  packPeriodicTxFrame,
  parseCanIdValue: parseCanIdValueForEncoding,
  parseIncomingSlcanFrame,
  tryConsumeIncomingLine,
  updateGamepadData,
};
