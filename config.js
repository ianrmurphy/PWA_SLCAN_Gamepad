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

    // Receive filter ID.
    // VCU2AI_Status_ID (0x520) carries HANDSHAKE, GO_SIGNAL, AS_STATE, and AMI_STATE.
    vcu2AiStatusId: "0x520",
  },
};
