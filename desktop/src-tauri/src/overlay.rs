// Плашка диктовки внизу экрана (общая логика; окно и позиция — platform::overlay). В покое (настройка «Show dictation bar») — маленькая
// капсула, как у Wispr Flow; на диктовке раскрывается в анимацию записи и
// переезжает на монитор активного окна. Не забирает фокус у приложения, куда
// вставляем текст, и не ловит клики: WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
// показ через SetWindowPos(SWP_NOACTIVATE). Поверх полноэкранного окна
// (видео, игра, презентация) капсула покоя прячется.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use crate::platform::overlay as os;
use tauri::{AppHandle, Emitter, Manager};

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

/// Подпись языка на плашке записи: «AUTO», «RU», «RU+1». Обновляется при смене настроек.
static LANG: Mutex<String> = Mutex::new(String::new());

#[derive(Serialize, Clone)]
pub struct OverlayState<'a> {
    /// idle | arming | listening | handsfree | finishing | polishing | done | empty | error | learned | hidden
    /// learned: `text` — как стало правильно, `pending` — как было записано.
    pub state: &'a str,
    pub text: &'a str,
    pub pending: &'a str,
    pub lang: &'a str,
}

/// Подпись выбранных языков для плашки: пусто = автоопределение.
pub fn set_language(languages: &[String]) {
    let label = match languages {
        [] => "AUTO".to_string(),
        [one] => one.to_uppercase(),
        [first, rest @ ..] => format!("{}+{}", first.to_uppercase(), rest.len()),
    };
    *LANG.lock().unwrap() = label;
}

/// Короткое сообщение поверх покоя (например «добавлено в словарь»). Если плашка занята
/// диктовкой или другим сообщением — молчим: оно не должно перебивать запись.
pub fn toast(app: &AppHandle, state: &str, text: &str, pending: &str, ms: u64) {
    if BUSY.load(Ordering::SeqCst) {
        return;
    }
    emit(app, state, text, pending);
    let gen = show(app);
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        rest_if(&a, gen);
    });
}

pub fn setup(app: &AppHandle, bar: bool) {
    os::prepare(app);
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
    let full = os::foreground_is_fullscreen();
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
        os::raise(app);
    }
}

/// `big` — окно под раскрытую плашку, иначе — под капсулу покоя.
fn place(app: &AppHandle, big: bool) {
    os::place(app, if big { BIG } else { SMALL }, CENTER_FROM_BOTTOM);
}

fn raw_hide(app: &AppHandle) {
    os::hide(app);
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
    if BAR.load(Ordering::SeqCst) && !os::foreground_is_fullscreen() {
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
    let lang = LANG.lock().unwrap().clone();
    let _ = app.emit_to(LABEL, "overlay", OverlayState { state, text, pending, lang: &lang });
}

/// Спектр речи (дБ по полосам) для волны на плашке.
pub fn bands(app: &AppHandle, bands: &[f32]) {
    let _ = app.emit_to(LABEL, "overlay-bands", bands);
}

pub fn level(app: &AppHandle, level: f32) {
    let _ = app.emit_to(LABEL, "overlay-level", level);
}
