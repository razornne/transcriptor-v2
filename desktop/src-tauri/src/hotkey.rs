// Глобальная горячая клавиша «удерживать сочетание» через low-level хук клавиатуры.
// RegisterHotKey не умеет сочетания из одних модификаторов и не видит отпускание,
// поэтому WH_KEYBOARD_LL на отдельном потоке с message loop.
//
// Два настраиваемых сочетания (1–3 клавиши каждое):
//   • «удерживать» (по умолчанию Ctrl+Win) — говоришь, пока держишь;
//   • «закрепить» (по умолчанию Ctrl+Win+Space) — диктовка без удержания, повторное
//     нажатие заканчивает. Если оно шире «удерживать» (Alt → Alt+Z, как в Wispr Flow),
//     можно начать удержанием и «защёлкнуть» нажатием Z.
// В сочетании из нескольких клавиш левый/правый Ctrl/Alt/Shift/Win не различаются;
// одиночная клавиша — строго та (Right Alt ≠ Left Alt), иначе обычный Ctrl+C
// запускал бы запись.
//
// События наружу: Down/Up (удерживать), Lock (нажато «закрепить»), Other (при
// зажатом сочетании нажали чужую клавишу — это системный шорткат вроде
// Ctrl+Win+→, отмена), Escape (только пока идёт диктовка; сам Esc тогда глотаем).
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
    Lock,
    Other,
    Escape,
}

pub const DEFAULT_HOTKEY: [u16; 2] = [VK_LCONTROL, VK_LWIN];
pub const DEFAULT_LOCK_HOTKEY: [u16; 3] = [VK_LCONTROL, VK_LWIN, 0x20];

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Hold,
    Lock,
}

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

static HOLD_KEYS: Mutex<Vec<u16>> = Mutex::new(Vec::new());
static LOCK_KEYS: Mutex<Vec<u16>> = Mutex::new(Vec::new());
static DOWN: [AtomicBool; 256] = [const { AtomicBool::new(false) }; 256];
static SWALLOWED: [AtomicBool; 256] = [const { AtomicBool::new(false) }; 256];
static HOLD_ACTIVE: AtomicBool = AtomicBool::new(false);
static LOCK_ACTIVE: AtomicBool = AtomicBool::new(false);
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

pub fn set_combo(kind: Kind, keys: &[u16]) {
    match kind {
        Kind::Hold => {
            *HOLD_KEYS.lock().unwrap() = keys.to_vec();
            HOLD_ACTIVE.store(false, Ordering::SeqCst);
        }
        Kind::Lock => {
            *LOCK_KEYS.lock().unwrap() = keys.to_vec();
            LOCK_ACTIVE.store(false, Ordering::SeqCst);
        }
    }
}

/// «Закрепить» не может совпадать с «удерживать» или быть его частью: иначе
/// каждое удержание сразу становилось бы закреплением.
pub fn validate_pair(hold: &[u16], lock: &[u16]) -> Result<(), String> {
    let n = |ks: &[u16]| {
        let mut v: Vec<u16> = ks.iter().map(|k| if ks.len() > 1 { normalize(*k) } else { *k }).collect();
        v.sort();
        v
    };
    let (h, l) = (n(hold), n(lock));
    if l.iter().all(|k| h.contains(k)) {
        return Err("The hands-free shortcut must add a key to the hold shortcut or be different".into());
    }
    Ok(())
}

