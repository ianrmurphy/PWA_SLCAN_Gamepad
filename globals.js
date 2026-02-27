// Shared application data.
// These globals are intentionally simple and mutable so app.js,
// state-machine.js, and can-encoding.js can all read/write the same values.

window.AppGlobals = {
  // State machine values that are encoded into outgoing CAN frames.
  stateMachineData: {
    stateName: "AS_INIT",
    stateValue: 0x00,
  },

  // Latest gamepad-derived values that are encoded into outgoing CAN frames.
  gamepadData: {
    eventType: 0x00,
    gamepadIndex: 0x00,
    controlIndex: 0x00,
    data0: 0x00,
    data1: 0x00,
    data2: 0x00,
    data3: 0x00,
  },

  // Example received data that can be consumed by the state machine.
  receivedData: {
    matchedId: null,
    lastPayloadBytes: [],
    lastTimestamp: "",
    lastDisplayText: "-",
    exampleRemoteAdvanceRequest: 0x00,
    exampleRemoteModeRequest: 0x00,
    exampleRemoteSetpoint: 0x0000,
    exampleRemoteFlags: 0x00,
  },
};
