// Skriptly для Windows: главное окно — это веб-приложение skriptly.io/app, а
// нативная часть даёт то, чего нет у браузера: диктовку в любое приложение
// (хоткей, микрофон, вставка), запись звонка (микрофон + звук компьютера) и
// сессию. Окно живёт в трее; диктовка работает, даже когда окно закрыто.
//
// Мост «веб ↔ приложение»: страница зовёт команды ниже через window.__TAURI__
// (landing/lib/ink/desktop.ts). Список команд для удалённой страницы жёстко
// ограничен: build.rs (AppManifest) + capabilities/remote.json.
mod api;
mod audio;
mod auth;
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
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;

type AppStateArc = Arc<AppState>;

/// Сколько страница «You're in» остаётся в браузере до возврата в приложение (синхронно с полоской на странице).
const SIGN_IN_PAGE_MS: u64 = 5000;

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// После входа браузер должен успеть показать страницу «You're in» (≈5 с анимации),
/// поэтому окно приложения выходит на передний план не сразу, а с задержкой.
fn show_main_later(app: &AppHandle, ms: u64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        show_main(&app);
    });
}

/// Адрес веб-приложения. `SKRIPTLY_APP_URL` — для разработки (npm run dev на localhost:3000).
fn app_url_value() -> String {
    std::env::var("SKRIPTLY_APP_URL").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| config::WEB_APP.to_string())
}

/// Куда окну можно переходить. Всё остальное (Stripe, Google, Notion…) уходит в
/// системный браузер: чужие сайты не должны получать доступ к мосту приложения.
fn allowed_nav(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "data" | "blob" => true,
        "http" | "https" => {
            let host = url.host_str().unwrap_or("");
            host == "tauri.localhost"
                || host == "skriptly.io"
                || host.ends_with(".skriptly.io")
                || (cfg!(debug_assertions) && (host == "localhost" || host == "127.0.0.1"))
        }
        _ => false,
    }
}

fn build_main_window(app: &tauri::App) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Skriptly")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .visible(false)
        .initialization_script(&format!(
            "window.__SKRIPTLY_DESKTOP__ = {{ version: '{}', platform: 'windows' }};",
            env!("CARGO_PKG_VERSION")
        ))
        .on_navigation(|url| {
            if allowed_nav(url) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https") {
                let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .build()?;
    Ok(())
}

#[tauri::command]
fn app_url() -> String {
    app_url_value()
}

/// Ссылки, которые веб хочет открыть «снаружи» (target=_blank, window.open).
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) links".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_state(state: State<'_, AppStateArc>) -> Result<Value, String> {
    let session = state.session.lock().await.clone();
    Ok(json!({
        "signed_in": session.is_some(),
        "email": session.map(|s| s.email).unwrap_or_default(),
        "settings": state.settings(),
        "mics": audio::list_devices(),
        "version": env!("CARGO_PKG_VERSION"),
        "hotkey": hotkey::label(&state.settings().hotkey),
        "lock_hotkey": hotkey::label(&state.settings().lock_hotkey),
        "default_hotkey": hotkey::label(&hotkey::DEFAULT_HOTKEY),
        "default_lock_hotkey": hotkey::label(&hotkey::DEFAULT_LOCK_HOTKEY),
        "call": call_status(&state),
    }))
}

// ── Сессия (вход через системный браузер; сессией владеет приложение) ─────

/// Свежий токен для веба. Приложение — единственный, кто обновляет refresh-токен:
/// два клиента с одним refresh-токеном разлогинивали бы друг друга при ротации.
#[tauri::command]
async fn desktop_session(state: State<'_, AppStateArc>) -> Result<Value, String> {
    match auth::access_token(&state).await {
        Ok(token) => {
            let s = state.session.lock().await.clone();
            let (id, email) = s.map(|s| (s.user_id, s.email)).unwrap_or_default();
            Ok(json!({ "signed_in": true, "access_token": token, "user": { "id": id, "email": email } }))
        }
        Err(e) if e == "not signed in" => Ok(json!({ "signed_in": false })),
        Err(e) => Err(e), // сеть/5xx — сессию не трогаем, веб попробует позже
    }
}

async fn after_sign_in(app: &AppHandle, state: &AppStateArc) {
    let _ = app.emit("auth-changed", true);
    // Прогреваем ключ Soniox, чтобы первая диктовка стартовала сразу.
    let langs = state.settings().languages;
    if let Err(e) = api::live_token(state, &langs).await {
        crate::log!("[token] prefetch failed: {e:?}");
    }
}