/// Ждёт, пока юзер нажмёт и отпустит новое сочетание (Esc — отмена).
pub fn capture(timeout: std::time::Duration) -> Result<Vec<u16>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    *CAPTURE.lock().unwrap() = Some(Capture { keys: Vec::new(), done: tx });
    crate::log!("[hotkey] capture started");
    let res = rx.recv_timeout(timeout).unwrap_or_else(|_| Err("timed out".into()));
    *CAPTURE.lock().unwrap() = None;
    match &res {
        Ok(k) => crate::log!("[hotkey] captured {}", label(k)),
        Err(e) => crate::log!("[hotkey] capture ended: {e}"),
    }
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

    let hold = HOLD_KEYS.lock().unwrap().clone();
    let lock = LOCK_KEYS.lock().unwrap().clone();
    let mut swallow = false;
    let arm_masks = |combo: &[u16]| {
        if combo.iter().any(|k| normalize(*k) == VK_LWIN) {
            MASK_WIN_UP.store(true, Ordering::SeqCst);
        }
        if combo.iter().any(|k| normalize(*k) == VK_MENU) {
            MASK_ALT_UP.store(true, Ordering::SeqCst);
        }
    };

    // «Удерживать»: Down при зажатии, Up при отпускании.
    let hold_sat = satisfied(&hold);
    if hold_sat && !HOLD_ACTIVE.load(Ordering::SeqCst) {
        HOLD_ACTIVE.store(true, Ordering::SeqCst);
        arm_masks(&hold);
        emit(HotkeyEvent::Down);
    } else if !hold_sat && HOLD_ACTIVE.swap(false, Ordering::SeqCst) {
        emit(HotkeyEvent::Up);
    }
    // «Закрепить»: событие только на нажатие (переключатель).
    let lock_sat = satisfied(&lock);
    if lock_sat && !LOCK_ACTIVE.load(Ordering::SeqCst) {
        LOCK_ACTIVE.store(true, Ordering::SeqCst);
        arm_masks(&lock);
        emit(HotkeyEvent::Lock);
    } else if !lock_sat {
        LOCK_ACTIVE.store(false, Ordering::SeqCst);
    }

    let any_active = HOLD_ACTIVE.load(Ordering::SeqCst) || LOCK_ACTIVE.load(Ordering::SeqCst);
    if down && !in_combo(&hold, vk) && !in_combo(&lock, vk) {
        if any_active {
            emit(HotkeyEvent::Other);
        } else if vk == VK_ESCAPE && ACTIVE.load(Ordering::SeqCst) {
            emit(HotkeyEvent::Escape);
            return true;
        }
    }

    // Не-модификатор из сочетания (Space, Z) не должен печататься — и его автоповтор тоже.
    for (combo, active) in [(&hold, &HOLD_ACTIVE), (&lock, &LOCK_ACTIVE)] {
        if in_combo(combo, vk) && !is_modifier(vk) {
            let slot = &SWALLOWED[vk as usize & 0xFF];
            if down && (active.load(Ordering::SeqCst) || slot.load(Ordering::SeqCst)) {
                slot.store(true, Ordering::SeqCst);
                swallow = true;
            } else if !down && slot.swap(false, Ordering::SeqCst) {
                swallow = true;
            }
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

pub fn start(tx: UnboundedSender<HotkeyEvent>, hold: &[u16], lock: &[u16]) {
    let _ = SENDER.set(tx);
    set_combo(Kind::Hold, hold);
    set_combo(Kind::Lock, lock);
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
    use std::sync::Mutex as StdMutex;
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

    /// Статические таблицы клавиш общие — тесты, которые их трогают, идут по очереди.
    static SERIAL: StdMutex<()> = StdMutex::new(());
    static EVENTS: StdMutex<Option<UnboundedReceiver<HotkeyEvent>>> = StdMutex::new(None);

    fn events() -> Vec<HotkeyEvent> {
        let mut g = EVENTS.lock().unwrap();
        if g.is_none() {
            let (tx, rx) = unbounded_channel();
            let _ = SENDER.set(tx);
            *g = Some(rx);
        }
        let mut out = vec![];
        while let Ok(e) = g.as_mut().unwrap().try_recv() {
            out.push(e);
        }
        out
    }

    const Z: u16 = 0x5A;

    #[test]
    fn hold_then_extra_key_locks_and_the_key_is_not_typed() {
        let _g = SERIAL.lock().unwrap();
        events();
        // Без Alt/Win: их отпускание вбрасывает настоящие клавиши через SendInput.
        set_combo(Kind::Hold, &[VK_LCONTROL, VK_LSHIFT]);
        set_combo(Kind::Lock, &[VK_LCONTROL, VK_LSHIFT, Z]);
        assert!(!handle(VK_LCONTROL, true));
        assert!(!handle(VK_LSHIFT, true));
        assert_eq!(events(), vec![HotkeyEvent::Down]);
        assert!(handle(Z, true), "Z must be swallowed");
        assert!(handle(Z, true), "auto-repeat swallowed too");
        assert_eq!(events(), vec![HotkeyEvent::Lock]);
        assert!(handle(Z, false));
        handle(VK_LSHIFT, false);
        handle(VK_LCONTROL, false);
        assert_eq!(events(), vec![HotkeyEvent::Up]);
        // Посторонняя клавиша при зажатом «удерживать» — чужой шорткат.
        handle(VK_LCONTROL, true);
        handle(VK_LSHIFT, true);
        handle(0x41, true);
        assert_eq!(events(), vec![HotkeyEvent::Down, HotkeyEvent::Other]);
        handle(0x41, false);
        handle(VK_LSHIFT, false);
        handle(VK_LCONTROL, false);
        events();
    }

    #[test]
    fn capture_works_repeatedly() {
        let _g = SERIAL.lock().unwrap();
        events();
        for keys in [[VK_LCONTROL, VK_LSHIFT, Z], [VK_RCONTROL, VK_LSHIFT, 0x20]] {
            let t = std::thread::spawn(|| capture(std::time::Duration::from_secs(3)));
            std::thread::sleep(std::time::Duration::from_millis(50));
            for k in keys {
                assert!(handle(k, true), "captured keys are swallowed");
            }
            for k in keys.iter().rev() {
                handle(*k, false);
            }
            assert_eq!(t.join().unwrap().unwrap(), keys.to_vec());
        }
        assert!(events().is_empty(), "capture must not trigger dictation");
    }

    #[test]
    fn hands_free_must_differ_from_hold() {
        assert!(validate_pair(&[VK_LMENU], &[VK_LMENU, Z]).is_ok());
        assert!(validate_pair(&[VK_LMENU, Z], &[VK_RMENU, Z]).is_err());
        assert!(validate_pair(&[VK_LCONTROL, VK_LWIN, 0x20], &[VK_LCONTROL, VK_LWIN]).is_err());
    }

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
        let _g = SERIAL.lock().unwrap();
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
