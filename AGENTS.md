# Gamepad to CAN Bridge Agent Context

Last updated: March 1, 2026

## Project Summary
- This repo is a static browser app with no build step and no framework.
- It is a dedicated gamepad-to-CAN bridge using:
  - HTML5 Gamepad API
  - WebSerial
  - SLCAN
- The app is installable as a minimal PWA and supports offline shell caching.
- Runtime behavior:
  - polls the gamepad on a fixed `10 ms` loop
  - transmits 4 periodic CAN frames
  - receives all CAN traffic the adapter forwards
  - decodes `VCU2AI_Status_ID` (`0x520`) into control globals
  - supports selectable control modes: `switch (AS_STATE)` or raw manual
  - exposes lightweight live gamepad, debug, and serial-traffic views
  - shows a `DUAL INPUT` overlay when joystick axes `0` and `2` oppose each other
  - makes focus loss visually obvious by greying the page background and highlighting the focus warning
  - estimates serial-link utilization and warns about possible overrun risk

## Main Files
- `index.html`
  - Main UI shell.
  - Links `manifest.webmanifest`.
  - Current top-level UI layout:
    - `DUAL INPUT` overlay banner outside the main card
    - heading and focus warning at the top of the card
    - first compact row contains:
      - `#serialBaudRate`
      - `#serialConnect`
      - `#serialDisconnect`
      - `#txSchedulerState`
    - serial status line contains:
      - `#serialState`
      - `#serialLoadState`
      - `#adapterVersion`
    - gamepad status line contains:
      - `#gamepadState`
      - `#gamepadPollingState`
    - focus/live line contains:
      - `#pageFocusState`
      - `#gamepadLiveDisplay`
    - RX line combines:
      - `#rxConfig`
      - `#lastRxFrame`
    - build display is at the bottom of the card
  - Loads scripts in this order:
    1. `config.js`
    2. `globals.js`
    3. `can-encoding.js`
    4. `control-logic.js`
    5. `control-raw.js`
    6. `app.js`
- `config.js`
  - Editable runtime config in `window.APP_CONFIG`.
- `globals.js`
  - Shared mutable runtime state in `window.AppGlobals`.
- `can-encoding.js`
  - CAN packing/parsing layer.
  - Owns frame ID constants and SLCAN encode/decode helpers.
- `control-logic.js`
  - Preserved state-driven control logic using `switch (AS_STATE)`.
  - Consumes globals and writes request globals.
- `control-raw.js`
  - Basic direct manual control.
  - Ignores `switch (AS_STATE)` and drives outputs directly from the gamepad.
- `app.js`
  - Main runtime orchestration.
  - Owns WebSerial, serial read/write loops, gamepad polling, timer loops, UI updates, and service worker registration.
- `manifest.webmanifest`
  - PWA manifest for installability.
- `sw.js`
  - Offline shell service worker.
  - `control-raw.js` is part of the shell asset list and should be treated as a network-first shell file.
- `icons/icon-192.svg`
- `icons/icon-512.svg`
- `README.md`
  - High-level usage notes.

## Config
- `config.js` defines `window.APP_CONFIG`.

### Config Keys
- `serial.slcanBitrate`
  - SLCAN CAN bitrate command code (`S0`..`S8`).
  - Current default is `6` (`500 kbps CAN`).
- `can.periodicFrames`
  - Array of periodic transmit frame definitions.
  - Each frame uses:
    - `id`
    - `intervalMs`
- `can.vcu2AiStatusId`
  - The CAN ID that the app treats as the VCU status frame for decode.
  - Current default is `0x520`.
- `manualControl`
  - Full-scale limits for joystick-driven manual control.
  - Keys:
    - `steerMax`
    - `speedMax`
    - `brakeMax`

### Current Defaults
- TX:
  - `0x510 @ 20ms`
  - `0x512 @ 20ms`
  - `0x513 @ 20ms`
  - `0x514 @ 20ms`
- RX decode target:
  - `VCU2AI_Status_ID = 0x520`
- SLCAN CAN bitrate:
  - `S6` (`500 kbps`)
- Manual control full scale:
  - `steerMax = 300`
  - `speedMax = 4000`
  - `brakeMax = 100`

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
- `GAMEPAD_BUTTON_1_PRESSED`
- `GAMEPAD_BUTTON_2_PRESSED`
- `GAMEPAD_BUTTON_3_PRESSED`
- `GAMEPAD_BUTTON_0_PRESS_COUNT`
- `GAMEPAD_BUTTON_1_PRESS_COUNT`
- `GAMEPAD_BUTTON_2_PRESS_COUNT`
- `GAMEPAD_BUTTON_3_PRESS_COUNT`
- `GAMEPAD_X_AXIS`
- `GAMEPAD_X2_AXIS`
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
  - Still exists as legacy/fallback support.
