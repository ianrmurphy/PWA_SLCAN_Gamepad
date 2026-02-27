# Gamepad to CAN Bridge Agent Context

Last updated: February 27, 2026

## Project Summary
- This repo is a static browser app (no build step, no framework).
- It is a dedicated gamepad-to-CAN bridge over WebSerial + SLCAN.
- The app currently:
  - polls the HTML5 Gamepad API,
  - runs a periodic state machine,
  - transmits 4 periodic CAN frames over SLCAN,
  - monitors one configured incoming CAN ID and displays the payload.

## Main Files
- `index.html`
  - Presentation only.
  - Defines controls and status fields.
  - Loads scripts in this order:
    1. `config.js`
    2. `globals.js`
    3. `can-encoding.js`
    4. `state-machine.js`
    5. `app.js`
- `config.js`
  - Editable runtime configuration (`window.APP_CONFIG`).
  - Holds CAN TX schedule, CAN RX filter, and state-machine settings.
- `globals.js`
  - Shared mutable application data (`window.AppGlobals`).
  - Makes the main cross-file data dependencies explicit.
- `can-encoding.js`
  - Dedicated CAN packing/parsing layer.
  - Owns the shared data variables that are packed into outgoing CAN frames.
  - Packs outgoing SLCAN data frames from globals.
  - Parses incoming SLCAN data frames into globals.
- `state-machine.js`
  - Dedicated state-machine module.
  - Parses state-machine config.
  - Owns state enum/sequence handling.
  - Runs the async state-machine loop.
  - Consumes example received globals.
  - Exposes `window.AppStateMachine.create(...)`.
- `app.js`
  - Main orchestration/runtime.
  - Owns WebSerial TX/RX, serial queueing, gamepad polling, CAN TX scheduling, and UI updates.
- `README.md`
  - High-level usage notes.

## Shared Global Data
- `globals.js` defines `window.AppGlobals`.
- Top-level sections:
  - `stateMachineData`
  - `gamepadData`
  - `receivedData`

### stateMachineData
- Values written by `state-machine.js`.
- Values packed into outgoing CAN frames by `can-encoding.js`.
- Current fields:
  - `stateName`
  - `stateValue`

### gamepadData
- Values written by `app.js` through `window.CanEncoding.updateGamepadData(...)`.
- Values packed into outgoing CAN frames by `can-encoding.js`.
- Current fields:
  - `eventType`
  - `gamepadIndex`
  - `controlIndex`
  - `data0`
  - `data1`
  - `data2`
  - `data3`

### receivedData
- Values written by `can-encoding.js` when a matching RX frame is parsed.
- Values read by `state-machine.js`.
- Current fields:
  - `matchedId`
  - `lastPayloadBytes`
  - `lastTimestamp`
  - `lastDisplayText`
  - `exampleRemoteAdvanceRequest`
  - `exampleRemoteModeRequest`
  - `exampleRemoteSetpoint`
  - `exampleRemoteFlags`

## Config File
- `config.js` defines `window.APP_CONFIG`.
- Top-level sections:
  - `can`
  - `stateMachine`

### CAN Config
- `can.periodicFrames`
  - Array of periodic transmit frame definitions.
  - Each frame entry:
    - `id`: 11-bit CAN ID (hex string like `"0x510"` or number)
    - `intervalMs`: transmit period in milliseconds
- `can.receiveId`
  - 11-bit CAN ID to monitor on the receive path.
  - Matching incoming frames are surfaced in the UI and decoded into `receivedData`.

### Current CAN Defaults
- TX:
  - `0x510 @ 20ms`
  - `0x512 @ 20ms`
  - `0x513 @ 20ms`
  - `0x514 @ 20ms`
- RX filter:
  - `0x520`

### State Machine Config
- `stateMachine.intervalMs`
  - Periodic tick rate in milliseconds.
- `stateMachine.transitionButtonIndex`
  - Gamepad button used for transitions.
- `stateMachine.states`
  - Enumeration map.
- `stateMachine.sequence`
  - Transition order on rising-edge button press.

### Current State Defaults
- Enumeration:
  - `AS_INIT = 0`
  - `AS_OFF = 1`
  - `AS_READY = 2`
  - `AS_DRIVING = 3`
  - `AS_FINISHED = 4`
  - `AS_EMERGENCY = 5`
- Sequence:
  - `AS_INIT -> AS_OFF -> AS_READY -> AS_DRIVING -> AS_FINISHED -> AS_EMERGENCY -> AS_INIT`
- Current transition trigger:
  - button index `0`
- Current default state-machine tick:
  - `20ms`

## UI Elements
- Config/status:
  - `#frameConfig`: loaded TX schedule summary
  - `#rxConfig`: loaded RX filter ID
  - `#stateMachineConfig`: loaded state-machine config summary
  - `#stateMachineState`: current state label and enum
