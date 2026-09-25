// Skriptly для Windows: голосовая диктовка в любое приложение.
// Живёт в трее; окно настроек — вход, язык, чистка текста, микрофон, автозапуск.
mod api;
mod audio;
mod auth;
mod calls;
mod config;
mod dictation;
mod hotkey;
#[macro_use]
mod log;
mod media;
mod mic;
mod overlay;
mod paste;
mod recorder;
mod state;
mod stt;
mod store;

use serde_json::{json, Value};
use state::AppState;
use std::sync::Arc;
use store::Settings;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;

type AppStateArc = Arc<AppState>;

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
async fn get_state(state: State<'_, AppStateArc>) -> Result<Value, String> {
    crate::log!("[ui] get_state");
    let session = state.session.lock().await.clone();
    Ok(json!({
        "signed_in": session.is_some(),
        "email": session.map(|s| s.email).unwrap_or_default(),
        "settings": state.settings(),
        "mics": audio::list_devices(),
        "version": env!("CARGO_PKG_VERSION"),
        "redirect_url": auth::redirect_url(),
        "hotkey": hotkey::label(&state.settings().hotkey),
        "lock_hotkey": hotkey::label(&state.settings().lock_hotkey),
        "call": call_status(&state),
        "pending": pending_calls(&state),
    }))
}

// ── Шорткат диктовки ─────────────────────────────────────────────────────

fn tray_tooltip(state: &AppState) -> String {
    if state.call.lock().unwrap().is_some() {
        "Skriptly — recording a call".into()
    } else {
        format!("Skriptly — hold {} to dictate", hotkey::label(&state.settings().hotkey))
    }
}

fn refresh_tray(app: &AppHandle, state: &AppState) {
    let recording = state.call.lock().unwrap().is_some();
    if let Some(item) = state.tray_call_item.lock().unwrap().as_ref() {
        let _ = item.set_text(if recording { "Stop call recording" } else { "Record a call" });
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(tray_tooltip(state)));
    }
}

fn kind_of(kind: &str) -> hotkey::Kind {
    if kind == "lock" { hotkey::Kind::Lock } else { hotkey::Kind::Hold }
}

fn hotkeys_json(state: &AppState) -> Value {
    let s = state.settings();
    json!({ "hotkey": hotkey::label(&s.hotkey), "lock_hotkey": hotkey::label(&s.lock_hotkey) })
}

fn apply_hotkey(app: &AppHandle, state: &AppState, kind: hotkey::Kind, keys: Vec<u16>) -> Result<Value, String> {
    let mut s = state.settings();
    let (hold, lock) = match kind {
        hotkey::Kind::Hold => (keys.clone(), s.lock_hotkey.clone()),
        hotkey::Kind::Lock => (s.hotkey.clone(), keys.clone()),
    };
    hotkey::validate_pair(&hold, &lock)?;
    hotkey::set_combo(kind, &keys);
    match kind {
        hotkey::Kind::Hold => s.hotkey = keys,
        hotkey::Kind::Lock => s.lock_hotkey = keys,
    }
    state.store.save_settings(&s);
    *state.settings.lock().unwrap() = s;
    refresh_tray(app, state);
    Ok(hotkeys_json(state))
}

/// Ждёт, пока юзер нажмёт новое сочетание (клавиши в это время никуда не уходят).
/// kind: "hold" — удерживать, "lock" — закрепить.
#[tauri::command]
async fn capture_hotkey(app: AppHandle, state: State<'_, AppStateArc>, kind: String) -> Result<Value, String> {
    let keys = tauri::async_runtime::spawn_blocking(|| hotkey::capture(std::time::Duration::from_secs(15)))
        .await
        .map_err(|e| e.to_string())??;
    let res = apply_hotkey(&app, &state, kind_of(&kind), keys.clone());
    crate::log!("[hotkey] {kind} → {}: {}", hotkey::label(&keys), if res.is_ok() { "saved" } else { "rejected" });
    res
}

#[tauri::command]
fn cancel_hotkey_capture() {
    hotkey::cancel_capture();
}

#[tauri::command]
fn reset_hotkey(app: AppHandle, state: State<'_, AppStateArc>, kind: String) -> Result<Value, String> {
    let keys = match kind_of(&kind) {
        hotkey::Kind::Hold => hotkey::DEFAULT_HOTKEY.to_vec(),
        hotkey::Kind::Lock => hotkey::DEFAULT_LOCK_HOTKEY.to_vec(),
    };
    apply_hotkey(&app, &state, kind_of(&kind), keys)
}

