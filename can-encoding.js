// Shared variables used by CAN packing/parsing.
// These are intentionally global and mutable for clarity.
const appGlobals = window.AppGlobals;
const txData = appGlobals.txData;
const vcu2AiStatusData = appGlobals.vcu2AiStatusData;
const controlLogicData = appGlobals.controlLogicData;

const AI2VCU_STATUS_ID = 0x510;
const AI2VCU_DRIVE_R_ID = 0x512;
const AI2VCU_STEER_ID = 0x513;
const AI2VCU_BRAKE_ID = 0x514;
const VCU2AI_STATUS_ID = 0x520;

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
  txData.gamepadEventType = clampCanByte(eventType);
  txData.gamepadIndex = clampCanByte(padIndex);
  txData.controlIndex = clampCanByte(controlIndex);
  txData.data0 = clampCanByte(d0);
  txData.data1 = clampCanByte(d1);
  txData.data2 = clampCanByte(d2);
  txData.data3 = clampCanByte(d3);
}

function clampUint16(value) {
  const intValue = Math.round(Number(value) || 0);
  if (intValue < 0) return 0;
  if (intValue > 0xffff) return 0xffff;
  return intValue;
}

function clampInt16(value) {
  const intValue = Math.round(Number(value) || 0);
  if (intValue < -0x8000) return -0x8000;
  if (intValue > 0x7fff) return 0x7fff;
  return intValue;
}

function encodeUint16Le(value) {
  const clamped = clampUint16(value);
  return [clamped & 0xff, (clamped >> 8) & 0xff];
}

function encodeInt16Le(value) {
  const clamped = clampInt16(value);
  const twosComplement = clamped < 0 ? 0x10000 + clamped : clamped;
  return [twosComplement & 0xff, (twosComplement >> 8) & 0xff];
}

function buildGenericPayloadBytes() {
  return [
    txData.gamepadEventType,
    txData.gamepadIndex,
    txData.controlIndex,
    txData.data0,
    txData.data1,
    txData.data2,
    txData.data3,
    clampCanByte(txData.asState),
  ];
}

function buildStatusPayloadBytes() {
  const payload = new Array(8).fill(0x00);
  payload[0] = clampCanByte(appGlobals.HANDSHAKE ? 1 : 0);
  payload[1] =
    clampCanByte(appGlobals.ESTOP_REQUEST & 0x01) +
    clampCanByte((appGlobals.MISSION_STATUS & 0x03) << 4) +
    clampCanByte((appGlobals.DIRECTION_REQUEST & 0x03) << 6);
  return payload;
}

function buildDriveRearPayloadBytes() {
  const payload = new Array(8).fill(0x00);
  const [torqueLo, torqueHi] = encodeUint16Le(appGlobals.TORQUE_REQUEST);
  const [speedLo, speedHi] = encodeUint16Le(appGlobals.SPEED_REQUEST);
  payload[0] = torqueLo;
  payload[1] = torqueHi;
  payload[2] = speedLo;
  payload[3] = speedHi;
  return payload;
}

function buildSteerPayloadBytes() {
  const payload = new Array(8).fill(0x00);
  const [steerLo, steerHi] = encodeInt16Le(appGlobals.STEER_REQUEST);
  payload[0] = steerLo;
  payload[1] = steerHi;
  return payload;
}

function buildBrakePayloadBytes() {
  const payload = new Array(8).fill(0x00);
  const [brakeLo] = encodeUint16Le(appGlobals.BRAKE_REQUEST);
  payload[0] = brakeLo;
  // Matches the provided C snippet exactly: byte 1 repeats the low byte.
  payload[1] = brakeLo;
  return payload;
}

function buildOutgoingPayloadBytes(canId) {
  switch (canId) {
    case AI2VCU_STATUS_ID:
      return buildStatusPayloadBytes();
    case AI2VCU_DRIVE_R_ID:
      return buildDriveRearPayloadBytes();
    case AI2VCU_STEER_ID:
      return buildSteerPayloadBytes();
    case AI2VCU_BRAKE_ID:
      return buildBrakePayloadBytes();
    default:
      return buildGenericPayloadBytes();
  }
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
  return encodeSlcanDataFrame(canId, buildOutgoingPayloadBytes(canId));
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

function decodeVcu2AiStatusFields(data) {
  const buf = Array.isArray(data) ? data : [];

  appGlobals.HANDSHAKE = !!((buf[0] ?? 0x00) & 0x01);
  appGlobals.GO_SIGNAL = !!(((buf[1] ?? 0x00) >> 3) & 0x01);
  appGlobals.AS_STATE = (buf[2] ?? 0x00) & 0x0f;
  appGlobals.AMI_STATE = ((buf[2] ?? 0x00) >> 4) & 0x0f;

  // Keep the grouped RX object in sync with the explicit globals.
  vcu2AiStatusData.HANDSHAKE = appGlobals.HANDSHAKE;
  vcu2AiStatusData.GO_SIGNAL = appGlobals.GO_SIGNAL;
  vcu2AiStatusData.AS_STATE = appGlobals.AS_STATE;
  vcu2AiStatusData.AMI_STATE = appGlobals.AMI_STATE;

  // State is now sourced from CAN and forwarded into TX byte 7.
  txData.asState = appGlobals.AS_STATE;

  // Example control visibility fields.
  controlLogicData.handshakeValid = appGlobals.HANDSHAKE;
  controlLogicData.goSignalActive = appGlobals.GO_SIGNAL;
}

function applyReceivedFrame(frame) {
  if (!frame) return;

  vcu2AiStatusData.matchedId = frame.id;
  vcu2AiStatusData.lastPayloadBytes = frame.data.slice();
  vcu2AiStatusData.lastTimestamp = formatTimestampForEncoding();
  vcu2AiStatusData.lastDisplayText = `${vcu2AiStatusData.lastTimestamp} ${formatPayloadBytes(frame.data)}`;

  decodeVcu2AiStatusFields(frame.data);
}

function tryConsumeIncomingLine(line, expectedId) {
  const frame = parseIncomingSlcanFrame(line);
  if (!frame || frame.id !== expectedId) return null;

  applyReceivedFrame(frame);
  return frame;
}

window.CanEncoding = {
  AI2VCU_BRAKE_ID,
  AI2VCU_DRIVE_R_ID,
  AI2VCU_STATUS_ID,
  AI2VCU_STEER_ID,
  VCU2AI_STATUS_ID,
  applyReceivedFrame,
  buildOutgoingPayloadBytes,
  clampByte: clampCanByte,
  decodeVcu2AiStatusFields,
  encodeSlcanDataFrame,
  formatPayloadBytes,
  packPeriodicTxFrame,
  parseCanIdValue: parseCanIdValueForEncoding,
  parseIncomingSlcanFrame,
  tryConsumeIncomingLine,
  updateGamepadData,
};