- `vcu2AiStatusData`
  - Stores decoded `0x520` metadata and mirrored status values.
  - Fields:
    - `matchedId`
    - `lastPayloadBytes`
    - `lastTimestamp`
    - `lastDisplayText`
    - `HANDSHAKE`
    - `GO_SIGNAL`
    - `AS_STATE`
    - `AMI_STATE`
- `rxFrameStats`
  - Receive statistics for all CAN frames seen from the adapter.
  - Fields:
    - `totalFrames`
    - `lastSeenId`
    - `lastSeenTimestamp`
    - `countsById`
  - `countsById` starts empty and is populated dynamically from actual traffic.
  - Stats are reset on each adapter reconnect.
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

## Control Mode Selection
- `index.html` exposes a `#controlMode` selector.
- Visible option labels are:
  - `Auto` (`value="state"`)
  - `Manual` (`value="raw"`)
- `state`
  - Uses `window.ControlLogic` from `control-logic.js`.
  - Preserves the existing `switch (AS_STATE)` behavior.
- `raw`
  - Uses `window.ControlRawLogic` from `control-raw.js`.
  - Applies direct manual gamepad control without `switch (AS_STATE)`.
  - Latching button controls:
    - button 0 cycles `MISSION_STATUS` through `0 -> 1 -> 2 -> 3 -> 0`
    - button 1 toggles `DIRECTION_REQUEST` between `0` and `1`
    - button 2 toggles `ESTOP_REQUEST` between `0` and `1`
    - button 3 toggles `TORQUE_REQUEST` between `0` and `1950`
  - These button actions are rising-edge triggered and do not retrigger while held.
  - The latching is driven from explicit button press counters incremented in `processGamepads()`.
  - `STEER_REQUEST`, `SPEED_REQUEST`, and `BRAKE_REQUEST` remain axis-driven with the existing linear mapping and deadband.
- `app.js` can switch modes at runtime without a page reload.

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
- RX parsing supports:
  - standard 11-bit receive frames: `t...`
  - extended receive frames: `T...`
- The app only decodes `0x520` into status globals, but it counts all received frame IDs.
- TX still only generates standard 11-bit frames.

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
- `STEER_REQUEST` from the stronger of raw gamepad X axes `0` and `2`:
  - raw browser convention:
    - positive X = right
  - central deadband:
    - `|axis| <= 0.05` -> `0`
  - outside the deadband:
    - scales linearly to full range
    - control logic intentionally inverts sign
    - full scale is `-steerMax..steerMax` (current default `-300..300`)
- `SPEED_REQUEST` from raw gamepad Y axis:
  - raw browser convention:
    - positive Y = down
  - central deadband:
    - `|GAMEPAD_Y_AXIS| <= 0.05` contributes `0`
  - up command:
    - uses `-GAMEPAD_Y_AXIS`
    - scales linearly from `0` to `speedMax` (current default `4000`)
    - only upward travel contributes
- `BRAKE_REQUEST` from raw gamepad Y axis:
  - central deadband:
    - `|GAMEPAD_Y_AXIS| <= 0.05` contributes `0`
  - down command:
    - uses `+GAMEPAD_Y_AXIS`
    - scales linearly from `0` to `brakeMax` (current default `100`)
    - only downward travel contributes
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
  - dedicated async loop every `10 ms`
- Periodic CAN transmit:
  - one async loop per configured frame
- Serial receive:
  - dedicated async read loop
  - buffered and split on `CR` / `LF`
- Mission timer:
  - dedicated async loop every `10 ms`
  - re-runs control logic on each tick
- Serial load monitor:
  - dedicated async loop every `1000 ms`
  - estimates serial-link utilization from actual TX/RX byte counts
- Serial receive polling:
  - optional async loop every `20 ms`
  - sends `A` when the adapter does not support/enable automatic RX forwarding

## Gamepad Processing
- The app stores per-pad snapshots in a `Map`.
- Polling is fixed-rate, independent of paint timing.
- It emits raw gamepad event data into `txData` when:
  - a pad connects
  - a pad disconnects
  - a button changes
  - an axis changes
- Thresholds:
  - `BUTTON_EPSILON = 0.02`
  - `AXIS_EPSILON = 0.04`
- Poll interval:
  - `GAMEPAD_POLL_INTERVAL_MS = 10`
