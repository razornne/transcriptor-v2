// Реализация для Windows: хук клавиатуры (WH_KEYBOARD_LL), SendInput, Win32-окно плашки,
// медиасессии SMTC, UI Automation для чтения текстового поля.
pub mod keyboard;
pub mod learn;
pub mod media;
pub mod overlay;

use std::path::PathBuf;

/// %APPDATA%\io.skriptly.desktop — то же, что app_config_dir(), но доступно до setup().
pub fn config_base() -> PathBuf {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("io.skriptly.desktop")
}
