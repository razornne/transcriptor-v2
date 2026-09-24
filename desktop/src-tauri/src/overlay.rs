// Плашка диктовки внизу экрана. Не должна забирать фокус у приложения, куда
// вставляем текст, и не должна ловить клики: WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
// показ через SetWindowPos(SWP_NOACTIVATE). Появляется на мониторе активного окна.
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST,
    SWP_NOACTIVATE, SWP_NOSIZE, SWP_SHOWWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

const LABEL: &str = "overlay";

/// Каждый показ — новое «поколение»: отложенное скрытие от прошлой диктовки
/// не должно спрятать плашку новой.
static GEN: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone)]
pub struct OverlayState<'a> {
    /// listening | handsfree | finishing | polishing | done | empty | error
    pub state: &'a str,
    pub text: &'a str,
    pub pending: &'a str,
}

fn hwnd(app: &AppHandle) -> Option<HWND> {
    let w = app.get_webview_window(LABEL)?;
    let h = w.hwnd().ok()?;
    Some(HWND(h.0 as _))
}

pub fn setup(app: &AppHandle) {
    if let Some(h) = hwnd(app) {
        unsafe {
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
            let add = (WS_EX_NOACTIVATE.0 | WS_EX_TRANSPARENT.0 | WS_EX_TOOLWINDOW.0) as isize;
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex | add);
        }
    }
}

pub fn show(app: &AppHandle) -> u64 {
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(h) = hwnd(app) else { return gen };
    let Some(w) = app.get_webview_window(LABEL) else { return gen };
    let size = w.outer_size().unwrap_or(tauri::PhysicalSize::new(460, 64));
    unsafe {
        let fg = GetForegroundWindow();
        let mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let work: RECT = if GetMonitorInfoW(mon, &mut info).as_bool() { info.rcWork } else { RECT { left: 0, top: 0, right: 1920, bottom: 1040 } };
        let scale = w.scale_factor().unwrap_or(1.0);
        let x = work.left + ((work.right - work.left) - size.width as i32) / 2;
        let y = work.bottom - size.height as i32 - (28.0 * scale) as i32;
        let _ = SetWindowPos(h, HWND_TOPMOST, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
    gen
}

/// Скрыть, только если с тех пор плашку не показали заново.
pub fn hide_if(app: &AppHandle, gen: u64) {
    if GEN.load(Ordering::SeqCst) == gen {
        hide(app);
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
}

pub fn emit(app: &AppHandle, state: &str, text: &str, pending: &str) {
    let _ = app.emit_to(LABEL, "overlay", OverlayState { state, text, pending });
}

pub fn level(app: &AppHandle, level: f32) {
    let _ = app.emit_to(LABEL, "overlay-level", level);
}
