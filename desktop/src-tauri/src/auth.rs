// Вход через системный браузер (Google или magic link) по PKCE: приложение
// получает СВОЮ сессию Supabase, не общую с вебом (общий refresh-токен
// разлогинивал бы одну из сторон при ротации).
//
// 1) генерим code_verifier/challenge; 2) поднимаем http://127.0.0.1:53682/callback;
// 3) браузер: Supabase → Google/письмо → редирект на callback с ?code=;
// 4) меняем code + verifier на сессию (grant_type=pkce).
use crate::config::{LOOPBACK_PORTS, SUPABASE_ANON_KEY, SUPABASE_URL};
use crate::state::AppState;
use crate::store::Session;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::Rng;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub enum Method {
    Google,
    Email(String),
}

static CURRENT: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn pkce_pair() -> (String, String) {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::thread_rng();
    let verifier: String = (0..64).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub fn redirect_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/callback")
}

const ERROR_PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>Skriptly</title>
<meta name="color-scheme" content="light dark">
<body style="font-family:Manrope,Segoe UI,sans-serif;background:#F6F4EE;color:#14120E;display:grid;place-items:center;height:90vh;margin:0">
<div style="text-align:center;max-width:460px;padding:24px"><h2 style="font-size:28px;margin:0 0 8px">%TITLE%</h2><p style="color:#6B6557;margin:0">%BODY%</p></div>"#;

/// Страница после входа (вариант A из макета): шаблон `signed_in.html`, в него
/// подставляются почта и подпись шортката диктовки (как он настроен у пользователя).
const SIGNED_IN_PAGE: &str = include_str!("signed_in.html");

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn html_response(html: String) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_string(html)
        .with_header("Content-Type: text/html; charset=utf-8".parse::<tiny_http::Header>().unwrap())
}

fn page(title: &str, body: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    html_response(ERROR_PAGE.replace("%TITLE%", &html_escape(title)).replace("%BODY%", &html_escape(body)))
}

fn signed_in_page(email: &str, hotkey_label: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let keys: String = hotkey_label
        .split(" + ")
        .enumerate()
        .map(|(i, k)| format!("{}<kbd>{}</kbd>", if i > 0 { "<span class=\"plus\">+</span>" } else { "" }, html_escape(k)))
        .collect();
    html_response(SIGNED_IN_PAGE.replace("__EMAIL__", &html_escape(email)).replace("__KEYS__", &keys))
}

