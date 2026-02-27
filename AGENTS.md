# Gamepad to CAN Bridge Agent Context

Last updated: February 27, 2026

## Project Summary
- This repo is a static browser app (no build step, no framework).
- It is a dedicated gamepad-to-CAN bridge over WebSerial + SLCAN.
- Main files:
  - `index.html`
  - `config.js`
  - `state-machine.js`
  - `app.js`
  - `README.md`

## Current Scope
- Uses WebSerial to connect to an SLCAN serial adapter.
- Uses Gamepad API polling (`navigator.getGamepads()` in `requestAnimationFrame`).
- Runs an asynchronous periodic state machine loop.
- Runs asynchronous periodic CAN transmit loops from config.
- Uses latest gamepad-derived payload as the base CAN payload.
- State-machine development logic now lives in `state-machine.js`.

## Config File
- `config.js` defines `window.APP_CONFIG`.
- Sections:
  - `can.periodicFrames`
  - `stateMachine`

### CAN Config
- `can.periodicFrames` is an array of frame definitions.
- Each frame entry:
  - `id`: 11-bit CAN ID (hex string like `"0x510"` or number)
  - `intervalMs`: transmit period in milliseconds
- Current defaults:
  - `0x510 @ 20ms`
  - `0x512 @ 20ms`
  - `0x513 @ 20ms`
  - `0x514 @ 20ms`

### State Machine Config
- `stateMachine.intervalMs`: periodic tick rate in milliseconds
- `stateMachine.transitionButtonIndex`: gamepad button used for transitions
- `stateMachine.states`: enumeration map
- `stateMachine.sequence`: transition order on rising-edge button press
- Current default states:
  - `AS_INIT = 0`
  - `AS_OFF = 1`
  - `AS_READY = 2`
  - `AS_DRIVING = 3`
  - `AS_FINISHED = 4`
  - `AS_EMERGENCY = 5`
- Current default sequence:
  - `AS_INIT -> AS_OFF -> AS_READY -> AS_DRIVING -> AS_FINISHED -> AS_EMERGENCY -> AS_INIT`

## UI Elements
- TX config/status:
  - `#frameConfig` (loaded frame schedule summary)
  - `#txSchedulerState` (stopped/running)
- State machine status:
  - `#stateMachineConfig`
  - `#stateMachineState`
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
  4. start asynchronous periodic CAN TX loops
- On disconnect:
  - stop asynchronous CAN TX loops
  - send `C`
  - release writer lock
  - close port
- Handles physical disconnect via `navigator.serial` `"disconnect"` event.

## Asynchronous Scheduling
- State machine:
  - driven by an async periodic loop created in `state-machine.js`
  - ticks at `stateMachine.intervalMs`
  - advances one state on each rising-edge button press from the configured button index
- CAN transmission:
  - each configured CAN frame has its own async periodic loop
  - every loop tick sends one SLCAN frame using the latest payload snapshot

## CAN Frame Encoding
- SLCAN 11-bit data frame format:
  - `t{ID3hex}{DLC1hex}{DATA...}\r`
- DLC is 8 bytes for all periodic frames.
- Payload bytes:
  - Byte 0: event type
  - Byte 1: gamepad index
  - Byte 2: control index (`0xFF` for connect/disconnect)
  - Bytes 3-6: event payload
  - Byte 7: current state enum value

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
3. Edit `config.js` for CAN IDs, rates, states, or button index, then reload.
4. Click **Connect SLCAN** and select adapter.
5. Move gamepad controls and verify periodic traffic on all configured CAN IDs.
6. Press the configured transition button and verify `stateMachineState` advances in sequence.
7. Confirm transmitted frame byte 7 matches the displayed state enum.

## Constraints / Notes
- WebSerial requires user gesture and secure context.
- Only standard 11-bit CAN IDs are supported.
- App transmits only; it does not parse incoming SLCAN responses.
