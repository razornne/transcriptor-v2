// Skriptly для Windows: голосовая диктовка в любое приложение.
// Живёт в трее; окно настроек — вход, язык, чистка текста, микрофон, автозапуск.
mod api;
mod audio;
mod auth;
mod config;
mod dictation;
mod hotkey;
#[macro_use]
mod log;
mod overlay;
mod paste;
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
    }))
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
    let lang_changed = state.settings().language != settings.language;
    state.store.save_settings(&settings);
    apply_autostart(&app, settings.autostart);
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
    let copy = MenuItem::with_id(app, "copy_last", "Copy last dictation", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Skriptly", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &copy, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("icon"))
        .tooltip("Skriptly — hold Ctrl + Win to dictate")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "copy_last" => paste::copy(&state.last_text.lock().unwrap()),
            "quit" => app.exit(0),
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
            overlay::setup(app.handle());
            build_tray(app, state.clone())?;

            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            hotkey::start(tx);
            dictation::spawn(app.handle().clone(), state.clone(), rx);

            let settings = state.settings();
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
                    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                    overlay::emit(&h, "listening", "Давай встретимся в четверг и обсудим ", "бюджет на рекламу");
                    let _ = overlay::show(&h);
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
            open_log_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running Skriptly");
}
