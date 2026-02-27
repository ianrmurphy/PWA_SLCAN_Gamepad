# Gamepad to CAN Bridge

Static browser app that sends SLCAN CAN frames from HTML5 Gamepad events.

## Features
- WebSerial connection to SLCAN adapters (`115200` serial).
- Shared mutable application data in `globals.js` for straightforward cross-file use.
- Dedicated CAN packing/parsing in `can-encoding.js`.
- Dedicated `switch(AS_STATE)` control logic in `control-logic.js`.
- Configurable SLCAN bitrate (`S0` to `S8`).
- Configurable periodic transmit frames in `config.js`:
  - `id` (11-bit CAN ID)
  - `intervalMs` (period)
- Configurable receive filter in `config.js`:
  - `can.vcu2AiStatusId` (currently `0x520`)
- Current default periodic schedule:
  - `0x510 @ 20ms`
  - `0x512 @ 20ms`
  - `0x513 @ 20ms`
  - `0x514 @ 20ms`
- `VCU2AI_Status_ID` (`0x520`) decoding:
  - `HANDSHAKE = (buf[0] & 0x01)`
  - `GO_SIGNAL = ((buf[1] >> 3) & 0x01)`
  - `AS_STATE = (buf[2] & 0x0F)`
  - `AMI_STATE = ((buf[2] >> 4) & 0x0F)`
- CAN transmit loops run asynchronously.
- Periodic CAN frames use frame-specific AI2VCU encodings for:
  - `0x510` status
  - `0x512` rear drive
  - `0x513` steer
  - `0x514` brake
- Incoming SLCAN frames are monitored asynchronously; matching `can.vcu2AiStatusId`
  payloads are shown in the UI with a local timestamp.
- Incoming `AS_STATE` is consumed by `switch(AS_STATE)` control logic.

## Run
1. Serve the repo over `http://localhost` (or another secure context).
2. Open the page in a Chromium browser.
3. Edit `config.js` if you want different IDs, rates, or `can.vcu2AiStatusId`, then reload.
4. Connect SLCAN device with **Connect SLCAN**.
5. Connect/move gamepad and monitor CAN bus traffic.
6. Send `VCU2AI_Status_ID` (`0x520`) and verify the displayed `AS_STATE` and RX payload update.
