# Gamepad to CAN Bridge Agent Context

Last updated: February 27, 2026

## Project Summary
- This repo is a static browser app (no build step, no framework).
- It is a dedicated gamepad-to-CAN bridge over WebSerial + SLCAN.
- Main files:
  - `index.html`
  - `can-config.js`
  - `app.js`
  - `README.md`

## Current Scope
- Uses WebSerial to connect to an SLCAN serial adapter.
- Uses Gamepad API polling (`navigator.getGamepads()` in `requestAnimationFrame`).
- Transmits configured CAN IDs periodically (per-frame interval from config).
- Uses latest gamepad-derived payload for periodic transmission.
- No service worker, manifest, install prompt, or template counter/note features remain.

## Config File
- `can-config.js` defines:
  - `window.CAN_BRIDGE_CONFIG.periodicFrames`
- Each frame entry:
  - `id`: 11-bit CAN ID (hex string like `"0x510"` or number)
  - `intervalMs`: transmit period in milliseconds
- Current defaults:
  - `0x510 @ 20ms`
  - `0x512 @ 20ms`
  - `0x513 @ 20ms`
  - `0x514 @ 20ms`

## UI Elements
- TX config/status:
  - `#frameConfig` (loaded frame schedule summary)
  - `#txSchedulerState` (stopped/running)
- SLCAN bitrate:
  - `#slcanBitrate` (`S0`-`S8`, default `S4`)
- Serial control:
  - `#serialConnect`
  - `#serialDisconnect`
- Runtime status:
  - `#serialState`
  - `#gamepadState`
  - `#txCount`
  - `#lastFrame`

## Serial/SLCAN Behavior
- Serial open baud rate: `115200`.
- On connect:
  1. `navigator.serial.requestPort()`
  2. `port.open({ baudRate: 115200 })`
  3. send `S{bitrate}` then `O`
  4. start periodic TX timers for configured frame list
- On disconnect:
  - stop periodic TX timers
  - send `C`
  - release writer lock
  - close port
- Handles physical disconnect via `navigator.serial` `"disconnect"` event.

## Periodic Transmission Model
- Each configured frame ID has its own `setInterval` timer.
- Every tick sends one SLCAN data frame using:
  - configured CAN ID
  - latest gamepad payload bytes (0..6)
  - rolling TX sequence byte (7)
- TX queue:
  - max 512 pending lines
  - drops oldest line if full

## CAN Frame Encoding
- SLCAN 11-bit data frame format:
  - `t{ID3hex}{DLC1hex}{DATA...}\r`
- DLC is 8 bytes for all periodic frames.
- Payload bytes:
  - Byte 0: event type
  - Byte 1: gamepad index
  - Byte 2: control index (`0xFF` for connect/disconnect)
  - Bytes 3-6: event payload
  - Byte 7: rolling TX sequence counter

## Event Type Codes
- `0x01`: gamepad connected
- `0x02`: gamepad disconnected
- `0x10`: button changed
- `0x20`: axis changed

## Event Payload Mapping
- Connect/Disconnect:
  - Byte 3: button count
  - Byte 4: axis count
- Button change:
  - Byte 3: pressed (`0` or `1`)
  - Byte 4: analog value (`0..255`)
- Axis change:
  - Bytes 3-4: axis value as signed int16 little-endian from normalized `[-1, 1]`

## Thresholds and Queueing
- Button analog delta threshold: `BUTTON_EPSILON = 0.02`
- Axis delta threshold: `AXIS_EPSILON = 0.04`
- Serial TX queue max size: `512` lines

## Run and Test
1. Serve over `http://localhost` (or another secure context).
2. Open in Chromium browser (WebSerial + Gamepad support required).
3. Edit `can-config.js` for IDs/rates if needed, then reload.
4. Click **Connect SLCAN** and select adapter.
5. Move gamepad controls and verify periodic traffic on all configured CAN IDs.
6. Confirm `txSchedulerState` is running and `txCount` increments.

## Constraints / Notes
- WebSerial requires user gesture and secure context.
- Only standard 11-bit CAN IDs are supported.
- App transmits only; it does not parse incoming SLCAN responses.
