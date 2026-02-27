// Editable transmit schedule.
// `id` accepts hex string (with or without "0x") or number.
// `intervalMs` is the periodic transmit interval in milliseconds.
window.CAN_BRIDGE_CONFIG = {
  periodicFrames: [
    { id: "0x510", intervalMs: 20 },
    { id: "0x512", intervalMs: 20 },
    { id: "0x513", intervalMs: 20 },
    { id: "0x514", intervalMs: 20 },
  ],
};
