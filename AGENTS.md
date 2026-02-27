# Gamepad to CAN Bridge Agent Context

Last updated: February 27, 2026

## Project Summary
- This repo is a static browser app with no build step and no framework.
- It is a dedicated gamepad-to-CAN bridge using:
  - HTML5 Gamepad API
  - WebSerial
  - SLCAN
- The app is installable again as a minimal PWA and supports offline shell caching.
- Runtime behavior:
  - polls the gamepad continuously
  - transmits 4 periodic CAN frames
  - receives and decodes one CAN status frame
  - runs control logic from `switch (AS_STATE)`
  - exposes a live debug view of RX/TX globals and packed payloads

## Main Files
- `index.html`
  - Main UI shell.
  - Links `manifest.webmanifest`.
  - Loads scripts in this order:
    1. `config.js`
    2. `globals.js`
    3. `can-encoding.js`
    4. `control-logic.js`
    5. `app.js`
- `config.js`
  - Editable runtime config in `window.APP_CONFIG`.
- `globals.js`
  - Shared mutable runtime state in `window.AppGlobals`.
- `can-encoding.js`
  - CAN packing/parsing layer.
  - Owns frame ID constants and SLCAN encode/decode helpers.
- `control-logic.js`
  - `switch (AS_STATE)` control logic.
  - Consumes globals and writes request globals.
- `app.js`
  - Main runtime orchestration.
  - Owns WebSerial, serial read/write loops, gamepad polling, timer loops, UI updates, PWA service worker registration.
- `manifest.webmanifest`
  - PWA manifest for installability.
- `sw.js`
  - Offline shell service worker.
- `icons/icon-192.svg`
- `icons/icon-512.svg`
- `README.md`
  - High-level usage notes.

## Config
- `config.js` defines `window.APP_CONFIG.can`.

### CAN Config Keys
- `periodicFrames`
  - Array of periodic transmit frame definitions.
  - Each frame uses:
    - `id`
    - `intervalMs`
- `vcu2AiStatusId`
  - Receive filter ID for the VCU status frame.
  - Canonical key is `can.vcu2AiStatusId`.
  - `app.js` still accepts legacy `can.receiveId` as a fallback for compatibility.

### Current Defaults
- TX:
  - `0x510 @ 20ms`
  - `0x512 @ 20ms`
  - `0x513 @ 20ms`
  - `0x514 @ 20ms`
- RX:
  - `VCU2AI_Status_ID = 0x520`

## Shared Global Data
- `globals.js` defines `window.AppGlobals`.
- Globals are intentionally direct and mutable for clarity during iteration.

### Core RX / State Globals
- `HANDSHAKE`
- `GO_SIGNAL`
- `AS_STATE`
- `AMI_STATE`

### Gamepad Input Globals
- `GAMEPAD_BUTTON_0_PRESSED`
- `GAMEPAD_X_AXIS`
- `GAMEPAD_Y_AXIS`

### Control Output Globals
- `MISSION_STATUS`
- `STEER_REQUEST`
- `TORQUE_REQUEST`
- `SPEED_REQUEST`
- `BRAKE_REQUEST`
- `DIRECTION_REQUEST`
- `ESTOP_REQUEST`
- `mission_timer`

### Grouped Data Objects
- `txData`
  - Stores the latest raw gamepad event payload fields.
  - Fields:
    - `asState`
    - `gamepadEventType`
    - `gamepadIndex`
    - `controlIndex`
    - `data0`
    - `data1`
    - `data2`
    - `data3`
- `vcu2AiStatusData`
  - Stores decoded RX metadata and mirrored status values.
  - Fields:
    - `matchedId`
    - `lastPayloadBytes`
    - `lastTimestamp`
    - `lastDisplayText`
    - `HANDSHAKE`
    - `GO_SIGNAL`
    - `AS_STATE`
    - `AMI_STATE`
- `controlLogicData`
  - Stores derived control-logic state for UI/debugging.
  - Fields:
    - `activeCase`
    - `statusText`
    - `allowTorque`
    - `readyToDrive`
    - `finishRequested`
    - `emergencyActive`
    - `handshakeValid`
    - `goSignalActive`

## CAN Protocol Context

### Frame IDs
- `AI2VCU_Status_ID = 0x510`
- `AI2VCU_Drive_R_ID = 0x512`
- `AI2VCU_Steer_ID = 0x513`
- `AI2VCU_Brake_ID = 0x514`
- `VCU2AI_Status_ID = 0x520`

### SLCAN Format
- TX uses standard 11-bit SLCAN data frames:
  - `t{ID3hex}{DLC1hex}{DATA...}\r`
