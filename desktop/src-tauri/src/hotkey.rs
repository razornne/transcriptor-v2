// Глобальная горячая клавиша «удерживать сочетание» через low-level хук клавиатуры.
// RegisterHotKey не умеет сочетания из одних модификаторов и не видит отпускание,
// поэтому WH_KEYBOARD_LL на отдельном потоке с message loop.
//
// Сочетание настраивается (по умолчанию Ctrl+Win): 1–3 клавиши. В сочетании из
// нескольких клавиш левый/правый Ctrl/Alt/Shift/Win не различаются; одиночная
// клавиша — строго та (Right Alt ≠ Left Alt), иначе обычный Ctrl+C запускал бы запись.
//
// События наружу: Down (сочетание зажато), Up (отпущено), Other (при зажатом
// сочетании нажали ещё клавишу — это чужой шорткат вроде Ctrl+Win+→, отмена),
// Escape (только пока идёт диктовка; сам Esc тогда глотаем).
//
// Не-модификатор из сочетания (Space в Ctrl+Shift+Space) глотаем, чтобы он не
// напечатался. Отпускание Win/Alt после сочетания глотаем и вбрасываем заново
// после «пустой» клавиши vkE8 — иначе Windows откроет «Пуск» / меню окна.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tokio::sync::mpsc::UnboundedSender;
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

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HotkeyEvent {
    Down,
    Up,
    Other,
    Escape,
}

pub const DEFAULT_HOTKEY: [u16; 2] = [VK_LCONTROL, VK_LWIN];

const VK_SHIFT: u16 = 0x10;
const VK_CONTROL: u16 = 0x11;
const VK_MENU: u16 = 0x12;
const VK_ESCAPE: u16 = 0x1B;
const VK_LWIN: u16 = 0x5B;
const VK_RWIN: u16 = 0x5C;
const VK_LSHIFT: u16 = 0xA0;
const VK_RSHIFT: u16 = 0xA1;
const VK_LCONTROL: u16 = 0xA2;
const VK_RCONTROL: u16 = 0xA3;
const VK_LMENU: u16 = 0xA4;
const VK_RMENU: u16 = 0xA5;
const VK_MASK: u16 = 0xE8; // не назначена — гасит «Пуск»/меню окна

static SENDER: OnceLock<UnboundedSender<HotkeyEvent>> = OnceLock::new();
/// Идёт диктовка — тогда Esc отменяет её и не доходит до приложения.
pub static ACTIVE: AtomicBool = AtomicBool::new(false);

static COMBO_KEYS: Mutex<Vec<u16>> = Mutex::new(Vec::new());
static DOWN: [AtomicBool; 256] = [const { AtomicBool::new(false) }; 256];
static SWALLOWED: [AtomicBool; 256] = [const { AtomicBool::new(false) }; 256];
static COMBO: AtomicBool = AtomicBool::new(false);
static MASK_WIN_UP: AtomicBool = AtomicBool::new(false);
static MASK_ALT_UP: AtomicBool = AtomicBool::new(false);

/// Запись нового сочетания из настроек: клавиши глотаются, по отпусканию всех — результат.
static CAPTURE: Mutex<Option<Capture>> = Mutex::new(None);
struct Capture {
    keys: Vec<u16>,
    done: std::sync::mpsc::Sender<Result<Vec<u16>, String>>,
}

pub fn normalize(vk: u16) -> u16 {
    match vk {
        VK_LCONTROL | VK_RCONTROL => VK_CONTROL,
        VK_LSHIFT | VK_RSHIFT => VK_SHIFT,
        VK_LMENU | VK_RMENU => VK_MENU,
        VK_RWIN => VK_LWIN,
        v => v,
    }
}

pub fn is_modifier(vk: u16) -> bool {
    matches!(normalize(vk), VK_CONTROL | VK_SHIFT | VK_MENU | VK_LWIN)
}

fn is_down(vk: u16) -> bool {
    DOWN[vk as usize & 0xFF].load(Ordering::SeqCst)
}

/// Зажато ли сочетание при текущем состоянии клавиш.
fn satisfied(combo: &[u16]) -> bool {
    match combo {
        [] => false,
        [one] => is_down(*one),
        many => many.iter().all(|k| {
            let n = normalize(*k);
            (0..256u16).any(|vk| is_down(vk) && normalize(vk) == n)
        }),
    }
}

fn in_combo(combo: &[u16], vk: u16) -> bool {
    match combo {
        [one] => *one == vk,
        many => many.iter().any(|k| normalize(*k) == normalize(vk)),
    }
}