- The lowest-index connected pad is treated as the primary pad for manual control globals.
- The main UI also shows a lightweight live primary-pad sample:
  - pad count
  - primary `X`
  - primary `X2`
  - primary `Y`
  - primary button 0 state
- The main UI also shows page focus state:
  - `focused`
  - `visible, unfocused`
  - `hidden`
- If the page is not focused or visible:
  - the page background changes from white to grey
  - the `NOTE: Some gamepads require page focus...` heading is highlighted yellow
- `DUAL INPUT` Easter egg:
  - shows as a large overlay banner
  - triggers when axes `0` and `2` are both above `0.2` in magnitude and opposite in sign

## UI Elements

### Status / Config
- `#frameConfig`
- `#appVersion`
- `#rxConfig`
- `#logicConfig`
- `#asStateDisplay`
- `#serialState`
- `#gamepadState`
- `#gamepadPollingState`
- `#gamepadLiveDisplay`
- `#pageFocusState`
- `#txSchedulerState`
- `#serialLoadState`
- `#txCount`
- `#lastFrame`
- `#lastRxFrame`
- `#adapterVersion`
- `#focusWarning`
- `#missionStatusDisplay`
- `#steerRequestDisplay`
- `#torqueRequestDisplay`
- `#speedRequestDisplay`
- `#brakeRequestDisplay`
- `#directionRequestDisplay`
- `#estopRequestDisplay`
- `#dualInputBanner`

### Controls
- `#serialBaudRate`
  - WebSerial port open baud rate.
  - Default UI value is `2000000`.
  - Available options:
    - `115200`
    - `250000`
    - `500000`
    - `1000000`
    - `2000000`
- `#controlMode`
  - Selects `Auto` (`switch(AS_STATE)`) or `Manual` (`raw manual`).
- `#serialConnect`
- `#serialDisconnect`

### Build Display
- `#appVersion`
- Rendered at the bottom of the main card.
- Set from `app.js` constant:
  - `APP_BUILD_VERSION = "2026-02-28.7"`
- Intended as a visible deployment/build marker so stale hosted shells are obvious.

### Serial Console
- Container:
  - `#serialConsolePanel`
- `#serialConsole`
- Intended to mirror actual serial-port traffic only.
- Displays:
  - `TX` for bytes/lines written by the app
  - `RX` for bytes/lines received from the SLCAN adapter
- Still renders control characters as readable markers:
  - `<CR>`
  - `<BEL>`
- Includes timestamps.
- It does not display derived `ACK` or internal `SYS` status messages anymore.
- Rendering is skipped while the `<details>` panel is closed.
- Opening the panel renders the current buffered log immediately.

### Debug Panel
- Container:
  - `#debugGlobalsPanel`
- `#canDebugData`
- Displays a live JSON snapshot including:
  - RX decode target ID
  - decoded RX globals
  - `vcu2AiStatusData`
  - `rxFrameStats` with dynamic `countsById`
  - control output globals
  - packed payload hex for each configured TX frame
  - current primary gamepad globals
  - `controlLogicData`
- Rendering is skipped while the `<details>` panel is closed.
- When open, rendering is throttled to `10 Hz` (`100 ms`).
- Opening the panel forces an immediate refresh.

### Main Output Display
- Separate always-visible lines are shown for:
  - `MISSION_STATUS`
  - `STEER_REQUEST`
  - `TORQUE_REQUEST`
  - `SPEED_REQUEST`
  - `BRAKE_REQUEST`
  - `DIRECTION_REQUEST`
  - `ESTOP_REQUEST`
- `mission_timer` still exists in logic, but is no longer shown in the separate output list.

## Serial / SLCAN Behavior
- WebSerial port open baud rate:
  - selected from `#serialBaudRate`
  - current code fallback default is `2000000`
- On connect:
  1. `navigator.serial.requestPort()`
  2. `port.open({ baudRate: selectedSerialBaud })`
  3. acquire writer
  4. start serial read loop
  5. reset serial-load counters and RX frame counters
  6. reset TX / RX UI fields and set `#adapterVersion` to `querying...`
  7. send `V` and wait for a non-error response
  8. display the returned `V` text in `#adapterVersion`
  9. send `C` as a short best-effort close (`allowAckError`, `150 ms`)
  10. wait `50 ms`
  11. send `S{slcanBitrate}` from config (best-effort, no ack required)
  12. wait `50 ms`
  13. send `M00000000` (best-effort, no ack required)
  14. send `mFFFFFFFF` (best-effort, no ack required)
  15. send `X1` (best-effort, no ack required)
  16. send `O` (best-effort, no ack required)
  17. start `A` receive polling immediately
  18. start periodic TX loops
