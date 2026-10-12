// Контроллер диктовки.
//
//   Держишь «удерживать» (Ctrl+Win) — говоришь — отпустил — текст вставлен.
//   «Закрепить» (Ctrl+Win+Space, или своё — например Alt+Z) — диктовка без
//   удержания; ещё раз «закрепить» или «удерживать» — закончить. Во время удержания
//   нажатие «закрепить» переводит диктовку в закреплённую. Касание короче 0.3 с,
//   Esc или чужой шорткат (Ctrl+Win+→) — отмена.
//
// Микрофон и соединение с Soniox стартуют сразу на нажатии (параллельно),
// аудио копится, пока сокет поднимается. После отпускания: финальные токены →
// (опционально) чистка LLM → вставка → учёт секунд.
use crate::api::{self, ApiError};
use crate::hotkey::{HotkeyEvent, ACTIVE};
use crate::state::AppState;
use crate::{media, mic, overlay, paste, stt};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
use tauri::async_runtime::JoinHandle;

/// Удержание короче этого — случайное касание: ничего не распознаём и не вставляем.
const TAP_MS: u128 = 300;
/// Диктовка «включается» (плашка, пауза медиа, Soniox), только если сочетание
/// продержали столько без других клавиш. Иначе «удерживать» = Alt запускал
/// диктовку на каждом Alt+Tab и Alt+Shift (смена раскладки). Микрофон при этом
/// открывается сразу на нажатии — первые слова не теряются.
const ARM_MS: u128 = 250;
/// Потолок одной диктовки.
const MAX_DICTATION: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, PartialEq, Clone, Copy)]
enum Mode {
    Idle,
    /// Сочетание нажато, ждём ARM_MS: это диктовка или чужой шорткат?
    Pending(Instant),
    Hold(Instant),
    Locked,
    Finishing,
}

/// Микрофон, открытый на нажатии, пока не ясно, диктовка ли это.
struct Opened {
    capture: Result<mic::Session, String>,
    rx: UnboundedReceiver<Vec<i16>>,
    pressed: Instant,
}

impl Opened {
    fn discard(self) {
        if let Ok(c) = self.capture {
            c.stop();
        }
    }
}

struct Active {
    capture: Option<mic::Session>,
    stt: JoinHandle<Result<stt::Result_, String>>,
    meter: JoinHandle<()>,
    started: Instant,
}

enum Internal {
    Finished,
    Failed(String),
}