/// Ждём редирект браузера на loopback. Отменяется новым входом.
/// Запрос с кодом НЕ закрываем: ответ (страница «вы вошли») отдаём после обмена кода на сессию,
/// чтобы показать почту.
/// Поднимает loopback-сервер на первом доступном порту из списка. Прошлый вход мог ещё держать
/// порт — даём ему до 3 с освободиться; недоступный порт (зарезервирован Windows) пропускаем.
fn bind_loopback() -> Result<(tiny_http::Server, u16), String> {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut last = String::new();
    loop {
        for port in LOOPBACK_PORTS {
            match tiny_http::Server::http(("127.0.0.1", port)) {
                Ok(s) => return Ok((s, port)),
                Err(e) => last = format!("{port}: {e}"),
            }
        }
        if Instant::now() > deadline {
            return Err(format!("no free local port for sign-in ({last})"));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn wait_for_code(server: tiny_http::Server, cancel: Arc<AtomicBool>) -> Result<(String, tiny_http::Request), String> {
    let until = Instant::now() + Duration::from_secs(15 * 60);
    while Instant::now() < until {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        let Ok(Some(req)) = server.recv_timeout(Duration::from_millis(300)) else { continue };
        let url = req.url().to_string();
        if !url.starts_with("/callback") {
            let _ = req.respond(tiny_http::Response::empty(404));
            continue;
        }
        let query = url.split_once('?').map(|(_, q)| q.to_string()).unwrap_or_default();
        let param = |k: &str| -> Option<String> {
            query.split('&').find_map(|kv| {
                let (a, b) = kv.split_once('=')?;
                if a != k {
                    return None;
                }
                Some(urlencoding::decode(&b.replace('+', " ")).map(|s| s.into_owned()).unwrap_or_default())
            })
        };
        if let Some(code) = param("code") {
            return Ok((code, req));
        }
        let err = param("error_description").or_else(|| param("error")).unwrap_or_else(|| "no code".into());
        let _ = req.respond(page("Sign-in failed", &err));
        return Err(err);
    }
    Err("sign-in timed out".into())
}

fn session_from(v: &Value) -> Result<Session, String> {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let user = v.get("user").cloned().unwrap_or(Value::Null);
    Ok(Session {
        access_token: s("access_token").ok_or("no access_token")?,
        refresh_token: s("refresh_token").ok_or("no refresh_token")?,
        expires_at: now() + v.get("expires_in").and_then(|x| x.as_i64()).unwrap_or(3600),
        email: user.get("email").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        user_id: user.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
    })
}

async fn token_request(state: &AppState, grant: &str, body: Value) -> Result<Session, String> {
    let r = state
        .http
        .post(format!("{SUPABASE_URL}/auth/v1/token?grant_type={grant}"))
        .header("apikey", SUPABASE_ANON_KEY)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    let status = r.status();
    let v: Value = r.json().await.map_err(|e| format!("bad response: {e}"))?;
    if !status.is_success() {
        let msg = v
            .get("error_description")
            .or_else(|| v.get("msg"))
            .and_then(|x| x.as_str())
            .unwrap_or("auth error");
        return Err(format!("{} ({})", msg, status.as_u16()));
    }
    session_from(&v)
}

pub async fn sign_in(state: &AppState, method: Method) -> Result<Session, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(prev) = CURRENT.lock().unwrap().replace(cancel.clone()) {
        prev.store(true, Ordering::SeqCst);
    }
    let (verifier, challenge) = pkce_pair();
    let (server, port) = tokio::task::spawn_blocking(bind_loopback).await.map_err(|e| e.to_string())??;
    crate::log!("[auth] listening on 127.0.0.1:{port}");
    let redirect = urlencoding::encode(&redirect_url(port)).into_owned();
    let waiter = tokio::task::spawn_blocking(move || wait_for_code(server, cancel));

    match method {
        Method::Google => {
            let url = format!(
                "{SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to={redirect}&code_challenge={challenge}&code_challenge_method=s256"
            );
            tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())?;
        }
        Method::Email(email) => {
            let r = state
                .http
                .post(format!("{SUPABASE_URL}/auth/v1/otp?redirect_to={redirect}"))
                .header("apikey", SUPABASE_ANON_KEY)
                .json(&json!({
                    "email": email, "create_user": true,
                    "code_challenge": challenge, "code_challenge_method": "s256",
                }))
                .send()
                .await
                .map_err(|e| format!("network: {e}"))?;
            if !r.status().is_success() {
                let t = r.text().await.unwrap_or_default();
                return Err(if t.contains("rate") {
                    "Too many sign-in emails — try again later or use Google".into()
                } else {
                    t
                });
            }
        }
    }

    let (code, req) = waiter.await.map_err(|e| e.to_string())??;
    let session = match token_request(state, "pkce", json!({ "auth_code": code, "code_verifier": verifier })).await {
        Ok(s) => s,
        Err(e) => {
            let _ = req.respond(page("Sign-in failed", &e));
            return Err(e);
        }
    };
    let _ = req.respond(signed_in_page(&session.email, &crate::hotkey::label(&state.settings().hotkey)));
    state.store.save_session(&session);
    *state.session.lock().await = Some(session.clone());
    crate::log!("[auth] signed in as {}", session.email);
    Ok(session)
}

pub async fn sign_out(state: &AppState) {
    state.store.clear_session();
    *state.session.lock().await = None;
    *state.token.lock().await = None;
}

/// Свежий access-токен; обновляет по refresh-токену за минуту до истечения.
pub async fn access_token(state: &AppState) -> Result<String, String> {
    let mut guard = state.session.lock().await;
    let Some(s) = guard.clone() else { return Err("not signed in".into()) };
    if s.expires_at - 60 > now() {
        return Ok(s.access_token);
    }
    match token_request(state, "refresh_token", json!({ "refresh_token": s.refresh_token })).await {
        Ok(fresh) => {
            state.store.save_session(&fresh);
            let t = fresh.access_token.clone();
            *guard = Some(fresh);
            Ok(t)
        }
        // Разлогиниваем только если Supabase отверг refresh-токен (4xx);
        // сеть/5xx — временно, сессию не трогаем.
        Err(e) if !(e.ends_with("(400)") || e.ends_with("(401)") || e.ends_with("(403)")) => Err(e),
        Err(e) => {
            crate::log!("[auth] refresh failed, signing out: {e}");
            state.store.clear_session();
            *guard = None;
            Err("not signed in".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Первый порт занят (как зарезервированный Windows) — берём следующий.
    #[test]
    fn falls_back_when_the_first_port_is_taken() {
        let first = tiny_http::Server::http(("127.0.0.1", LOOPBACK_PORTS[0])).ok(); // может быть и занят — тогда тем лучше
        let (_s, port) = bind_loopback().expect("some port is free");
        if first.is_some() {
            assert_ne!(port, LOOPBACK_PORTS[0]);
        }
        assert!(LOOPBACK_PORTS.contains(&port));
    }
}