- RX parsing currently supports only standard `t` frames.
- Only 11-bit CAN IDs are supported.

### TX Encoding
- `can-encoding.js` packs outgoing frames by CAN ID.
- Current configured frames use frame-specific encodings:

#### `0x510` Status
- Byte 0:
  - `HANDSHAKE & 0x01`
- Byte 1:
  - bit 0: `ESTOP_REQUEST & 0x01`
  - bits 4-5: `MISSION_STATUS & 0x03`
  - bits 6-7: `DIRECTION_REQUEST & 0x03`
- Bytes 2-7:
  - `0`

#### `0x512` Drive Rear
- Bytes 0-1:
  - `TORQUE_REQUEST` as little-endian unsigned 16-bit
- Bytes 2-3:
  - `SPEED_REQUEST` as little-endian unsigned 16-bit
- Bytes 4-7:
  - `0`

#### `0x513` Steer
- Bytes 0-1:
  - `STEER_REQUEST` as little-endian signed 16-bit
- Bytes 2-7:
  - `0`

#### `0x514` Brake
- Byte 0:
  - low byte of `BRAKE_REQUEST`
- Byte 1:
  - low byte of `BRAKE_REQUEST` again
- This repeated low byte is intentional and matches the embedded-side expectation.
- Bytes 2-7:
  - `0`

### Generic TX Fallback
- For unknown CAN IDs, `can-encoding.js` still supports the older generic payload:
  - bytes `0..6` from `txData`
  - byte `7` from `txData.asState`
- This fallback is not used by the current default periodic frame list.

### RX Decode (`VCU2AI_Status_ID = 0x520`)
- `HANDSHAKE = (buf[0] & 0x01)`
- `GO_SIGNAL = ((buf[1] >> 3) & 0x01)`
- `AS_STATE = (buf[2] & 0x0F)`
- `AMI_STATE = ((buf[2] >> 4) & 0x0F)`
- Decoded values are written to both:
  - top-level globals
  - `vcu2AiStatusData`
- `txData.asState` is updated from decoded `AS_STATE`.

## Control Logic
- `control-logic.js` is the authoritative control implementation.
- It evaluates from globals and writes the request globals directly.

### High-Level Cases
- `AS_STATE = 0`
  - `AS_INIT`
- `AS_STATE = 1`
  - `AS_OFF`
- `AS_STATE = 2`
  - `AS_READY`
- `AS_STATE = 3`
  - `AS_DRIVING`
- Any other value
  - `AS_UNKNOWN_<value>`

### `AS_INIT` / `AS_OFF` / `AS_READY`
- `MISSION_STATUS = 1` when `AMI_STATE != 0`, else `0`
- Zeroes:
  - `STEER_REQUEST`
  - `TORQUE_REQUEST`
  - `SPEED_REQUEST`
  - `BRAKE_REQUEST`
  - `DIRECTION_REQUEST`
  - `ESTOP_REQUEST`
- Resets `mission_timer = 0`

### `AS_DRIVING`
- Branches by `AMI_STATE`.

#### Default `AMI_STATE`
- Manual driving mode.
- `MISSION_STATUS = 3` while gamepad button 0 is pressed, else `1`.
- `STEER_REQUEST` from raw gamepad X axis:
  - raw gamepad convention is:
    - positive X = right
  - control logic intentionally inverts sign:
    - `GAMEPAD_X_AXIS >= 0.2` -> `STEER_REQUEST = -300`
    - `GAMEPAD_X_AXIS <= -0.2` -> `STEER_REQUEST = 300`
    - otherwise `0`
- `SPEED_REQUEST` from raw gamepad Y axis:
  - raw gamepad convention is:
    - positive Y = down
  - up command:
    - `GAMEPAD_Y_AXIS < -0.2` -> `SPEED_REQUEST = 500`
    - otherwise `0`
- `BRAKE_REQUEST` from raw gamepad Y axis:
  - down command:
    - `GAMEPAD_Y_AXIS > 0.2` -> `BRAKE_REQUEST = 100`
    - otherwise `0`
- Fixed values:
  - `TORQUE_REQUEST = 1950`
  - `DIRECTION_REQUEST = 1`
  - `ESTOP_REQUEST = 0`

#### `AMI_STATE = 5` (`Static A`)
- Time-driven sequence based on `mission_timer`.
- `MISSION_STATUS = 3` after `mission_timer >= 9000`.

#### `AMI_STATE = 6` (`Static B`)
- Time-driven sequence based on `mission_timer`.
- Ends with `ESTOP_REQUEST = 1`.

