// Бэкенд Skriptly (Flask на Modal): временный ключ Soniox, учёт секунд, чистка текста.
use crate::auth;
use crate::config::API_BASE;
use crate::state::AppState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

#[derive(Deserialize, Clone, Debug)]
pub struct LiveToken {
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub language_hints: Vec<String>,
    #[serde(default)]
    pub context: Option<Value>,
    #[serde(skip)]
    pub fetched: Option<Instant>,
    #[serde(skip)]
    pub language: String,
}

/// Ключ выдаётся на час; берём новый заранее, чтобы не упереться в истечение
/// прямо на открытии сокета.
const TOKEN_TTL: Duration = Duration::from_secs(45 * 60);

#[derive(Debug)]
pub enum ApiError {
    NotSignedIn,
    NoMinutes,
    PrivacyMode,
    Unavailable,
    Other(String),
}

impl ApiError {
    pub fn user_message(&self) -> String {
        match self {
            ApiError::NotSignedIn => "Sign in to Skriptly to dictate".into(),
            ApiError::NoMinutes => "Your minutes are used up — upgrade on skriptly.io".into(),
            ApiError::PrivacyMode => "Dictation is off while Privacy Mode is on".into(),
            ApiError::Unavailable => "Dictation is temporarily unavailable".into(),
            ApiError::Other(e) => format!("Couldn't reach Skriptly: {e}"),
        }
    }
}

async fn post(state: &AppState, path: &str, body: Value, timeout: Duration) -> Result<reqwest::Response, ApiError> {
    let token = auth::access_token(state).await.map_err(|e| {
        if e == "not signed in" { ApiError::NotSignedIn } else { ApiError::Other(e) }
    })?;
    state
        .http
        .post(format!("{API_BASE}{path}"))
        .bearer_auth(token)
        .json(&body)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| ApiError::Other(e.to_string()))
}

async fn fetch_token(state: &AppState, language: &str) -> Result<LiveToken, ApiError> {
    let r = post(state, "/api/live/token", json!({ "purpose": "dictation", "language": language }),
                 Duration::from_secs(20)).await?;
    match r.status().as_u16() {
        200 => {}
        401 => return Err(ApiError::NotSignedIn),
        402 => return Err(ApiError::NoMinutes),
        403 => return Err(ApiError::PrivacyMode),
        503 => return Err(ApiError::Unavailable),
        s => return Err(ApiError::Other(format!("HTTP {s}"))),
    }
    let mut t: LiveToken = r.json().await.map_err(|e| ApiError::Other(e.to_string()))?;
    t.fetched = Some(Instant::now());
    t.language = language.to_string();
    Ok(t)
}

/// Ключ из кэша, если он свежий и для того же языка; иначе новый.
pub async fn live_token(state: &AppState, language: &str) -> Result<LiveToken, ApiError> {
    let mut guard = state.token.lock().await;
    if let Some(t) = guard.as_ref() {
        if t.language == language && t.fetched.map(|f| f.elapsed() < TOKEN_TTL).unwrap_or(false) {
            return Ok(t.clone());
        }
    }
    let t = fetch_token(state, language).await?;
    *guard = Some(t.clone());
    Ok(t)
}

pub async fn forget_token(state: &AppState) {
    *state.token.lock().await = None;
}

/// Секунды диктовки → общий лимит минут. Возвращает (использовано, лимит).
pub async fn report_usage(state: &AppState, seconds: f64) -> Option<(f64, f64)> {
    let r = post(state, "/api/dictation/usage", json!({ "seconds": seconds }), Duration::from_secs(20))
        .await
        .ok()?;
    let v: Value = r.json().await.ok()?;
    Some((v.get("minutes_used")?.as_f64()?, v.get("minutes_limit")?.as_f64()?))
}

/// Чистка текста LLM. Любая ошибка → исходный текст (вставка важнее полировки).
pub async fn cleanup(state: &AppState, text: &str, language: &str) -> String {
    let res = post(state, "/api/dictation/cleanup", json!({ "text": text, "language": language }),
                   Duration::from_secs(6)).await;
    match res {
        Ok(r) if r.status().is_success() => r
            .json::<Value>()
            .await
            .ok()
            .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(str::to_string))
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| text.to_string()),
        Ok(r) => {
            crate::log!("[cleanup] HTTP {}", r.status());
            text.to_string()
        }
        Err(e) => {
            crate::log!("[cleanup] {e:?}");
            text.to_string()
        }
    }
}

pub async fn profile(state: &AppState) -> Option<Value> {
    let token = auth::access_token(state).await.ok()?;
    let r = state.http.get(format!("{API_BASE}/api/profile")).bearer_auth(token).send().await.ok()?;
    r.json().await.ok()
}
