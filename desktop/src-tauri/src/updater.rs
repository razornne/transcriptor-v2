// Автообновление: проверяем при старте и раз в несколько часов; если вышла версия и
// мы не заняты (не диктуем и не пишем звонок) — качаем, проверяем подпись и ставим.
// Установщик (NSIS, passive) сам закрывает приложение и запускает новое.
// Сервер: GET /api/desktop/update/<target>/<arch>/<current> → 200 + манифест или 204.
// Подпись — ключ в ~/.tauri/skriptly-updater.key (публичная часть — в tauri.conf.json).
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

const FIRST_CHECK: Duration = Duration::from_secs(45);
const EVERY: Duration = Duration::from_secs(6 * 3600);
const RETRY_BUSY: Duration = Duration::from_secs(120);

static RUNNING: AtomicBool = AtomicBool::new(false);

pub enum Outcome {
    Latest,
    /// Версия есть, но сейчас идёт диктовка или запись звонка.
    Busy(String),
    /// Установщик запущен — приложение сейчас закроется и откроется заново.
    Installing(String),
}

fn busy(state: &AppState) -> bool {
    crate::hotkey::ACTIVE.load(Ordering::SeqCst) || state.call.lock().unwrap().is_some()
}

/// `force` — проверка по кнопке: ставим, даже если идёт диктовка не должно быть, поэтому
/// force лишь пропускает ожидание, но занятость всё равно уважаем (потерять запись нельзя).
pub async fn check(app: &AppHandle, state: &Arc<AppState>) -> Result<Outcome, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(Outcome::Latest);
    }
    let res = run(app, state).await;
    RUNNING.store(false, Ordering::SeqCst);
    res
}

async fn run(app: &AppHandle, state: &Arc<AppState>) -> Result<Outcome, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(Outcome::Latest);
    };
    let version = update.version.clone();
    if busy(state) {
        return Ok(Outcome::Busy(version));
    }
    crate::log!("[update] {} → {version}: downloading", update.current_version);
    // Проверка трассы без установки (SKRIPTLY_UPDATE_DRYRUN=1): скачивает и проверяет подпись.
    if std::env::var_os("SKRIPTLY_UPDATE_DRYRUN").is_some() {
        let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
        crate::log!("[update] dry run: {version} downloaded and signature verified ({} bytes)", bytes.len());
        return Ok(Outcome::Latest);
    }
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    crate::log!("[update] {version}: installer started");
    Ok(Outcome::Installing(version))
}

pub fn outcome_json(o: &Outcome) -> Value {
    match o {
        Outcome::Latest => json!({ "status": "latest" }),
        Outcome::Busy(v) => json!({ "status": "busy", "version": v }),
        Outcome::Installing(v) => json!({ "status": "installing", "version": v }),
    }
}

/// Фоновый цикл. Ошибки (нет сети, сервер недоступен) — в лог и до следующего раза.
pub fn spawn(app: AppHandle, state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            let wait = match check(&app, &state).await {
                Ok(Outcome::Busy(v)) => {
                    crate::log!("[update] {v} is available, busy now");
                    RETRY_BUSY
                }
                Ok(_) => EVERY,
                Err(e) => {
                    crate::log!("[update] check failed: {e}");
                    EVERY
                }
            };
            tokio::time::sleep(wait).await;
        }
    });
}
