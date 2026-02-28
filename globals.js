// Shared application data.
// These globals are intentionally simple and mutable so all runtime files can
// read/write the same values without encapsulation during early iterations.

window.AppGlobals = {
  // Variables copied from `switch.c`.
  // C fixed-width integer types map to JavaScript Number.
  HANDSHAKE: false,
  GO_SIGNAL: false,
  AS_STATE: 0,
  AMI_STATE: 0,
  GAMEPAD_BUTTON_0_PRESSED: false,
  GAMEPAD_X_AXIS: 0,
  GAMEPAD_Y_AXIS: 0,

  MISSION_STATUS: 0,
  STEER_REQUEST: 0,
  TORQUE_REQUEST: 0,
  SPEED_REQUEST: 0,
  BRAKE_REQUEST: 0,
  DIRECTION_REQUEST: 0,
  ESTOP_REQUEST: 0,

  mission_timer: 0,

  // Values packed into outgoing CAN frames.
  txData: {
    asState: 0x00,
    gamepadEventType: 0x00,
    gamepadIndex: 0x00,
    controlIndex: 0x00,
    data0: 0x00,
    data1: 0x00,
    data2: 0x00,
    data3: 0x00,
  },

  // Values decoded from the incoming VCU2AI status frame (0x520).
  vcu2AiStatusData: {
    matchedId: null,
    lastPayloadBytes: [],
    lastTimestamp: "",
    lastDisplayText: "-",
    HANDSHAKE: false,
    GO_SIGNAL: false,
    AS_STATE: 0x00,
    AMI_STATE: 0x00,
  },

  // Receive statistics for debugging and adapter validation.
  rxFrameStats: {
    totalFrames: 0,
    lastSeenId: null,
    lastSeenTimestamp: "",
    countsById: {},
  },

  // Example control logic outputs driven by switch(AS_STATE).
  controlLogicData: {
    activeCase: "AS_OFF",
    statusText: "Waiting for RX state",
    allowTorque: false,
    readyToDrive: false,
    finishRequested: false,
    emergencyActive: false,
    handshakeValid: false,
    goSignalActive: false,
  },
};
