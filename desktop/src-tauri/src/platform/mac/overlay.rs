// macOS: окно плашки — не реализовано (NSPanel). Плашка просто не показывается.
use tauri::AppHandle;

pub fn prepare(_app: &AppHandle) {}
pub fn raise(_app: &AppHandle) {}
pub fn foreground_is_fullscreen() -> bool {
    false
}
pub fn place(_app: &AppHandle, _size: (f64, f64), _center_from_bottom: f64) {}
pub fn hide(_app: &AppHandle) {}