// ── Словарь (общий с вебом: user_profiles.vocabulary) ─────────────────────

/// Термины словаря: подсказки распознаванию (context.terms у Soniox) и чистке текста.
#[tauri::command]
async fn get_vocabulary(state: State<'_, AppStateArc>) -> Result<Value, String> {
    Ok(api::profile(&state).await.and_then(|p| p.get("vocabulary").cloned()).unwrap_or(json!([])))
}

#[tauri::command]
async fn save_vocabulary(state: State<'_, AppStateArc>, vocabulary: Value) -> Result<(), String> {
    api::save_vocabulary(&state, vocabulary).await?;
    api::forget_token(&state).await; // словарь зашит в ключ Soniox (context) — берём новый
    Ok(())
}

// ── Запись созвона ───────────────────────────────────────────────────────

fn call_status(state: &AppState) -> Value {
    match state.call.lock().unwrap().as_ref() {
        Some(r) => json!({ "recording": true, "seconds": r.started.elapsed().as_secs_f64(), "system_audio": r.has_system_audio }),
        None => json!({ "recording": false }),
    }
}

fn pending_calls(state: &AppState) -> Value {
    if state.call.lock().unwrap().is_some() {
        return json!([]); // файл идущей записи — ещё не «неотправленный»
    }
    json!(recorder::pending(state.store.dir())
        .into_iter()
        .map(|f| json!({ "id": f.id, "seconds": f.seconds }))
        .collect::<Vec<_>>())
}

fn process_call(app: &AppHandle, state: &AppStateArc, f: recorder::Finished) {
    let (app, state) = (app.clone(), state.clone());
    tauri::async_runtime::spawn(async move {
        let id = f.id.clone();
        match calls::process(app.clone(), state.clone(), f).await {
            Ok(tid) => calls::emit(&app, "done", json!({ "id": id, "transcript_id": tid })),
            Err(e) => {
                crate::log!("[call] {id} failed: {e}");
                calls::emit(&app, "error", json!({ "id": id, "message": e }));
            }
        }
    });
}

pub fn start_call(app: &AppHandle, state: &AppStateArc) -> Result<(), String> {
    if state.store.session().is_none() {
        show_main(app);
        return Err("Sign in to Skriptly first".into());
    }
    let mut call = state.call.lock().unwrap();
    if call.is_some() {
        return Ok(());
    }
    let rec = recorder::start(state.store.dir(), state.settings().mic)?;
    let (mic, sys, started, system_audio) = (rec.mic_level.clone(), rec.sys_level.clone(), rec.started, rec.has_system_audio);
    *call = Some(rec);
    drop(call);
    refresh_tray(app, state);
    calls::emit(app, "recording", json!({ "seconds": 0, "system_audio": system_audio }));
    let (a, st) = (app.clone(), state.clone());
    tauri::async_runtime::spawn(async move {
        use std::sync::atomic::Ordering;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            if st.call.lock().unwrap().is_none() {
                break;
            }
            let _ = a.emit("call-level", json!({
                "mic": f32::from_bits(mic.load(Ordering::Relaxed)),
                "sys": f32::from_bits(sys.load(Ordering::Relaxed)),
                "seconds": started.elapsed().as_secs_f64(),
            }));
        }
    });
    Ok(())
}

pub async fn stop_call(app: &AppHandle, state: &AppStateArc, process: bool) -> Result<(), String> {
    let rec = state.call.lock().unwrap().take();
    let Some(rec) = rec else { return Ok(()) };
    refresh_tray(app, state);
    let f = tauri::async_runtime::spawn_blocking(move || rec.stop()).await.map_err(|e| e.to_string())??;
    if process {
        process_call(app, state, f);
    }
    Ok(())
}

#[tauri::command]
fn call_start(app: AppHandle, state: State<'_, AppStateArc>) -> Result<(), String> {
    start_call(&app, &state)
}

#[tauri::command]
async fn call_stop(app: AppHandle, state: State<'_, AppStateArc>) -> Result<(), String> {
    stop_call(&app, &state, true).await
}

#[tauri::command]
fn call_retry(app: AppHandle, state: State<'_, AppStateArc>, id: String) -> Result<(), String> {
    let f = recorder::pending(state.store.dir()).into_iter().find(|f| f.id == id).ok_or("recording not found")?;
    process_call(&app, &state, f);
    Ok(())
}

