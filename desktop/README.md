# Skriptly for Windows — dictation

Hold **Ctrl + Win**, speak, release — the text is pasted where your cursor is, in any app.
Tap Ctrl + Win twice for hands-free (press again to finish). **Esc** cancels.

Tauri 2 app: the Rust side does the work, `ui/` is two static pages (settings window + dictation pill).

| Piece | Where |
|---|---|
| Global hotkey (hold Ctrl+Win, Start-menu suppression) | `src-tauri/src/hotkey.rs` — `WH_KEYBOARD_LL` hook |
| Microphone → mono 16 kHz s16le | `src-tauri/src/audio.rs` (cpal/WASAPI, opened only while dictating) |
| Streaming to Soniox `stt-rt-v5` | `src-tauri/src/stt.rs` — WebSocket straight to Soniox |
| Temporary Soniox key, usage, AI polish | `src-tauri/src/api.rs` → Flask `/api/live/token` (purpose=dictation, 1 h key), `/api/dictation/usage`, `/api/dictation/cleanup` |
| Paste | `src-tauri/src/paste.rs` — clipboard + Ctrl+V, previous clipboard restored |
| Sign-in | `src-tauri/src/auth.rs` — system browser + PKCE, loopback `http://127.0.0.1:53682/callback`; the app gets its own Supabase session |
| Pill overlay | `src-tauri/src/overlay.rs` + `ui/overlay.html` — never takes focus, click-through |

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
