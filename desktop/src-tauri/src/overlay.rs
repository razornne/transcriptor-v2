// Плашка диктовки внизу экрана. В покое (настройка «Show dictation bar») — маленькая
// капсула, как у Wispr Flow; на диктовке раскрывается в анимацию записи и
// переезжает на монитор активного окна. Не забирает фокус у приложения, куда
// вставляем текст, и не ловит клики: WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
// показ через SetWindowPos(SWP_NOACTIVATE). Поверх полноэкранного окна
// (видео, игра, презентация) капсула покоя прячется.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

const LABEL: &str = "overlay";
/// Окно плашки (логические px): раскрытое — под плашку записи/сообщения, в покое —
/// ровно под капсулу (иначе невидимая часть окна ловила бы клики, напр. по полю ввода
/// над панелью задач). Центры совпадают, поэтому смена размера не даёт скачка.
const BIG: (f64, f64) = (460.0, 64.0);
const SMALL: (f64, f64) = (64.0, 20.0);
/// Центр плашки — столько логических px над нижним краем рабочей области.
const CENTER_FROM_BOTTOM: f64 = 21.0;

/// Каждый показ — новое «поколение»: отложенный возврат в покой от прошлой
/// диктовки не должен свернуть плашку новой.
static GEN: AtomicU64 = AtomicU64::new(0);
/// Настройка «Show dictation bar».
static BAR: AtomicBool = AtomicBool::new(true);
/// Плашка сейчас раскрыта (диктовка/сообщение) — вотчер полноэкранности её не трогает.
static BUSY: AtomicBool = AtomicBool::new(false);
/// Видна ли сейчас капсула покоя (чтобы не дёргать окно каждую секунду).
static RESTING_SHOWN: AtomicBool = AtomicBool::new(false);
static TICK: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Clone)]
pub struct OverlayState<'a> {
    /// idle | arming | listening | handsfree | finishing | polishing | done | empty | error | hidden
    pub state: &'a str,
    pub text: &'a str,
    pub pending: &'a str,
}

fn hwnd(app: &AppHandle) -> Option<HWND> {
    let w = app.get_webview_window(LABEL)?;
    let h = w.hwnd().ok()?;
    Some(HWND(h.0 as _))
}

pub fn setup(app: &AppHandle, bar: bool) {
    if let Some(h) = hwnd(app) {
        unsafe {
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
            let add = (WS_EX_NOACTIVATE.0 | WS_EX_TRANSPARENT.0 | WS_EX_TOOLWINDOW.0) as isize;
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex | add);
        }
    }
    // Клики насквозь по всему окну, включая дочернее окно WebView2
    // (одного WS_EX_TRANSPARENT на верхнем окне для этого мало).
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.set_ignore_cursor_events(true);
    }
    BAR.store(bar, Ordering::SeqCst);
    let a = app.clone();
    // Страница плашки грузится асинхронно — капсулу покоя показываем чуть позже.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1200)).await;
        rest(&a);
    });
    let a = app.clone();
    std::thread::Builder::new()
        .name("skriptly-bar".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(1000));
            watch(&a);
        })
        .expect("bar thread");
}

/// Раз в секунду: капсула покоя прячется над полноэкранным окном и возвращается после.
fn watch(app: &AppHandle) {
    if !BAR.load(Ordering::SeqCst) || BUSY.load(Ordering::SeqCst) {
        return;
    }
    let full = foreground_is_fullscreen();
    let shown = RESTING_SHOWN.load(Ordering::SeqCst);
    if full && shown {
        raw_hide(app);
        RESTING_SHOWN.store(false, Ordering::SeqCst);
    } else if !full && !shown {
        emit(app, "idle", "", "");
        place(app, false);
        RESTING_SHOWN.store(true, Ordering::SeqCst);
    } else if !full && TICK.fetch_add(1, Ordering::SeqCst) % 15 == 0 {
        // Раз в 15 с возвращаем наверх, если перекрыло другое topmost-окно. Не каждую
        // секунду и без SWP_SHOWWINDOW: ежесекундное «поднятие» сбивало фокус окна
        // настроек, и запись нового шортката обрывалась.
        if let Some(h) = hwnd(app) {
            unsafe {
                let _ = SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        }
    }
}

fn foreground_is_fullscreen() -> bool {
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
/// `big` — окно под раскрытую плашку, иначе — под капсулу покоя.
fn place(app: &AppHandle, big: bool) {
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
        let (lw, lh) = if big { BIG } else { SMALL };
        let (pw, ph) = ((lw * scale).round() as i32, (lh * scale).round() as i32);
        let center_y = work.bottom - (CENTER_FROM_BOTTOM * scale).round() as i32;
        let x = work.left + ((work.right - work.left) - pw) / 2;
        let y = center_y - ph / 2;
        let _ = SetWindowPos(h, HWND_TOPMOST, x, y, pw, ph, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
}

fn raw_hide(app: &AppHandle) {
    if let Some(h) = hwnd(app) {
        unsafe {
            let _ = ShowWindow(h, SW_HIDE);
        }
    }
}

/// Раскрыть плашку (диктовка, сообщение). Возвращает «поколение» для rest_if.
pub fn show(app: &AppHandle) -> u64 {
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    BUSY.store(true, Ordering::SeqCst);
    place(app, true);
    RESTING_SHOWN.store(false, Ordering::SeqCst);
    gen
}

/// Вернуться в покой: капсула (если включена и нет полноэкранного окна) или скрыть совсем.
pub fn rest(app: &AppHandle) {
    BUSY.store(false, Ordering::SeqCst);
    if BAR.load(Ordering::SeqCst) && !foreground_is_fullscreen() {
        emit(app, "idle", "", "");
        RESTING_SHOWN.store(true, Ordering::SeqCst);
        // Сначала плашка сворачивается анимацией в большом окне, потом окно ужимается.
        let (a, gen) = (app.clone(), GEN.load(Ordering::SeqCst));
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(380)).await;
            if GEN.load(Ordering::SeqCst) == gen && !BUSY.load(Ordering::SeqCst) {
                place(&a, false);
            }
        });
    } else {
        emit(app, "hidden", "", "");
        raw_hide(app);
        RESTING_SHOWN.store(false, Ordering::SeqCst);
    }
}

/// В покой, только если с тех пор плашку не раскрыли заново.
pub fn rest_if(app: &AppHandle, gen: u64) {
    if GEN.load(Ordering::SeqCst) == gen {
        rest(app);
    }
}

pub fn set_bar(app: &AppHandle, on: bool) {
    BAR.store(on, Ordering::SeqCst);
    if !BUSY.load(Ordering::SeqCst) {
        rest(app);
    }
}

pub fn emit(app: &AppHandle, state: &str, text: &str, pending: &str) {
    let _ = app.emit_to(LABEL, "overlay", OverlayState { state, text, pending });
}

pub fn level(app: &AppHandle, level: f32) {
    let _ = app.emit_to(LABEL, "overlay-level", level);
}
