// macOS: пока заглушки — слой собирается (CI на macOS-раннере), но функции ещё не написаны.
// Что нужно сделать на Mac (в порядке работы):
//   keyboard — CGEventTap (Accessibility/Input Monitoring), перевод CGKeyCode ↔ VK, Cmd+V через CGEvent;
//   overlay  — NSPanel без активации, поверх всех, положение по NSScreen активного окна;
//   media    — MediaRemote (приватный фреймворк) или пауза через AppleScript Music/Spotify;
//   learn    — AXUIElement (kAXFocusedUIElement, kAXValue), AXSecureTextField пропускать;
//   loopback — ScreenCaptureKit (звук системы), запрос разрешения Screen Recording;
//   разрешения: микрофон (NSMicrophoneUsageDescription), Accessibility, Screen Recording.
pub mod keyboard;
pub mod learn;
pub mod media;
pub mod overlay;

use std::path::PathBuf;

/// ~/Library/Application Support/io.skriptly.desktop
pub fn config_base() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    home.join("Library").join("Application Support").join("io.skriptly.desktop")
}