pub fn spawn(app: AppHandle, state: Arc<AppState>, mut keys: UnboundedReceiver<HotkeyEvent>) {
    tauri::async_runtime::spawn(async move {
        let (done_tx, mut done_rx) = unbounded_channel::<Internal>();
        let mut mode = Mode::Idle;
        let mut active: Option<Active> = None;
        let mut pending: Option<Opened> = None;
        let mut tick = tokio::time::interval(Duration::from_millis(50));

        loop {
            tokio::select! {
                Some(ev) = keys.recv() => {
                    match (ev, mode) {
                        (HotkeyEvent::Down, Mode::Idle) => {
                            pending = Some(open_mic(&state));
                            mode = Mode::Pending(Instant::now());
                        }
                        // Отпустили или нажали другую клавишу раньше ARM_MS (Alt+Tab,
                        // Alt+Shift) — это был не диктовка: тихо закрываем микрофон.
                        (HotkeyEvent::Up | HotkeyEvent::Other | HotkeyEvent::Escape, Mode::Pending(_)) => {
                            if let Some(p) = pending.take() { p.discard(); }
                            mode = Mode::Idle;
                        }
                        (HotkeyEvent::Lock, Mode::Pending(_)) => {
                            match start(&app, &state, pending.take().unwrap_or_else(|| open_mic(&state))).await {
                                Ok(a) => {
                                    active = Some(a);
                                    mode = Mode::Locked;
                                    overlay::emit(&app, "handsfree", "", "");
                                }
                                Err(msg) => { mode = Mode::Idle; flash(&app, "error", &msg, 2500); }
                            }
                        }
                        // «Закрепить»: с нуля — сразу без удержания; во время удержания —
                        // «защёлкнуть» (Alt → Alt+Z); в закреплённом — закончить.
                        (HotkeyEvent::Lock, Mode::Idle) => {
                            match start(&app, &state, open_mic(&state)).await {
                                Ok(a) => {
                                    active = Some(a);
                                    mode = Mode::Locked;
                                    overlay::emit(&app, "handsfree", "", "");
                                }
                                Err(msg) => flash(&app, "error", &msg, 2500),
                            }
                        }
                        (HotkeyEvent::Lock, Mode::Hold(_)) => {
                            mode = Mode::Locked;
                            overlay::emit(&app, "handsfree", "", "");
                        }
                        (HotkeyEvent::Down | HotkeyEvent::Lock, Mode::Locked) => {
                            mode = Mode::Finishing;
                            finish(&app, &state, active.take(), done_tx.clone());
                        }
                        (HotkeyEvent::Up, Mode::Hold(since)) => {
                            if since.elapsed().as_millis() < TAP_MS {
                                cancel(&app, active.take());
                                mode = Mode::Idle;
                            } else {
                                mode = Mode::Finishing;
                                finish(&app, &state, active.take(), done_tx.clone());
                            }
                        }
                        (HotkeyEvent::Other | HotkeyEvent::Escape, Mode::Hold(_) | Mode::Locked) => {
                            cancel(&app, active.take());
                            mode = Mode::Idle;
                        }
                        _ => {}
                    }
                }
                Some(msg) = done_rx.recv() => {
                    mode = Mode::Idle;
                    ACTIVE.store(false, Ordering::SeqCst);
                    if let Internal::Failed(e) = msg { crate::log!("[dictation] failed: {e}"); }
                }
                _ = tick.tick() => {
                    match mode {
                        Mode::Pending(since) if since.elapsed().as_millis() >= ARM_MS => {
                            match pending.take() {
                                Some(p) => match start(&app, &state, p).await {
                                    Ok(a) => { active = Some(a); mode = Mode::Hold(since); }
                                    Err(msg) => { mode = Mode::Idle; flash(&app, "error", &msg, 2500); }
                                },
                                None => mode = Mode::Idle,
                            }
                        }
                        Mode::Hold(_) | Mode::Locked if active.as_ref().map(|a| a.started.elapsed() > MAX_DICTATION).unwrap_or(false) => {
                            mode = Mode::Finishing;
                            finish(&app, &state, active.take(), done_tx.clone());
                        }
                        _ => {}
                    }
                }
            }
        }
    });
}

fn open_mic(state: &Arc<AppState>) -> Opened {
    let pressed = Instant::now();
    let (tx, rx) = unbounded_channel::<Vec<i16>>();
    let capture = mic::open(state.settings().mic.clone(), tx);
    Opened { capture, rx, pressed }
}

/// Ошибки (не вошёл, микрофон) показываем только здесь — когда ясно, что это
/// диктовка, а не Alt+Tab.
async fn start(app: &AppHandle, state: &Arc<AppState>, opened: Opened) -> Result<Active, String> {
    if state.session.lock().await.is_none() {
        opened.discard();
        crate::show_main(app);
        return Err(ApiError::NotSignedIn.user_message());
    }
    let settings = state.settings();
    let Opened { capture, rx, pressed } = opened;
    let capture = capture.map_err(|e| {
        crate::log!("[audio] {e}");
        format!("Microphone problem: {e}")
    })?;
    ACTIVE.store(true, Ordering::SeqCst);
    if settings.pause_media {
        tauri::async_runtime::spawn_blocking(media::pause_playing);
    }
    // «arming» — микрофон ещё не отдал звук (BT-гарнитура переключается в режим
    // звонка); красная точка загорается, только когда звук реально пошёл.
    let ready = capture.got_audio.load(Ordering::Relaxed);
    overlay::emit(app, if ready { "listening" } else { "arming" }, "", "");
    let _ = overlay::show(app);

    let rate = capture.rate;
    let (a, st, langs) = (app.clone(), state.clone(), settings.languages.clone());
    let stt = tauri::async_runtime::spawn(async move {
        let token = api::live_token(&st, &langs).await.map_err(|e| {
            let msg = e.user_message();
            if matches!(e, ApiError::NotSignedIn) {
                crate::show_main(&a);
            }
            overlay::emit(&a, "error", &msg, ""); // сразу, а не после отпускания клавиш
            msg
        })?;
        // Слова на плашке не показываем — только анимация записи.
        let res = stt::run(token, rate, rx, |_, _| {}).await;
        if res.is_err() {
            api::forget_token(&st).await; // ключ мог протухнуть/отозваться — следующий раз возьмём новый
        }
        res
    });

    let a = app.clone();
    let (level, got) = (capture.level.clone(), capture.got_audio.clone());
    let meter = tauri::async_runtime::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_millis(60));
        let mut armed = ready;
        loop {
            t.tick().await;
            if !armed && got.load(Ordering::Relaxed) {
                armed = true;
                crate::log!("[dictation] first audio {} ms after the shortcut", pressed.elapsed().as_millis());
                overlay::emit(&a, "listening", "", "");
            }
            overlay::level(&a, f32::from_bits(level.load(Ordering::Relaxed)));
        }
    });
    crate::log!("[dictation] start mic='{}' rate={rate} instant={}", capture.device, mic::is_warm());
    Ok(Active { capture: Some(capture), stt, meter, started: Instant::now() })
}