/// Годится ли сочетание: одиночная клавиша — только модификатор или F1–F24/Pause/ScrollLock;
/// из нескольких — обязательно Ctrl, Alt или Win (Shift+буква сломал бы набор заглавных).
pub fn validate(keys: &[u16]) -> Result<(), String> {
    match keys.len() {
        0 => Err("No keys pressed".into()),
        1 => {
            let k = keys[0];
            if is_modifier(k) || (0x70..=0x87).contains(&k) || k == 0x13 || k == 0x91 {
                Ok(())
            } else {
                Err(format!("{} alone would block typing — add Ctrl, Alt or Win", label(&[k])))
            }
        }
        2 | 3 => {
            if keys.iter().any(|k| matches!(normalize(*k), VK_CONTROL | VK_MENU | VK_LWIN)) {
                Ok(())
            } else {
                Err("Use Ctrl, Alt or Win in the shortcut".into())
            }
        }
        _ => Err("Use at most 3 keys".into()),
    }
}

fn key_name(vk: u16, single: bool) -> String {
    let side = |l: &str, r: bool| if single { format!("{} {l}", if r { "Right" } else { "Left" }) } else { l.to_string() };
    match vk {
        VK_LCONTROL | VK_RCONTROL => side("Ctrl", vk == VK_RCONTROL),
        VK_CONTROL => "Ctrl".into(),
        VK_LSHIFT | VK_RSHIFT => side("Shift", vk == VK_RSHIFT),
        VK_SHIFT => "Shift".into(),
        VK_LMENU | VK_RMENU => side("Alt", vk == VK_RMENU),
        VK_MENU => "Alt".into(),
        VK_LWIN | VK_RWIN => side("Win", vk == VK_RWIN),
        0x20 => "Space".into(),
        0x0D => "Enter".into(),
        0x09 => "Tab".into(),
        0x08 => "Backspace".into(),
        0x13 => "Pause".into(),
        0x14 => "Caps Lock".into(),
        0x91 => "Scroll Lock".into(),
        0x2D => "Insert".into(),
        0x2E => "Delete".into(),
        0x24 => "Home".into(),
        0x23 => "End".into(),
        0x21 => "Page Up".into(),
        0x22 => "Page Down".into(),
        0x25 => "Left".into(),
        0x26 => "Up".into(),
        0x27 => "Right".into(),
        0x28 => "Down".into(),
        0xC0 => "`".into(),
        0x30..=0x39 | 0x41..=0x5A => (vk as u8 as char).to_string(),
        0x70..=0x87 => format!("F{}", vk - 0x6F),
        v => format!("Key {v:#04X}"),
    }
}

/// «Ctrl + Win», «Right Alt», «Ctrl + Shift + Space». Модификаторы — первыми.
pub fn label(keys: &[u16]) -> String {
    let mut ks = keys.to_vec();
    let order = |k: &u16| match normalize(*k) {
        VK_CONTROL => 0,
        VK_MENU => 1,
        VK_SHIFT => 2,
        VK_LWIN => 3,
        _ => 4,
    };
    ks.sort_by_key(order);
    ks.iter().map(|k| key_name(*k, keys.len() == 1)).collect::<Vec<_>>().join(" + ")
}

pub fn set_combo(keys: &[u16]) {
    *COMBO_KEYS.lock().unwrap() = keys.to_vec();
    COMBO.store(false, Ordering::SeqCst);
}

/// Ждёт, пока юзер нажмёт и отпустит новое сочетание (Esc — отмена).
pub fn capture(timeout: std::time::Duration) -> Result<Vec<u16>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    *CAPTURE.lock().unwrap() = Some(Capture { keys: Vec::new(), done: tx });
    let res = rx.recv_timeout(timeout).unwrap_or_else(|_| Err("timed out".into()));
    *CAPTURE.lock().unwrap() = None;
    res
}

/// Прервать запись сочетания (окно закрыли, не нажав клавиш).
pub fn cancel_capture() {
    if let Some(c) = CAPTURE.lock().unwrap().take() {
        let _ = c.done.send(Err("cancelled".into()));
    }
}

fn emit(ev: HotkeyEvent) {
    if let Some(tx) = SENDER.get() {
        let _ = tx.send(ev);
    }
}