#[tauri::command]
async fn sign_in_google(app: AppHandle, state: State<'_, AppStateArc>) -> Result<String, String> {
    let s = auth::sign_in(&state, auth::Method::Google).await?;
    show_main_later(&app, SIGN_IN_PAGE_MS); // даём браузеру показать страницу, потом возвращаем окно приложения
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
    show_main_later(&app, SIGN_IN_PAGE_MS);
    after_sign_in(&app, &state).await;
    Ok(s.email)
}

#[tauri::command]
async fn sign_out(app: AppHandle, state: State<'_, AppStateArc>) -> Result<(), String> {
    auth::sign_out(&state).await;
    let _ = app.emit("auth-changed", false);
    Ok(())
}

/// Словарь поменялся (в вебе) — он зашит в ключ Soniox, берём новый.
#[tauri::command]
async fn forget_token(state: State<'_, AppStateArc>) -> Result<(), String> {
    api::forget_token(&state).await;
    Ok(())
}

// ── Шорткаты диктовки ────────────────────────────────────────────────────

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

/// Новое сочетание, записанное страницей (виртуальные коды клавиш).
/// Записывает окно, а не хук: пока в фокусе наше окно, Windows не зовёт наш
/// WH_KEYBOARD_LL вовсе (проверено 2026-10-12).
/// kind: "hold" — удерживать, "lock" — закрепить.
#[tauri::command]
fn set_hotkey(app: AppHandle, state: State<'_, AppStateArc>, kind: String, keys: Vec<u16>) -> Result<Value, String> {
    hotkey::validate(&keys)?;
    let res = apply_hotkey(&app, &state, kind_of(&kind), keys.clone());
    crate::log!("[hotkey] {kind} → {}: {}", hotkey::label(&keys), match &res { Ok(_) => "saved".into(), Err(e) => e.clone() });
    res
}

#[tauri::command]
fn hotkey_label(keys: Vec<u16>) -> String {
    hotkey::label(&keys)
}

#[tauri::command]
fn reset_hotkey(app: AppHandle, state: State<'_, AppStateArc>, kind: String) -> Result<Value, String> {
    let keys = match kind_of(&kind) {
        hotkey::Kind::Hold => hotkey::DEFAULT_HOTKEY.to_vec(),
        hotkey::Kind::Lock => hotkey::DEFAULT_LOCK_HOTKEY.to_vec(),
    };
    apply_hotkey(&app, &state, kind_of(&kind), keys)
}

// ── Запись созвона ───────────────────────────────────────────────────────
// Приложение только пишет: микрофон (L) + звук компьютера (R) → WAV на диск → Ogg.
// Загрузку, транскрипцию и сохранение делает веб (тот же пайплайн, что у браузерной
// записи): прогресс, лимиты, апселл, словарь — всё общее.

fn call_status(state: &AppState) -> Value {
    match state.call.lock().unwrap().as_ref() {
        Some(r) => json!({ "recording": true, "id": r.id, "seconds": r.started.elapsed().as_secs_f64(), "system_audio": r.has_system_audio }),
        None => json!({ "recording": false }),
    }
}

/// id записи приходит со страницы — пускаем только то, что мы сами выдаём (uuid).
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