- Controls:
  - `#slcanBitrate`: SLCAN bitrate selector (`S0`-`S8`, default `S4`)
  - `#serialConnect`
  - `#serialDisconnect`
- Runtime status:
  - `#serialState`
  - `#gamepadState`
  - `#txSchedulerState`
  - `#txCount`
  - `#lastFrame`
  - `#lastRxFrame`

## Serial / SLCAN Behavior
- Serial open baud rate: `115200`.
- On connect:
  1. `navigator.serial.requestPort()`
  2. `port.open({ baudRate: 115200 })`
  3. acquire writer
  4. start async serial read loop
  5. send `S{bitrate}`
  6. send `O`
  7. start periodic CAN TX loops
- On disconnect:
  - stop periodic CAN TX loops
  - cancel serial reader
  - wait for read loop shutdown
  - send `C` (unless disconnect was triggered by read failure/device loss)
  - release writer lock
  - close port
- Physical USB disconnect:
  - handled via `navigator.serial` `"disconnect"` event

## Asynchronous Scheduling
- State machine:
  - implemented in `state-machine.js`
  - created via `window.AppStateMachine.create(...)`
  - runs in its own async loop
  - ticks at `stateMachine.intervalMs`
  - advances on:
    - rising-edge gamepad press of the configured button
    - rising-edge `receivedData.exampleRemoteAdvanceRequest`
- CAN transmission:
  - each configured CAN ID has its own async loop
  - every loop tick sends one SLCAN frame packed by `can-encoding.js`
- Serial reception:
  - read loop runs independently from TX and state-machine loops
  - incoming data is buffered and split on `CR`/`LF`

## CAN Transmit Payload
- `can-encoding.js` packs outgoing frames from globals.
- Uses SLCAN 11-bit data frame format:
  - `t{ID3hex}{DLC1hex}{DATA...}\r`
- DLC is always `8` for current periodic TX frames.
- Payload bytes:
  - Byte 0: `gamepadData.eventType`
  - Byte 1: `gamepadData.gamepadIndex`
  - Byte 2: `gamepadData.controlIndex`
  - Byte 3: `gamepadData.data0`
  - Byte 4: `gamepadData.data1`
  - Byte 5: `gamepadData.data2`
  - Byte 6: `gamepadData.data3`
  - Byte 7: `stateMachineData.stateValue`

## Event Type Codes
- `0x01`: gamepad connected
- `0x02`: gamepad disconnected
- `0x10`: button changed
- `0x20`: axis changed

## Example RX Decode
- `can-encoding.js` currently decodes matching RX payloads into example fields:
  - Byte 0 -> `receivedData.exampleRemoteAdvanceRequest`
  - Byte 1 -> `receivedData.exampleRemoteModeRequest`
  - Bytes 2-3 -> `receivedData.exampleRemoteSetpoint` (little-endian uint16)
  - Byte 4 -> `receivedData.exampleRemoteFlags`
- These are example/dummy fields intended to make future control logic work clearer.

## CAN Receive Behavior
- Incoming SLCAN receive parsing currently supports standard data frames only:
  - `t{ID3hex}{DLC}{DATA...}`
- Only frames whose ID matches `can.receiveId` are surfaced.
- Matching frames:
  - update `receivedData`
  - update `#lastRxFrame` using `receivedData.lastDisplayText`
- `#lastRxFrame` format:
  - local timestamp `HH:MM:SS.mmm`
  - payload bytes shown as uppercase hex separated by spaces

## Gamepad Processing
- Polling uses `requestAnimationFrame`.
- Per-gamepad snapshots are stored in a `Map`.
- The latest detected gamepad event updates `gamepadData`.
- Thresholds:
  - `BUTTON_EPSILON = 0.02`
  - `AXIS_EPSILON = 0.04`

## Queueing / Limits
- Serial TX queue max size: `512` lines.
- If the TX queue is full, the oldest queued line is dropped.

## Run and Test
1. Serve over `http://localhost` (or another secure context).
2. Open in a Chromium browser with WebSerial + Gamepad support.
3. Edit `config.js` for CAN IDs, rates, RX filter, states, or button index, then reload.
4. Click `Connect SLCAN` and select the adapter.
5. Verify periodic TX on `0x510`, `0x512`, `0x513`, and `0x514`.
6. Press the configured transition button and verify `#stateMachineState` steps through the configured sequence.
7. Verify transmitted byte 7 matches the displayed state enum.
8. Send an incoming frame with ID `0x520` and verify:
  - `#lastRxFrame` updates with timestamp + payload
  - `receivedData.exampleRemoteAdvanceRequest` can trigger the state machine when byte 0 changes from `0` to non-zero

## Constraints / Notes
- WebSerial requires secure context and user gesture.
- Only standard 11-bit CAN IDs are supported in current TX/RX parsing.
- Globals are intentionally used directly in this iteration:
  - clarity is preferred over encapsulation for now
  - future refactors can formalize data ownership later