pub fn key_input(vk: u16, up: bool) -> INPUT {
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

/// Обработка одного события клавиатуры. true = проглотить.
fn handle(vk: u16, down: bool) -> bool {
    DOWN[vk as usize & 0xFF].store(down, Ordering::SeqCst);

    // Режим записи нового сочетания: всё глотаем.
    {
        let mut cap = CAPTURE.lock().unwrap();
        if let Some(c) = cap.as_mut() {
            if down {
                if vk == VK_ESCAPE && c.keys.is_empty() {
                    let _ = c.done.send(Err("cancelled".into()));
                    *cap = None;
                } else if !c.keys.contains(&vk) {
                    c.keys.push(vk);
                }
            } else if c.keys.contains(&vk) && !c.keys.iter().any(|k| is_down(*k)) {
                let keys = std::mem::take(&mut c.keys);
                let _ = c.done.send(validate(&keys).map(|_| keys));
                *cap = None;
            }
            return true;
        }
    }

    let combo = COMBO_KEYS.lock().unwrap().clone();
    let sat = satisfied(&combo);
    let active = COMBO.load(Ordering::SeqCst);
    let mut swallow = false;

    if sat && !active {
        COMBO.store(true, Ordering::SeqCst);
        if combo.iter().any(|k| normalize(*k) == VK_LWIN) {
            MASK_WIN_UP.store(true, Ordering::SeqCst);
        }
        if combo.iter().any(|k| normalize(*k) == VK_MENU) {
            MASK_ALT_UP.store(true, Ordering::SeqCst);
        }
        emit(HotkeyEvent::Down);
    } else if active && !sat {
        COMBO.store(false, Ordering::SeqCst);
        emit(HotkeyEvent::Up);
    } else if down && !in_combo(&combo, vk) {
        if active {
            emit(HotkeyEvent::Other);
        } else if vk == VK_ESCAPE && ACTIVE.load(Ordering::SeqCst) {
            emit(HotkeyEvent::Escape);
            return true;
        }
    }

    // Не-модификатор из сочетания не должен печататься (и его автоповтор тоже).
    if in_combo(&combo, vk) && !is_modifier(vk) {
        let slot = &SWALLOWED[vk as usize & 0xFF];
        if down && (COMBO.load(Ordering::SeqCst) || slot.load(Ordering::SeqCst)) {
            slot.store(true, Ordering::SeqCst);
            swallow = true;
        } else if !down && slot.swap(false, Ordering::SeqCst) {
            swallow = true;
        }
    }

    let is_win = normalize(vk) == VK_LWIN;
    let is_alt = normalize(vk) == VK_MENU;
    if !down && ((is_win && MASK_WIN_UP.swap(false, Ordering::SeqCst)) || (is_alt && MASK_ALT_UP.swap(false, Ordering::SeqCst))) {
        send_keys(&[key_input(VK_MASK, false), key_input(VK_MASK, true), key_input(vk, true)]);
        return true;
    }
    swallow
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        if kb.flags.0 & LLKHF_INJECTED.0 == 0 {
            let msg = wparam.0 as u32;
            let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            if (down || up) && handle(kb.vkCode as u16, down) {
                return LRESULT(1);
            }
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

pub fn start(tx: UnboundedSender<HotkeyEvent>, keys: &[u16]) {
    let _ = SENDER.set(tx);
    set_combo(keys);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn press(vks: &[u16]) {
        for v in 0..256 {
            DOWN[v].store(false, Ordering::SeqCst);
        }
        for v in vks {
            DOWN[*v as usize].store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn combos_match_either_side_single_keys_exact() {
        press(&[VK_RCONTROL, VK_LWIN]);
        assert!(satisfied(&DEFAULT_HOTKEY));
        press(&[VK_LCONTROL]);
        assert!(!satisfied(&DEFAULT_HOTKEY));
        press(&[VK_LMENU]);
        assert!(!satisfied(&[VK_RMENU]));
        press(&[VK_RMENU]);
        assert!(satisfied(&[VK_RMENU]));
    }

    #[test]
    fn validation_and_labels() {
        assert!(validate(&[0x41]).is_err()); // A
        assert!(validate(&[VK_LSHIFT, 0x41]).is_err()); // Shift+A
        assert!(validate(&[VK_LCONTROL, VK_LSHIFT, 0x20]).is_ok());
        assert!(validate(&[VK_RMENU]).is_ok());
        assert!(validate(&[0x7C]).is_ok()); // F13
        assert_eq!(label(&DEFAULT_HOTKEY), "Ctrl + Win");
        assert_eq!(label(&[0x20, VK_LSHIFT, VK_LCONTROL]), "Ctrl + Shift + Space");
        assert_eq!(label(&[VK_RMENU]), "Right Alt");
    }
}