pub fn start_call(app: &AppHandle, state: &AppStateArc) -> Result<Value, String> {
    let mut call = state.call.lock().unwrap();
    if let Some(r) = call.as_ref() {
        return Ok(json!({ "id": r.id, "system_audio": r.has_system_audio }));
    }
    let rec = recorder::start(state.store.dir(), state.settings().mic)?;
    let (id, mic, sys, started, system_audio) =
        (rec.id.clone(), rec.mic_level.clone(), rec.sys_level.clone(), rec.started, rec.has_system_audio);
    *call = Some(rec);
    drop(call);
    refresh_tray(app, state);
    let (a, st) = (app.clone(), state.clone());
    tauri::async_runtime::spawn(async move {
        use std::sync::atomic::Ordering;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
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
    Ok(json!({ "id": id, "system_audio": system_audio }))
}

/// Останавливает запись; `encode` — сжать в Ogg для отправки.
async fn finish_call(app: &AppHandle, state: &AppStateArc, encode: bool) -> Result<Option<recorder::Finished>, String> {
    let rec = state.call.lock().unwrap().take();
    let Some(rec) = rec else { return Ok(None) };
    refresh_tray(app, state);
    let f = tauri::async_runtime::spawn_blocking(move || rec.stop()).await.map_err(|e| e.to_string())??;
    if encode {
        encode_ogg(&f).await?;
    }
    Ok(Some(f))
}

async fn encode_ogg(f: &recorder::Finished) -> Result<std::path::PathBuf, String> {
    let ogg = f.wav.with_extension("ogg");
    let (wav, out) = (f.wav.clone(), ogg.clone());
    tauri::async_runtime::spawn_blocking(move || recorder::encode_ogg(&wav, &out))
        .await
        .map_err(|e| e.to_string())??;
    Ok(ogg)
}

#[tauri::command]
fn call_start(app: AppHandle, state: State<'_, AppStateArc>) -> Result<Value, String> {
    start_call(&app, &state)
}

#[tauri::command]
async fn call_stop(app: AppHandle, state: State<'_, AppStateArc>) -> Result<Value, String> {
    let f = finish_call(&app, &state, true).await?.ok_or("not recording")?;
    Ok(json!({ "id": f.id, "seconds": f.seconds }))
}

/// Ogg записи (сырые байты через IPC, без JSON). Файлы остаются на диске, пока веб
/// не подтвердит успешную транскрипцию (`call_discard`) — при сбое запись не теряется.
#[tauri::command]
async fn call_take(state: State<'_, AppStateArc>, id: String) -> Result<tauri::ipc::Response, String> {
    if !valid_id(&id) {
        return Err("bad id".into());
    }
    let dir = recorder::recordings_dir(state.store.dir());
    let ogg = dir.join(format!("call-{id}.ogg"));
    if !ogg.exists() {
        // запись после падения: есть только WAV
        let wav = dir.join(format!("call-{id}.wav"));
        if !wav.exists() {
            return Err("recording not found".into());
        }
        let seconds = recorder::finalize_wav(&wav).map_err(|e| e.to_string())?;
        encode_ogg(&recorder::Finished { id: id.clone(), wav, seconds }).await?;
    }
    let bytes = tokio::fs::read(&ogg).await.map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Неотправленные записи (после падения или неудачной транскрипции).
#[tauri::command]
fn call_pending(state: State<'_, AppStateArc>) -> Value {
    if state.call.lock().unwrap().is_some() {
        return json!([]); // файл идущей записи — ещё не «неотправленный»
    }
    json!(recorder::pending(state.store.dir())
        .into_iter()
        .map(|f| json!({ "id": f.id, "seconds": f.seconds }))
        .collect::<Vec<_>>())
}

#[tauri::command]
fn call_discard(state: State<'_, AppStateArc>, id: String) {
    if !valid_id(&id) {
        return;
    }
    let dir = recorder::recordings_dir(state.store.dir());
    for ext in ["wav", "ogg"] {
        let _ = std::fs::remove_file(dir.join(format!("call-{id}.{ext}")));
    }
    crate::log!("[call] discarded {id}");
}

// ── Настройки приложения ─────────────────────────────────────────────────

#[tauri::command]
async fn save_settings(app: AppHandle, state: State<'_, AppStateArc>, settings: Settings) -> Result<(), String> {
    // Шорткат меняется только через set_hotkey/reset_hotkey: страница держит копию
    // настроек, снятую до смены, и иначе затирала бы новый шорткат старым.
    let mut settings = settings;
    let current = state.settings();
    settings.hotkey = current.hotkey;
    settings.lock_hotkey = current.lock_hotkey;
    settings.normalize_languages();
    let lang_changed = current.languages != settings.languages;
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
    let open = MenuItem::with_id(app, "open", "Open Skriptly", true, None::<&str>)?;
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
            // Старт/стоп записи решает страница (лимиты, предупреждения) — просим её.
            "call" => {
                show_main(app);
                let _ = app.emit("desktop-record-toggle", ());
            }
            "copy_last" => paste::copy(&state.last_text.lock().unwrap()),
            "quit" => {
                // Идущую запись не теряем: файл остаётся, отправить можно после перезапуска.
                let (app, st) = (app.clone(), state.clone());
                tauri::async_runtime::spawn(async move {
                    let _ = finish_call(&app, &st, false).await;
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

/// %APPDATA%\io.skriptly.desktop — то же, что app_config_dir(), но доступно до setup().
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
            build_main_window(app)?;
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
            app_url,
            open_external,
            get_state,
            desktop_session,
            sign_in_google,
            sign_in_email,
            sign_out,
            forget_token,
            save_settings,
            open_log_folder,
            set_hotkey,
            hotkey_label,
            reset_hotkey,
            call_start,
            call_stop,
            call_take,
            call_pending,
            call_discard
        ])
        .run(tauri::generate_context!())
        .expect("error while running Skriptly");
}