#[tauri::command]
fn call_discard(state: State<'_, AppStateArc>, id: String) {
    let dir = recorder::recordings_dir(state.store.dir());
    for ext in ["wav", "ogg"] {
        let _ = std::fs::remove_file(dir.join(format!("call-{id}.{ext}")));
    }
    crate::log!("[call] discarded {id}");
}

#[tauri::command]
fn open_transcript(id: String) {
    let _ = tauri_plugin_opener::open_url(format!("{}?entry={}", config::WEB_APP, urlencoding::encode(&id)), None::<&str>);
}

#[tauri::command]
async fn get_profile(state: State<'_, AppStateArc>) -> Result<Value, String> {
    Ok(api::profile(&state).await.unwrap_or(Value::Null))
}

async fn after_sign_in(app: &AppHandle, state: &AppStateArc) {
    let _ = app.emit("auth-changed", true);
    // Прогреваем ключ Soniox, чтобы первая диктовка стартовала сразу.
    let lang = state.settings().language;
    if let Err(e) = api::live_token(state, &lang).await {
        crate::log!("[token] prefetch failed: {e:?}");
    }
}

#[tauri::command]
async fn sign_in_google(app: AppHandle, state: State<'_, AppStateArc>) -> Result<String, String> {
    let s = auth::sign_in(&state, auth::Method::Google).await?;
    after_sign_in(&app, &state).await;
    Ok(s.email)
}

#[tauri::command]
async fn sign_in_email(app: AppHandle, state: State<'_, AppStateArc>, email: String) -> Result<String, String> {
    let email = email.trim().to_string();
    if !email.contains('@') {
        return Err("Enter a valid email".into());
    }
    let s = auth::sign_in(&state, auth::Method::Email(email)).await?;
    after_sign_in(&app, &state).await;
    Ok(s.email)
}

#[tauri::command]
async fn sign_out(app: AppHandle, state: State<'_, AppStateArc>) -> Result<(), String> {
    auth::sign_out(&state).await;
    let _ = app.emit("auth-changed", false);
    Ok(())
}

#[tauri::command]
async fn save_settings(app: AppHandle, state: State<'_, AppStateArc>, settings: Settings) -> Result<(), String> {
    // Шорткат меняется только через capture/reset_hotkey: окно держит копию
    // настроек, снятую до смены, и иначе затирало новый шорткат старым.
    let mut settings = settings;
    settings.hotkey = state.settings().hotkey;
    let lang_changed = state.settings().language != settings.language;
    state.store.save_settings(&settings);
    apply_autostart(&app, settings.autostart);
    overlay::set_bar(&app, settings.show_bar);
    let (warm, mic_name) = (settings.instant_start, settings.mic.clone());
    std::thread::spawn(move || mic::set_warm(warm, mic_name)); // открытие устройства — не в UI-потоке
    *state.settings.lock().unwrap() = settings;
    if lang_changed {
        api::forget_token(&state).await; // language_hints зашиты в ключ
    }
    Ok(())
}

#[tauri::command]
fn open_web(app: AppHandle) {
    let _ = tauri_plugin_opener::open_url(config::WEB_APP, None::<&str>);
    let _ = app;
}

#[tauri::command]
fn open_log_folder(state: State<'_, AppStateArc>) {
    let _ = tauri_plugin_opener::open_path(state.store.dir().to_string_lossy().to_string(), None::<&str>);
}

fn apply_autostart(app: &AppHandle, on: bool) {
    let al = app.autolaunch();
    // disable() без записи в автозагрузке — не ошибка.
    let res = if on { al.enable() } else if al.is_enabled().unwrap_or(false) { al.disable() } else { Ok(()) };
    if let Err(e) = res {
        crate::log!("[autostart] {e}");
    }
}

