// Одна диктовка = одна WebSocket-сессия Soniox real-time.
// Соединение открывается параллельно с захватом микрофона; пока оно
// поднимается, PCM копится в канале — первые слова не теряются.
// Конец аудио (микрофон остановлен) → пустой фрейм → ждём "finished" с финальными токенами.
use crate::api::LiveToken;
use crate::config::SONIOX_WS;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;

/// Сколько ждём финальные токены после конца аудио.
const FINISH_TIMEOUT: Duration = Duration::from_secs(6);

pub struct Result_ {
    pub text: String,
    pub audio_seconds: f64,
}

fn is_marker(t: &str) -> bool {
    let t = t.trim();
    t.starts_with('<') && t.ends_with('>')
}

pub async fn run(
    token: LiveToken,
    sample_rate: u32,
    mut audio: UnboundedReceiver<Vec<i16>>,
    on_text: impl Fn(&str, &str),
) -> Result<Result_, String> {
    let (ws, _) = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(SONIOX_WS))
        .await
        .map_err(|_| "connection timed out".to_string())?
        .map_err(|e| format!("connection failed: {e}"))?;
    let (mut tx, mut rx) = ws.split();

    let mut cfg = json!({
        "api_key": token.api_key,
        "model": token.model,
        "audio_format": "pcm_s16le",
        "sample_rate": sample_rate,
        "num_channels": 1,
        "language_hints": token.language_hints,
        // Язык выбран явно → строго он: иначе подсказка лишь «склоняет» модель, и
        // русскую речь с украинскими словами она записывала по-украински.
        "language_hints_strict": !token.language_hints.is_empty(),
        "enable_language_identification": true,
        "enable_endpoint_detection": false,
    });
    if let Some(ctx) = token.context.clone().filter(|c| !c.is_null()) {
        cfg["context"] = ctx;
    }
    tx.send(Message::Text(cfg.to_string())).await.map_err(|e| e.to_string())?;

    let mut finals = String::new();
    let mut samples: u64 = 0;
    let mut audio_done = false;
    let deadline = tokio::time::sleep(Duration::from_secs(24 * 3600));
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            chunk = audio.recv(), if !audio_done => match chunk {
                Some(pcm) => {
                    samples += pcm.len() as u64;
                    let mut bytes = Vec::with_capacity(pcm.len() * 2);
                    for s in pcm { bytes.extend_from_slice(&s.to_le_bytes()); }
                    tx.send(Message::Binary(bytes)).await.map_err(|e| format!("send failed: {e}"))?;
                }
                None => {
                    audio_done = true;
                    tx.send(Message::Text(String::new())).await.map_err(|e| e.to_string())?;
                    deadline.as_mut().reset(tokio::time::Instant::now() + FINISH_TIMEOUT);
                }
            },
            msg = rx.next() => match msg {
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
                    if let Some(code) = v.get("error_code") {
                        return Err(format!("soniox {code}: {}", v.get("error_message").and_then(|m| m.as_str()).unwrap_or("")));
                    }
                    let mut pending = String::new();
                    for tok in v.get("tokens").and_then(|t| t.as_array()).into_iter().flatten() {
                        let text = tok.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        if text.is_empty() || is_marker(text) { continue; }
                        if tok.get("is_final").and_then(|f| f.as_bool()).unwrap_or(false) {
                            finals.push_str(text);
                        } else {
                            pending.push_str(text);
                        }
                    }
                    on_text(&finals, &pending);
                    if v.get("finished").and_then(|f| f.as_bool()).unwrap_or(false) { break; }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(format!("connection lost: {e}")),
            },
            _ = &mut deadline => {
                crate::log!("[stt] no 'finished' within {FINISH_TIMEOUT:?}, using what we have");
                break;
            }
        }
    }
    let _ = tx.close().await;
    Ok(Result_ { text: finals.trim().to_string(), audio_seconds: samples as f64 / sample_rate as f64 })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Живой прогон против Soniox (не в обычном `cargo test`):
    ///   SKRIPTLY_TEST_KEY=<временный ключ> SKRIPTLY_TEST_PCM=<s16le 16k mono> cargo test -- --ignored
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn streams_pcm_to_soniox() {
        let key = std::env::var("SKRIPTLY_TEST_KEY").expect("SKRIPTLY_TEST_KEY");
        let pcm = std::fs::read(std::env::var("SKRIPTLY_TEST_PCM").expect("SKRIPTLY_TEST_PCM")).unwrap();
        let samples: Vec<i16> = pcm.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        let token = LiveToken {
            api_key: key, model: "stt-rt-v5".into(), language_hints: vec![], context: None,
            fetched: None, language: String::new(),
        };
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        // Как микрофон: куски по 20 мс в реальном времени ×4.
        let feeder = tokio::spawn(async move {
            for c in samples.chunks(320) {
                tx.send(c.to_vec()).unwrap();
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });
        let t0 = std::time::Instant::now();
        let res = run(token, 16_000, rx, |_, _| {}).await.expect("stt");
        feeder.await.unwrap();
        println!("{:.1}s audio in {:.1}s: {}", res.audio_seconds, t0.elapsed().as_secs_f64(), res.text);
        assert!(res.text.split_whitespace().count() > 20);
    }
}
