# Gamepad to CAN Bridge Agent Context

Last updated: February 27, 2026

## Project Summary
- This repo is a static browser app (no build step, no framework).
- It is now a dedicated gamepad-to-CAN bridge, not a generic PWA demo.
- Main files:
  - `index.html`
  - `app.js`
  - `README.md`

## Current Scope
- Uses WebSerial to connect to an SLCAN serial adapter.
- Uses Gamepad API polling (`navigator.getGamepads()` in `requestAnimationFrame`).
- Emits one CAN frame for each gamepad event/change above thresholds.
- No service worker, manifest, install prompt, or template counter/note features remain.

## UI Elements
- CAN configuration:
  - `#canId` (hex, `000`-`7FF`)
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
- On disconnect:
  - send `C`
  - release writer lock
  - close port
- Handles physical disconnect via `navigator.serial` `"disconnect"` event.

## CAN Frame Encoding
- Uses SLCAN standard 11-bit data frame format:
  - `t{ID3hex}{DLC1hex}{DATA...}\r`
- DLC is 8 bytes for all emitted events.
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
- Serial TX queue max size: `512` lines (drops oldest when full)

## Run and Test
1. Serve over `http://localhost` (or another secure context).
2. Open in Chromium browser (WebSerial + Gamepad support required).
3. Click **Connect SLCAN** and select adapter.
4. Move gamepad controls and verify CAN traffic on bus monitor.
5. Confirm `txCount` increments and `lastFrame` updates.

## Constraints / Notes
- WebSerial requires user gesture and secure context.
- Only standard 11-bit CAN IDs are currently supported.
- App transmits only; it does not parse incoming SLCAN responses.
