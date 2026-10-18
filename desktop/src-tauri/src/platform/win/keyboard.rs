// Windows: глобальный перехват клавиатуры (WH_KEYBOARD_LL на своём потоке с message loop),
// синтетические нажатия (Ctrl+V, «пустая» клавиша против меню Пуск) и опрос модификаторов.
// Логика сочетаний — в общем hotkey.rs; сюда приходят только сырые события.
use std::sync::OnceLock;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage, HHOOK, KBDLLHOOKSTRUCT,
    LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

const VK_CONTROL: u16 = 0x11;
const VK_V: u16 = 0x56;
const VK_LWIN: u16 = 0x5B;
const VK_RWIN: u16 = 0x5C;
const VK_LSHIFT: u16 = 0xA0;
const VK_RSHIFT: u16 = 0xA1;
const VK_LCONTROL: u16 = 0xA2;
const VK_RCONTROL: u16 = 0xA3;
const VK_LMENU: u16 = 0xA4;
const VK_RMENU: u16 = 0xA5;

/// Обработчик события клавиши: (vk, down) → true = проглотить.
pub type Handler = fn(u16, bool) -> bool;
static HANDLER: OnceLock<Handler> = OnceLock::new();

fn key_input(vk: u16, up: bool) -> INPUT {
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

fn send_keys(inputs: &[INPUT]) {
    unsafe {
        SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// Ctrl+V в активное окно.
pub fn send_paste() -> Result<(), String> {
    send_keys(&[
        key_input(VK_CONTROL, false),
        key_input(VK_V, false),
        key_input(VK_V, true),
        key_input(VK_CONTROL, true),
    ]);
    Ok(())
}

/// Отпускание Win/Alt, которое мы проглотили, вбрасываем заново после «пустой» клавиши `mask`:
/// иначе Windows откроет «Пуск» / меню окна.
pub fn swallow_release(mask: u16, vk: u16) {
    send_keys(&[key_input(mask, false), key_input(mask, true), key_input(vk, true)]);
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        if kb.flags.0 & LLKHF_INJECTED.0 == 0 {
            let msg = wparam.0 as u32;
            let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            if (down || up) && HANDLER.get().is_some_and(|h| h(kb.vkCode as u16, down)) {
                return LRESULT(1);
            }
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

/// Ставит хук на отдельном потоке. События уходят в `handler`.
pub fn run_hook(handler: Handler) {
    let _ = HANDLER.set(handler);
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

/// Физически зажат какой-то модификатор? (перед вставкой ждём, пока юзер
/// отпустит — иначе наш Ctrl+V превратится в Win+Ctrl+V / Alt+Ctrl+V.)
pub fn modifiers_held() -> bool {
    [VK_LWIN, VK_RWIN, VK_LCONTROL, VK_RCONTROL, VK_LMENU, VK_RMENU, VK_LSHIFT, VK_RSHIFT]
        .iter()
        .any(|vk| unsafe { GetAsyncKeyState(*vk as i32) } < 0)
}