fn build_tray(app: &tauri::App, state: AppStateArc) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Settings", true, None::<&str>)?;
    let call = MenuItem::with_id(app, "call", "Record a call", true, None::<&str>)?;
    let copy = MenuItem::with_id(app, "copy_last", "Copy last dictation", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Skriptly", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&call, &open, &copy, &quit])?;
    *state.tray_call_item.lock().unwrap() = Some(call);
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("icon"))
        .tooltip(tray_tooltip(&state))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "call" => {
                let (app, st) = (app.clone(), state.clone());
                tauri::async_runtime::spawn(async move {
                    let recording = st.call.lock().unwrap().is_some();
                    let res = if recording { stop_call(&app, &st, true).await } else { start_call(&app, &st) };
                    if let Err(e) = res {
                        calls::emit(&app, "error", json!({ "message": e }));
                        show_main(&app);
                    }
                });
            }
            "copy_last" => paste::copy(&state.last_text.lock().unwrap()),
            "quit" => {
                // Идущую запись не теряем: файл остаётся, отправить можно после перезапуска.
                let (app, st) = (app.clone(), state.clone());
                tauri::async_runtime::spawn(async move {
                    let _ = stop_call(&app, &st, false).await;
                    app.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// %APPDATA%\io.skriptly.desktop — то же, что app_config_dir(), но доступно до
/// setup(): окна из конфига грузятся раньше setup и сразу зовут get_state,
/// поэтому состояние регистрируется на билдере.
fn config_dir() -> std::path::PathBuf {
    let base = std::env::var_os("APPDATA").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("io.skriptly.desktop")
}

pub fn run() {
    let dir = config_dir();
    let store = store::Store::new(dir.clone());
    log::init(&dir);
    crate::log!("[app] Skriptly {} starting", env!("CARGO_PKG_VERSION"));
    let state: AppStateArc = Arc::new(AppState::new(store));

    tauri::Builder::default()
        .manage(state.clone())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            overlay::setup(app.handle(), state.settings().show_bar);
            build_tray(app, state.clone())?;

            let settings = state.settings();
            if settings.instant_start {
                let m = settings.mic.clone();
                std::thread::spawn(move || mic::set_warm(true, m));
            }
            let valid = |k: &Vec<u16>, d: &[u16]| if hotkey::validate(k).is_ok() { k.clone() } else { d.to_vec() };
            let hold = valid(&settings.hotkey, &hotkey::DEFAULT_HOTKEY);
            let mut lock = valid(&settings.lock_hotkey, &hotkey::DEFAULT_LOCK_HOTKEY);
            if hotkey::validate_pair(&hold, &lock).is_err() {
                lock = hotkey::DEFAULT_LOCK_HOTKEY.to_vec();
            }
            crate::log!("[hotkey] hold={} lock={}", hotkey::label(&hold), hotkey::label(&lock));
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            hotkey::start(tx, &hold, &lock);
            dictation::spawn(app.handle().clone(), state.clone(), rx);

            apply_autostart(app.handle(), settings.autostart);

            // Автозапуск с Windows (--hidden) — тихо в трей; ручной запуск или
            // не залогинен — показываем окно.
            let hidden = std::env::args().any(|a| a == "--hidden");
            let signed_in = state.store.session().is_some();
            if !hidden || !signed_in {
                show_main(app.handle());
            }
            if signed_in {
                let (h, st) = (app.handle().clone(), state.clone());
                tauri::async_runtime::spawn(async move { after_sign_in(&h, &st).await });
            }
            // Только debug: SKRIPTLY_DEMO_OVERLAY=1 показывает плашку без хоткея
            // (синтетические нажатия хук игнорирует намеренно).
            #[cfg(debug_assertions)]
            if std::env::var_os("SKRIPTLY_DEMO_OVERLAY").is_some() {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // покой (1.2 с, overlay::setup) → «готовлюсь» (5 с) → запись (8 с) → покой (11 с)
                    tokio::time::sleep(std::time::Duration::from_millis(5000)).await;
                    overlay::emit(&h, "arming", "", "");
                    let _ = overlay::show(&h);
                    tokio::time::sleep(std::time::Duration::from_millis(3000)).await;
                    overlay::emit(&h, "listening", "", "");
                    overlay::level(&h, 0.05);
                    tokio::time::sleep(std::time::Duration::from_millis(3000)).await;
                    overlay::rest(&h);
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Крестик прячет окно в трей — диктовка продолжает работать.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            get_profile,
            sign_in_google,
            sign_in_email,
            sign_out,
            save_settings,
            open_web,
            open_log_folder,
            capture_hotkey,
            cancel_hotkey_capture,
            reset_hotkey,
            get_vocabulary,
            save_vocabulary,
            call_start,
            call_stop,
            call_retry,
            call_discard,
            open_transcript
        ])
        .run(tauri::generate_context!())
        .expect("error while running Skriptly");
}