- On disconnect:
  - stop periodic TX loops
  - stop receive polling loop
  - if possible, send `C` while reader is still alive so the response is consumed
  - cancel reader
  - await read-loop shutdown
  - release writer
  - close port
- Physical USB disconnect is handled through the `navigator.serial` `disconnect` event.
- TX queue:
  - max `512` lines
  - oldest queued line is dropped when full
- Ack handling:
  - waited commands are intentionally minimal:
    - `V` is the primary adapter-presence and identity check
    - `C` is used as a short tolerant close during connect / disconnect
  - when a command is being awaited, empty `CR`, command echo, and `OK` count as success
  - pending `V` resolves with the returned text line, which is shown in `#adapterVersion`
  - `BEL`, `ERR`, and `ERROR` only fail a command when a waiter is active
  - unsolicited `BEL` with no pending command is ignored
- RX handling:
  - the app sends open filter commands (`M00000000`, `mFFFFFFFF`) and filters in the browser
  - the app decodes only `0x520` as the VCU status frame
  - all received frame IDs are still counted in `rxFrameStats`
  - `z` is treated as adapter TX / auto-forwarding feedback, not as a CAN frame
  - when `z` is seen, the app stops `A` polling and assumes the adapter is auto-forwarding RX data
- Last-frame UI formatting:
  - `#lastFrame` is shown as `timestamp CAN_ID payload-bytes`, not as raw SLCAN
  - `#lastRxFrame` is shown as `timestamp CAN_ID payload-bytes`

## Serial Load Warning
- The UI exposes `#serialLoadState`.
- The app samples TX and RX byte counts once per second.
- Utilization estimate uses:
  - current selected serial baud
  - `10 bits/byte` (`8N1` heuristic)
- Warning thresholds:
  - `>= 65%` -> `elevated`
  - `>= 85%` -> `high ... (overrun risk)`
- This is a heuristic for serial-link saturation risk.
- It does not prove adapter-side CAN FIFO overflow.

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
  - `gamepad-can-bridge-shell-v4`
- `sw.js` behavior:
  - precaches the app shell and icons
  - network-first for navigations
  - network-first for known shell assets
  - cache fallback when offline
  - removes old `basic-pwa-cache-*` caches
  - removes old `gamepad-can-bridge-shell-*` versions
- There is no in-page install button currently.
- Install is expected through the browser's native PWA install UI.

## Run and Test
1. Serve over `http://localhost` or another secure context.
2. Open in Chromium with WebSerial and Gamepad support.
3. Reload after editing `config.js` or after service worker-affecting JS/UI changes.
4. Verify `Application > Manifest` shows the manifest.
5. Verify `Application > Service Workers` shows active `sw.js`.
6. Connect SLCAN and confirm:
   - `#adapterVersion` shows the adapter response to `V`
   - periodic TX on:
     - `0x510`
     - `0x512`
     - `0x513`
     - `0x514`
7. Confirm the serial console shows actual `TX` and `RX` traffic.
8. Confirm `Serial load` reports utilization and stays below warning thresholds for the selected serial baud.
9. Send `VCU2AI_Status_ID` (`0x520`) and confirm:
   - `#lastRxFrame` updates
   - `#asStateDisplay` updates
   - decoded globals update in `#canDebugData`
10. Confirm `rxFrameStats.countsById` grows dynamically from real bus traffic and resets after reconnect.
11. Move the gamepad and confirm:
    - `GAMEPAD_X_AXIS`, `GAMEPAD_X2_AXIS`, and `GAMEPAD_Y_AXIS` update in `#canDebugData`
    - manual `STEER_REQUEST`, `SPEED_REQUEST`, and `BRAKE_REQUEST` change as expected
    - `#gamepadLiveDisplay` updates even when `Debug globals` is closed
12. Verify page focus behavior:
    - `#pageFocusState` shows `focused` when the app window is active
    - `#pageFocusState` changes to `visible, unfocused` or `hidden` when focus is lost
    - focused is the recommended baseline for reliability checks; some gamepads may still report while unfocused
13. Install through the browser UI and verify the app opens standalone.
14. After one online load, test offline shell availability by disconnecting network and reloading.

## Constraints / Notes
- WebSerial requires a secure context and a user gesture.
- Focus improves gamepad reliability, but dependence on focus varies by controller and browser.
- Some gamepads continue reporting while unfocused; others may stop or become inconsistent when the page is unfocused or hidden.
- TX only emits standard 11-bit SLCAN frames.
- RX parsing supports both standard and extended SLCAN receive frames.
- The service worker provides offline shell behavior, not guaranteed offline hardware access.
- The code intentionally uses explicit globals for fast iteration and clarity.




