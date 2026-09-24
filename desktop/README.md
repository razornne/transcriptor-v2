# Skriptly for Windows — dictation

Hold **Ctrl + Win** (changeable in settings), speak, release — the text is pasted where your
cursor is, in any app. Tap twice for hands-free (press again to finish). **Esc** cancels.

**Record a call** (settings window or tray menu): your mic (left channel) + everything the
computer plays (WASAPI loopback, right channel) — same stereo layout as the web recorder, so the
backend separates you from the other side. After Stop the recording is compressed, sent to
`/api/transcribe` and saved to the web history; "Open transcript" opens `skriptly.io/app?entry=<id>`.

Tauri 2 app: the Rust side does the work, `ui/` is two static pages (settings window + dictation pill).

| Piece | Where |
|---|---|
| Global hotkey (hold Ctrl+Win, Start-menu suppression) | `src-tauri/src/hotkey.rs` — `WH_KEYBOARD_LL` hook |
| Microphone → mono 16 kHz s16le | `src-tauri/src/audio.rs` (cpal/WASAPI, opened only while dictating) |
| Streaming to Soniox `stt-rt-v5` | `src-tauri/src/stt.rs` — WebSocket straight to Soniox |
| Temporary Soniox key, usage, AI polish | `src-tauri/src/api.rs` → Flask `/api/live/token` (purpose=dictation, 1 h key), `/api/dictation/usage`, `/api/dictation/cleanup` |
| Paste | `src-tauri/src/paste.rs` — clipboard + Ctrl+V, previous clipboard restored |
| Sign-in | `src-tauri/src/auth.rs` — system browser + PKCE, loopback `http://127.0.0.1:53682/callback`; the app gets its own Supabase session |
| Pill overlay | `src-tauri/src/overlay.rs` + `ui/overlay.html` — animation only (no words), never takes focus, click-through |
| Shortcut | `hotkey.rs`: 1–3 keys; in multi-key combos left/right modifiers are equal, a single key is side-exact (Right Alt); "Change" records the next combo in the hook |
| Call recording | `recorder.rs` (mixer on wall clock — loopback sends nothing during silence; WAV on disk, flushed every 5 s, survives crashes; Ogg Vorbis ~22 MB/h) + `calls.rs` (upload → poll job → insert into `transcripts` → LLM title) |

Settings/session live in `%APPDATA%\io.skriptly.desktop\` (`settings.json`, `session.json`, `skriptly.log`).

## One-time setup (Supabase)

Auth → URL Configuration → **Redirect URLs** must contain `http://127.0.0.1:53682/callback`.
Without it Supabase sends the browser to the site URL after login and the app never gets the code.

Migration `migrations/015_dictation_usage.sql` bills dictation seconds into the shared minutes limit.
Until it is applied, dictation works but isn't counted.

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
