# Gamepad to CAN Bridge

Static browser app that sends SLCAN CAN frames from HTML5 Gamepad events.

## Features
- WebSerial connection to SLCAN adapters (`115200` serial).
- Configurable SLCAN bitrate (`S0` to `S8`).
- Configurable 11-bit CAN ID (`000` to `7FF`, hex).
- Sends frames for:
  - gamepad connect/disconnect
  - button state/value changes
  - axis value changes

## Run
1. Serve the repo over `http://localhost` (or another secure context).
2. Open the page in a Chromium browser.
3. Connect SLCAN device with **Connect SLCAN**.
4. Connect/move gamepad and monitor CAN bus traffic.
