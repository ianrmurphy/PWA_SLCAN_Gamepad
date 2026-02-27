// Editable application config.
window.APP_CONFIG = {
  can: {
    // Periodic transmit schedule.
    // `id` accepts hex string (with or without "0x") or number.
    // `intervalMs` is the periodic transmit interval in milliseconds.
    periodicFrames: [
      { id: "0x510", intervalMs: 20 },
      { id: "0x512", intervalMs: 20 },
      { id: "0x513", intervalMs: 20 },
      { id: "0x514", intervalMs: 20 },
    ],
  },

  stateMachine: {
    // State machine tick rate.
    intervalMs: 20,

    // Button index used for state transitions (rising edge).
    transitionButtonIndex: 0,

    // Enumeration.
    states: {
      AS_INIT: 0,
      AS_OFF: 1,
      AS_READY: 2,
      AS_DRIVING: 3,
      AS_FINISHED: 4,
      AS_EMERGENCY: 5,
    },

    // Transition order on each button press.
    sequence: [
      "AS_INIT",
      "AS_OFF",
      "AS_READY",
      "AS_DRIVING",
      "AS_FINISHED",
      "AS_EMERGENCY",
    ],
  },
};
