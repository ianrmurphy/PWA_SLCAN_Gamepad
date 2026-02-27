# Gamepad to CAN Bridge

Static browser app that sends SLCAN CAN frames from HTML5 Gamepad events.

## Features
- WebSerial connection to SLCAN adapters (`115200` serial).
- Configurable SLCAN bitrate (`S0` to `S8`).
- Configurable periodic transmit frames in `can-config.js`:
  - `id` (11-bit CAN ID)
  - `intervalMs` (period)
- Current default periodic schedule:
  - `0x510 @ 20ms`
  - `0x512 @ 20ms`
  - `0x513 @ 20ms`
  - `0x514 @ 20ms`
- Gamepad payload is retained and sent on all configured periodic frames.

## Run
1. Serve the repo over `http://localhost` (or another secure context).
2. Open the page in a Chromium browser.
3. Edit `can-config.js` if you want different IDs/rates, then reload.
4. Connect SLCAN device with **Connect SLCAN**.
5. Connect/move gamepad and monitor CAN bus traffic.
