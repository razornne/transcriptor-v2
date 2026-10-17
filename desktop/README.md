# Skriptly for Windows

**The main window is the web app** (`skriptly.io/app`) — history, summaries, billing, settings, everything the
website has, in its own window. The app adds what a browser can't do:

- **Dictation anywhere.** Hold **Ctrl + Win**, speak, release — the text is pasted where your cursor is, in any
  app. **Ctrl + Win + Space** dictates hands-free. Both shortcuts are changeable (Settings → Dictation).
  **Esc** cancels. The Dictionary (Settings → Vocabulary) teaches recognition your names and terms.
- **Call recording** without "share a tab": your mic (left channel) + everything the computer plays
  (WASAPI loopback, right channel). The app only records; the page sends the file through the normal pipeline.

The window lives in the tray; closing it keeps dictation working.

## How the window and the app talk

`ui/index.html` is only a loader: it checks the connection and navigates to the web app (offline → "Try again").
The page detects the app by `window.__SKRIPTLY_DESKTOP__` and calls Rust commands through the bridge
(`landing/lib/ink/desktop.ts`). The bridge is a whitelist: `build.rs` lists every command, and
`capabilities/remote.json` allows exactly those for `https://skriptly.io/*` — nothing else (no plugins, no file access).
Navigation outside skriptly.io (Stripe, Google, Notion) opens in the system browser instead.

- **Session**: the app owns it (sign-in through the system browser, PKCE). The page asks for a fresh token
  (`desktop_session`) per request; only one side may refresh the token — two clients would sign each other out.
- **Recording**: `call_start` → `call_stop` (Ogg) → `call_take` (raw bytes over IPC) → page uploads like any file →
  `call_discard` after success. If anything fails the file stays on disk and the page offers it again on next launch.
- **Settings**: Settings → Dictation in the page (`components/ink/DesktopSettings.tsx`) drives `get_state`/`save_settings`/`set_hotkey`.

Dev: run the web app (`npm run dev` in `landing/`), then in `desktop/`:
`SKRIPTLY_APP_URL=http://localhost:3000/app npx tauri dev --config src-tauri/tauri.dev.conf.json`
(the dev config additionally allows the bridge for localhost:3000; it is never enabled in release builds).

Tauri 2 app: the Rust side does the work; `ui/` is the loader and the dictation pill.

| Piece | Where |
|---|---|
| Global shortcuts: hold + hands-free (Start-menu/Alt-menu suppression) | `src-tauri/src/hotkey.rs` — `WH_KEYBOARD_LL` hook; sequences unit-tested through `handle()` |
| Microphone → mono 16 kHz s16le | `src-tauri/src/audio.rs` (cpal/WASAPI, opened only while dictating) |
| Streaming to Soniox `stt-rt-v5` | `src-tauri/src/stt.rs` — WebSocket straight to Soniox |
| Temporary Soniox key, usage, AI polish | `src-tauri/src/api.rs` → Flask `/api/live/token` (purpose=dictation, 1 h key), `/api/dictation/usage`, `/api/dictation/cleanup` |
| Paste | `src-tauri/src/paste.rs` — clipboard + Ctrl+V, previous clipboard restored |
| Sign-in | `src-tauri/src/auth.rs` — system browser + PKCE, loopback `http://127.0.0.1:53682/callback` |
| Pill overlay | `src-tauri/src/overlay.rs` + `ui/overlay.html` — animation only (no words), never takes focus, click-through |
| Shortcut | `hotkey.rs`: 1–3 keys; in multi-key combos left/right modifiers are equal, a single key is side-exact (Right Alt); the page records the combo — Windows doesn't call the low-level hook while our own window is focused |
| Dictation bar / instant start | `overlay.rs` idle pill (hidden over full-screen windows); `mic.rs` keeps the mic open with 0.5 s pre-roll when "Instant start" is on |
| Dictionary | Settings → Vocabulary in the page → `/api/vocabulary`; the page then calls `forget_token` (terms go to Soniox `context.terms` and to AI polish) |
| Pause media while dictating | `src-tauri/src/media.rs` — Windows media sessions (SMTC): pauses only what is playing, resumes after paste |
| Settings file | `store.rs` — tmp + rename, direct-write fallback, errors logged |
| Call recording | `recorder.rs` (mixer on wall clock — loopback sends nothing during silence; WAV on disk, flushed every 5 s, survives crashes; Ogg Vorbis ~22 MB/h); web side `landing/lib/ink/nativeRecorder.ts` |

Settings/session live in `%APPDATA%\io.skriptly.desktop\` (`settings.json`, `session.json`, `skriptly.log`).

## One-time setup (Supabase)

Auth → URL Configuration → **Redirect URLs** must contain `http://127.0.0.1:53682/callback`.
Without it Supabase sends the browser to the site URL after login and the app never gets the code.

Migration `migrations/015_dictation_usage.sql` bills dictation seconds into the shared minutes limit.
Until it is applied, dictation works but isn't counted.

## Testing without touching the installed app

The installed app and a dev build share the single-instance id and `%APPDATA%\io.skriptly.desktop`.
Build and run a dev copy isolated:

```bash
TAURI_CONFIG='{"identifier":"io.skriptly.devtest"}' cargo build   # in src-tauri
APPDATA=/some/scratch/dir target/debug/skriptly.exe
```

Stop it by path (`Get-Process skriptly | ? Path -like *debug* | Stop-Process`) — `taskkill /IM skriptly.exe`
also kills the installed app. The keyboard hook ignores injected keys, so shortcuts can't be driven by
automation; `cargo test` covers the hook logic, `SKRIPTLY_DEMO_OVERLAY=1` (debug builds) cycles the pill states.

## Build

Needs Rust (stable), Node 18+, VS 2022 Build Tools, WebView2 (preinstalled on Windows 11).

```powershell
cd desktop
npm install
npm run dev      # debug build with console logs
npm run build    # installer: src-tauri/target/release/bundle/nsis/Skriptly_<ver>_x64-setup.exe
```

The installer is **unsigned** (for us and friends): SmartScreen shows "Windows protected your PC" →
"More info" → "Run anyway". Code signing before a public launch.

## Costs

Soniox real-time bills stream time: $0.12/h — a 10-second dictation ≈ $0.0003. AI polish: one
Gemini 2.5 Flash call (~0.5–1 s). Dictation seconds go into the same monthly minutes as recordings.
