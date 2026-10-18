// macOS: клавиатура — не реализовано (CGEventTap).
pub type Handler = fn(u16, bool) -> bool;

pub fn run_hook(_handler: Handler) {
    crate::log!("[hotkey] macOS keyboard hook is not implemented yet");
}

pub fn send_paste() -> Result<(), String> {
    Err("paste is not implemented on macOS yet".into())
}

pub fn swallow_release(_mask: u16, _vk: u16) {}

pub fn modifiers_held() -> bool {
    false
}