fn cancel(app: &AppHandle, active: Option<Active>) {
    if let Some(mut a) = active {
        if let Some(c) = a.capture.take() {
            c.stop();
        }
        a.stt.abort();
        a.meter.abort();
    }
    ACTIVE.store(false, Ordering::SeqCst);
    overlay::rest(app);
    tauri::async_runtime::spawn_blocking(media::resume);
}

fn flash(app: &AppHandle, state: &str, text: &str, ms: u64) {
    overlay::emit(app, state, text, "");
    let gen = overlay::show(app);
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        overlay::rest_if(&a, gen);
    });
}

fn finish(
    app: &AppHandle,
    state: &Arc<AppState>,
    active: Option<Active>,
    done: tokio::sync::mpsc::UnboundedSender<Internal>,
) {
    let Some(mut a) = active else {
        let _ = done.send(Internal::Finished);
        return;
    };
    if let Some(c) = a.capture.take() {
        c.stop(); // → конец аудио → Soniox дофинализирует и пришлёт "finished"
    }
    a.meter.abort();
    overlay::emit(app, "finishing", "", "");
    let (app, state) = (app.clone(), state.clone());
    tauri::async_runtime::spawn(async move {
        let t0 = Instant::now();
        let result = match a.stt.await {
            Ok(r) => r,
            Err(e) => Err(e.to_string()),
        };
        let res = match result {
            Err(msg) => {
                flash(&app, "error", &msg, 3000);
                Internal::Failed(msg)
            }
            Ok(r) if r.text.is_empty() => {
                report(&state, &app, r.audio_seconds);
                flash(&app, "empty", "Didn't catch that", 1200);
                Internal::Finished
            }
            Ok(r) => {
                let settings = state.settings();
                let mut text = r.text.clone();
                if settings.cleanup && text.split_whitespace().count() >= 3 {
                    overlay::emit(&app, "polishing", &text, "");
                    text = api::cleanup(&state, &text, &settings.language).await;
                }
                *state.last_text.lock().unwrap() = text.clone();
                let to_paste = text.clone();
                let pasted = tokio::task::spawn_blocking(move || paste::paste(&to_paste)).await;
                crate::log!(
                    "[dictation] {:.1}s audio, {} chars, finalize+cleanup {:.2}s, paste {:?}",
                    r.audio_seconds, text.len(), t0.elapsed().as_secs_f64(), pasted.as_ref().map(|p| p.is_ok())
                );
                report(&state, &app, r.audio_seconds);
                match pasted {
                    Ok(Ok(())) => {
                        flash(&app, "done", "", 700);
                        Internal::Finished
                    }
                    _ => {
                        paste::copy(&text);
                        flash(&app, "error", "Couldn't paste — the text is in your clipboard", 3000);
                        Internal::Failed("paste failed".into())
                    }
                }
            }
        };
        // Медиа — обратно, когда текст уже вставлен (или диктовка не удалась).
        tauri::async_runtime::spawn_blocking(media::resume);
        let _ = done.send(res);
    });
}

fn report(state: &Arc<AppState>, app: &AppHandle, seconds: f64) {
    if seconds < 0.5 {
        return;
    }
    let (state, app) = (state.clone(), app.clone());
    tauri::async_runtime::spawn(async move {
        if let Some(usage) = api::report_usage(&state, seconds).await {
            // Ключ Soniox кэшируется на час и лимит проверяется только при выдаче —
            // квота кончилась → забываем ключ, следующая диктовка получит 402.
            if api::dictation_exhausted(&usage) {
                api::forget_token(&state).await;
            }
            let _ = app.emit("usage", usage);
        }
    });
}
