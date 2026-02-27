# PWA_SLCAN_Gamepad Agent Context

Last updated: February 27, 2026

## Project Summary
- This repo is a static Progressive Web App (no build step, no framework).
- The app now has two roles:
  - Basic PWA demo features (offline cache, install prompt, local storage counter/note).
  - WebSerial-to-SLCAN bridge that emits CAN frames from gamepad activity.
- Main files:
  - `index.html`
  - `app.js`
  - `sw.js`
  - `manifest.webmanifest`
  - `html5-gamepad-test.html` (reference example for gamepad consumption)
  - `icons/icon-192.png`
  - `icons/icon-512.png`

## Architecture Overview
- `index.html` defines all UI controls, including install UI and SLCAN bridge UI.
- `app.js` contains all runtime logic:
  - local state persistence (`localStorage`),
  - service worker registration,
  - install prompt flow,
  - WebSerial connection/session handling,
  - SLCAN command/data framing,
  - gamepad polling and event-to-CAN mapping.
- `sw.js` provides cache-first offline behavior for static assets.

## Current Behavior (Implemented)
- Counter + note are persisted with `localStorage` keys:
  - `basic_pwa_count`
  - `basic_pwa_note`
- Install flow is implemented (`beforeinstallprompt`, deferred prompt, `appinstalled`).
- Service worker cache-first behavior is active with cache name:
  - `basic-pwa-cache-v3`

## SLCAN Bridge UI (index.html)
- CAN configuration controls:
  - `#canId` (hex input, 1-3 hex chars, valid range `000`-`7FF`, default `123`)
  - `#slcanBitrate` (`S0`-`S8`, default `S4` = 125 kbps)
- Serial controls:
  - `#serialConnect`
  - `#serialDisconnect`
- Live status indicators:
  - `#serialState`
  - `#gamepadState`

## WebSerial + SLCAN Behavior (app.js)
- WebSerial support check: `"serial" in navigator`.
- Connect flow (`Connect SLCAN` click):
  1. Prompt user to select serial port (`navigator.serial.requestPort()`).
  2. Open port at `115200` baud.
  3. Acquire writer (`port.writable.getWriter()`).
  4. Send SLCAN setup commands:
     - `S{bitrateCode}`
     - `O` (open CAN channel)
- Disconnect flow:
  - Send `C` (close CAN channel), release writer lock, close port.
- Physical USB disconnect handling:
  - `navigator.serial` `"disconnect"` event triggers app disconnect state cleanup.
- TX queueing:
  - Outgoing SLCAN lines are queued and drained asynchronously.
  - Queue is capped at 512 entries; oldest entries are dropped if over limit.

## Gamepad Event Processing (app.js)
- Uses `navigator.getGamepads()` inside a `requestAnimationFrame` loop.
- Keeps per-gamepad snapshots in `gamepadSnapshots` (`Map` keyed by gamepad index).
- Emits CAN frames for:
  - first-seen gamepad (connect event),
  - removed gamepad (disconnect event),
  - button change (pressed or analog value delta),
  - axis change (delta above deadband).
- Thresholds:
  - `BUTTON_EPSILON = 0.02`
  - `AXIS_EPSILON = 0.04`
- Event type codes:
  - `0x01` connect
  - `0x02` disconnect
  - `0x10` button change
  - `0x20` axis change

## CAN Frame Encoding
- Protocol: SLCAN standard frame command (`t`) for 11-bit CAN IDs.
- Frame string format:
  - `t{ID3hex}{DLC1hex}{DATAhex...}` + `\r`
- DLC is fixed to 8 bytes in current event payload design.
- Payload mapping (8 bytes):
  - Byte 0: event type (`0x01`, `0x02`, `0x10`, `0x20`)
  - Byte 1: gamepad index
  - Byte 2: control index (`0xFF` for connect/disconnect)
  - Bytes 3-6: event-specific payload
  - Byte 7: rolling sequence counter (`0..255`, wraps)
- Event payload details:
  - Connect/Disconnect:
    - Byte 3: button count
    - Byte 4: axis count
  - Button change:
    - Byte 3: pressed (`0` or `1`)
    - Byte 4: analog value (`0..255` from `button.value`)
  - Axis change:
    - Bytes 3-4: signed axis value as int16 little-endian from normalized range `[-1, 1]`.

## PWA Installability State (Implemented)
- `manifest.webmanifest` includes required install metadata:
  - `id`, `name`, `short_name`
  - `start_url`, `scope`
  - `display: "standalone"`
  - `background_color`, `theme_color`
  - icons (`192x192`, `512x512`, `purpose: "any maskable"`)
- `index.html` includes:
  - `<link rel="manifest" href="manifest.webmanifest">`
  - icon links to `icons/icon-192.png`
  - install UI: `#install`, `#installState`
- `app.js` includes:
  - `beforeinstallprompt` capture/defer
  - install button prompt trigger
  - `appinstalled` handling

## Run and Test
1. Serve over `http://localhost` (VS Code Live Server is fine).
2. Do not use `file://` for service worker/PWA testing.
3. Use Chromium-based browser for WebSerial + Gamepad APIs.
4. In Chrome DevTools:
   - `Application > Manifest`: verify installability.
   - `Application > Service Workers`: verify active/controlling worker.
   - `Application > Cache Storage`: verify cached assets.
5. For clean retests after SW/manifest/app changes:
   - Unregister service worker.
   - Clear site data.
   - Hard reload.
6. Verify install UX:
   - Browser install icon/menu OR in-page `Install App` button appears.
   - Clicking install triggers browser install prompt when eligible.
7. Verify SLCAN bridge UX:
   - Click `Connect SLCAN`, choose serial device.
   - Confirm `Serial: connected (channel open)` status.
   - Connect/move gamepad controls and observe outbound CAN traffic on CAN bus monitor.
   - Click `Disconnect` and confirm channel closes.

## Known Notes / Constraints
- `beforeinstallprompt` may be suppressed if user previously dismissed install.
- WebSerial requires secure context and user gesture for port selection.
- Bridge currently transmits only; it does not parse incoming SLCAN responses/ACKs.
- CAN ID input currently supports standard 11-bit IDs only (not extended 29-bit frames).
- For PWA and hardware validation, prefer full browser testing over embedded preview surfaces.