#### `AMI_STATE = 7` (`Dynamic`)
- Time-driven sequence based on `mission_timer`.
- Ends with `ESTOP_REQUEST = 1`.

### `mission_timer`
- `mission_timer` is in milliseconds.
- It advances in `10 ms` steps.
- It only increments while `AS_STATE === 3`.
- It is reset outside the driving state branches that explicitly zero it.

## Asynchronous Scheduling
- Gamepad polling:
  - uses `requestAnimationFrame`
- Periodic CAN transmit:
  - one async loop per configured frame
- Serial receive:
  - dedicated async read loop
  - buffered and split on `CR` / `LF`
- Mission timer:
  - dedicated async loop every `10 ms`
  - re-runs control logic on each tick

## Gamepad Processing
- The app stores per-pad snapshots in a `Map`.
- It emits raw gamepad event data into `txData` when:
  - a pad connects
  - a pad disconnects
  - a button changes
  - an axis changes
- Thresholds:
  - `BUTTON_EPSILON = 0.02`
  - `AXIS_EPSILON = 0.04`
- The lowest-index connected pad is treated as the primary pad for manual control globals.

## UI Elements

### Status / Config
- `#frameConfig`
- `#rxConfig`
- `#logicConfig`
- `#asStateDisplay`
- `#serialState`
- `#gamepadState`
- `#txSchedulerState`
- `#txCount`
- `#lastFrame`
- `#lastRxFrame`

### Controls
- `#slcanBitrate`
- `#serialConnect`
- `#serialDisconnect`

### Debug Panel
- `#canDebugData`
- Displays a live JSON snapshot including:
  - RX filter ID
  - decoded RX globals
  - `vcu2AiStatusData`
  - control output globals
  - `txData`
  - packed payload hex for each configured TX frame
  - current primary gamepad globals
  - `controlLogicData`

## Serial / SLCAN Behavior
- Serial open baud rate:
  - `115200`
- On connect:
  1. `navigator.serial.requestPort()`
  2. `port.open({ baudRate: 115200 })`
  3. acquire writer
  4. start serial read loop
  5. send `S{bitrate}`
  6. send `O`
  7. start periodic TX loops
- On disconnect:
  - stop periodic TX loops
  - cancel reader
  - await read-loop shutdown
  - send `C` unless already handling a failure/device disconnect
  - release writer
  - close port
- Physical USB disconnect is handled through the `navigator.serial` `disconnect` event.
- TX queue:
  - max `512` lines
  - oldest queued line is dropped when full

## PWA / Offline Behavior
- `index.html` links `manifest.webmanifest`.
- `app.js` registers `sw.js` on:
  - secure contexts
  - `localhost`
  - `127.0.0.1`
- `manifest.webmanifest`:
  - `display: "standalone"`
  - `start_url: "./"`
  - `scope: "./"`
  - SVG icons:
    - `icons/icon-192.svg`
    - `icons/icon-512.svg`
- `sw.js` cache name:
  - `gamepad-can-bridge-shell-v1`
- `sw.js` behavior:
  - precaches the app shell and icons
  - network-first for navigations
  - cache-first for same-origin static assets
  - removes old `basic-pwa-cache-*` caches
  - removes old `gamepad-can-bridge-shell-*` versions
- There is no in-page install button currently.
- Install is expected through the browser’s native PWA install UI.

## Run and Test
1. Serve over `http://localhost` or another secure context.
2. Open in Chromium with WebSerial and Gamepad support.
3. Reload after editing `config.js`.
4. Verify `Application > Manifest` shows the manifest.
5. Verify `Application > Service Workers` shows active `sw.js`.
6. Connect SLCAN and confirm periodic TX on:
   - `0x510`
   - `0x512`
   - `0x513`
   - `0x514`
7. Send `VCU2AI_Status_ID` (`0x520`) and confirm:
   - `#lastRxFrame` updates
   - `#asStateDisplay` updates
   - decoded globals update in `#canDebugData`
8. Move the gamepad and confirm:
   - `GAMEPAD_X_AXIS` and `GAMEPAD_Y_AXIS` update in `#canDebugData`
   - manual `STEER_REQUEST`, `SPEED_REQUEST`, and `BRAKE_REQUEST` change as expected
9. Install through the browser UI and verify the app opens standalone.
10. After one online load, test offline shell availability by disconnecting network and reloading.

## Constraints / Notes
- WebSerial requires a secure context and a user gesture.
- Only standard 11-bit SLCAN data frames are supported.
- The service worker provides offline shell behavior, not guaranteed offline hardware access.
- The code intentionally uses explicit globals for fast iteration and clarity.
