// Windows: окно плашки диктовки — не забирает фокус (WS_EX_NOACTIVATE), клики насквозь
// (WS_EX_TRANSPARENT), показ через SetWindowPos(SWP_NOACTIVATE), позиция — внизу рабочей
// области монитора активного окна, поверх всего.
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

const LABEL: &str = "overlay";

fn hwnd(app: &AppHandle) -> Option<HWND> {
    let w = app.get_webview_window(LABEL)?;
    let h = w.hwnd().ok()?;
    Some(HWND(h.0 as _))
}

/// Один раз при старте: окно без фокуса, прозрачное для кликов, не в списке окон.
pub fn prepare(app: &AppHandle) {
    if let Some(h) = hwnd(app) {
        unsafe {
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
            let add = (WS_EX_NOACTIVATE.0 | WS_EX_TRANSPARENT.0 | WS_EX_TOOLWINDOW.0) as isize;
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex | add);
        }
    }
}

/// Вернуть наверх, если перекрыло другое topmost-окно. Без показа и без фокуса.
pub fn raise(app: &AppHandle) {
    if let Some(h) = hwnd(app) {
        unsafe {
            let _ = SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

/// Активное окно развёрнуто на весь монитор (видео, игра, презентация)?
pub fn foreground_is_fullscreen() -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return false;
        }
        let mut class = [0u16; 64];
        let n = GetClassNameW(fg, &mut class) as usize;
        let class = String::from_utf16_lossy(&class[..n]);
        if class == "Progman" || class == "WorkerW" || class == "Shell_TrayWnd" {
            return false; // рабочий стол/панель задач
        }
        let mut r = RECT::default();
        if GetWindowRect(fg, &mut r).is_err() {
            return false;
        }
        let mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(mon, &mut info).as_bool() {
            return false;
        }
        let m = info.rcMonitor;
        r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom
    }
}

/// Внизу по центру рабочей области монитора активного окна, поверх всех, без фокуса.
/// `size` — логические px, `center_from_bottom` — на сколько логических px центр выше нижнего края.
pub fn place(app: &AppHandle, size: (f64, f64), center_from_bottom: f64) {
    let Some(h) = hwnd(app) else { return };
    let Some(w) = app.get_webview_window(LABEL) else { return };
    unsafe {
        let fg = GetForegroundWindow();
        let mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let work: RECT = if GetMonitorInfoW(mon, &mut info).as_bool() {
            info.rcWork
        } else {
            RECT { left: 0, top: 0, right: 1920, bottom: 1040 }
        };
        let scale = w.scale_factor().unwrap_or(1.0);
        let (pw, ph) = ((size.0 * scale).round() as i32, (size.1 * scale).round() as i32);
        let center_y = work.bottom - (center_from_bottom * scale).round() as i32;
        let x = work.left + ((work.right - work.left) - pw) / 2;
        let y = center_y - ph / 2;
        let _ = SetWindowPos(h, HWND_TOPMOST, x, y, pw, ph, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(h) = hwnd(app) {
        unsafe {
            let _ = ShowWindow(h, SW_HIDE);
        }
    }
}
