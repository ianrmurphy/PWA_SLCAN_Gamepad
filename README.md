# Gamepad to CAN Bridge

Static browser app that sends SLCAN CAN frames from HTML5 Gamepad events.

## Features
- WebSerial connection to SLCAN adapters (`115200` serial).
- Configurable SLCAN bitrate (`S0` to `S8`).
- Configurable periodic transmit frames in `config.js`:
  - `id` (11-bit CAN ID)
  - `intervalMs` (period)
- Configurable asynchronous state machine in `config.js`:
  - `intervalMs` (state machine tick rate)
  - `transitionButtonIndex`
  - state enumeration and sequence
- Current default periodic schedule:
  - `0x510 @ 20ms`
  - `0x512 @ 20ms`
  - `0x513 @ 20ms`
  - `0x514 @ 20ms`
- Current default state sequence:
  - `AS_INIT`
  - `AS_OFF`
  - `AS_READY`
  - `AS_DRIVING`
  - `AS_FINISHED`
  - `AS_EMERGENCY`
- The state machine advances one step on each rising-edge button press.
- CAN transmit loops and the state machine loop both run asynchronously.
- Periodic CAN frames send:
  - gamepad payload in bytes `0..6`
  - current state enum in byte `7`

## Run
1. Serve the repo over `http://localhost` (or another secure context).
2. Open the page in a Chromium browser.
3. Edit `config.js` if you want different IDs, rates, or state-machine settings, then reload.
4. Connect SLCAN device with **Connect SLCAN**.
5. Connect/move gamepad and monitor CAN bus traffic.
6. Press the configured gamepad button to step through states in sequence.
