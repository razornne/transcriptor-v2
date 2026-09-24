// Глобальная горячая клавиша «удерживать Ctrl+Win» через low-level хук клавиатуры.
// RegisterHotKey не умеет комбинации из одних модификаторов и не видит отпускание,
// поэтому WH_KEYBOARD_LL на отдельном потоке с message loop.
//
// События наружу: Down (зажали Ctrl+Win), Up (отпустили), Other (при зажатых
// Ctrl+Win нажали ещё клавишу — это системный шорткат вроде Ctrl+Win+→, диктовку
// отменяем), Escape (только пока идёт диктовка; сам Esc тогда глотаем).
//
// Меню «Пуск»: Windows открывает его на отпускании Win, если между нажатием и
// отпусканием не было других клавиш. Как AutoHotkey — глотаем отпускание Win,
// вбрасываем «пустую» клавишу vkE8 и уже потом отпускание Win.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tokio::sync::mpsc::UnboundedSender;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_CONTROL, VK_ESCAPE, VK_LCONTROL, VK_LWIN, VK_RCONTROL, VK_RWIN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage, HHOOK, KBDLLHOOKSTRUCT,
    LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HotkeyEvent {
    Down,
    Up,
    Other,
    Escape,
}

static SENDER: OnceLock<UnboundedSender<HotkeyEvent>> = OnceLock::new();
/// Идёт диктовка — тогда Esc отменяет её и не доходит до приложения.
pub static ACTIVE: AtomicBool = AtomicBool::new(false);

static CTRL: AtomicBool = AtomicBool::new(false);
static WIN: AtomicBool = AtomicBool::new(false);
static COMBO: AtomicBool = AtomicBool::new(false);
static MASK_WIN_UP: AtomicBool = AtomicBool::new(false);

fn emit(ev: HotkeyEvent) {
    if let Some(tx) = SENDER.get() {
        let _ = tx.send(ev);
    }
}

fn key(vk: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

pub fn send_keys(inputs: &[INPUT]) {
    unsafe {
        SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

pub fn key_input(vk: u16, up: bool) -> INPUT {
    key(vk, up)
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code < 0 {
        return CallNextHookEx(HHOOK::default(), code, wparam, lparam);
    }
    let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
    if kb.flags.0 & LLKHF_INJECTED.0 != 0 {
        return CallNextHookEx(HHOOK::default(), code, wparam, lparam);
    }
    let msg = wparam.0 as u32;
    let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
    let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
    let vk = kb.vkCode as u16;
    let is_ctrl = vk == VK_LCONTROL.0 || vk == VK_RCONTROL.0 || vk == VK_CONTROL.0;
    let is_win = vk == VK_LWIN.0 || vk == VK_RWIN.0;

    if is_ctrl && (down || up) {
        CTRL.store(down, Ordering::SeqCst);
    }
    if is_win && (down || up) {
        WIN.store(down, Ordering::SeqCst);
    }
    let both = CTRL.load(Ordering::SeqCst) && WIN.load(Ordering::SeqCst);
    let combo = COMBO.load(Ordering::SeqCst);

    if both && !combo {
        COMBO.store(true, Ordering::SeqCst);
        MASK_WIN_UP.store(true, Ordering::SeqCst);
        emit(HotkeyEvent::Down);
    } else if combo && !both {
        COMBO.store(false, Ordering::SeqCst);
        emit(HotkeyEvent::Up);
    } else if down && !is_ctrl && !is_win {
        if combo {
            emit(HotkeyEvent::Other);
        } else if vk == VK_ESCAPE.0 && ACTIVE.load(Ordering::SeqCst) {
            emit(HotkeyEvent::Escape);
            return LRESULT(1);
        }
    }

    if is_win && up && MASK_WIN_UP.swap(false, Ordering::SeqCst) {
        send_keys(&[key(0xE8, false), key(0xE8, true), key(vk, true)]);
        return LRESULT(1);
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

pub fn start(tx: UnboundedSender<HotkeyEvent>) {
    let _ = SENDER.set(tx);
    std::thread::Builder::new()
        .name("skriptly-hotkey".into())
        .spawn(|| unsafe {
            let hmod = GetModuleHandleW(None).map(|m| HINSTANCE(m.0)).unwrap_or_default();
            match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), hmod, 0) {
                Ok(_) => crate::log!("[hotkey] keyboard hook installed"),
                Err(e) => {
                    crate::log!("[hotkey] SetWindowsHookExW failed: {e}");
                    return;
                }
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        })
        .expect("hotkey thread");
}

/// Физически зажаты Win или Ctrl? (перед вставкой ждём, пока юзер отпустит —
/// иначе наш Ctrl+V превратится в Win+Ctrl+V.)
pub fn modifiers_held() -> bool {
    [VK_LWIN, VK_RWIN, VK_LCONTROL, VK_RCONTROL]
        .iter()
        .any(|vk| unsafe { GetAsyncKeyState(vk.0 as i32) } < 0)
}
