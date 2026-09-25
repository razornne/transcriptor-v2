// Созвон после Stop: WAV → Ogg Vorbis → /api/transcribe (тот же путь, что у веба) →
// поллинг /api/jobs/<id> → транскрипт в Supabase public.transcripts (как
// landing/lib/ink/db.ts insertEntry); заголовок — из первых слов (LLM-заголовки
// выключены ради себестоимости, юзер переименует сам). После этого
// запись видна в истории на skriptly.io/app. Файлы удаляются только после
// успешного сохранения — при любой ошибке запись остаётся «неотправленной».
use crate::auth;
use crate::config::{API_BASE, SUPABASE_ANON_KEY, SUPABASE_URL};
use crate::recorder::{self, Finished};
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Длинные записи идут в chunked-пайплайн — ждём дольше, как веб (60 мин).
const POLL_LIMIT: Duration = Duration::from_secs(60 * 60);

pub fn emit(app: &AppHandle, state: &str, extra: Value) {
    let mut v = json!({ "state": state });
    if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    let _ = app.emit("call", v);
}

fn stage_label(v: &Value) -> String {
    if let (Some(done), Some(total)) = (v.get("chunks_done").and_then(Value::as_u64), v.get("chunks_total").and_then(Value::as_u64)) {
        return format!("Transcribing — part {done} of {total}");
    }
    match v.get("stage").and_then(Value::as_str).unwrap_or("") {
        "audio_split" | "convert" | "split" => "Preparing audio…",
        "diarization" | "diarize" => "Separating speakers…",
        "ai_formatting" | "correct" => "Polishing the transcript…",
        _ => "Transcribing…",
    }
    .into()
}

fn auto_title(segments: &[Value]) -> String {
    let first = segments.first().and_then(|s| s.get("text")).and_then(Value::as_str).unwrap_or("");
    let words: Vec<&str> = first.split_whitespace().take(6).collect();
    let t = words.join(" ");
    if t.len() > 2 { t } else { "Call recording".into() }
}

pub async fn process(app: AppHandle, state: Arc<AppState>, f: Finished) -> Result<String, String> {
    let settings = state.settings();
    let session = state.session.lock().await.clone().ok_or("Sign in to Skriptly first")?;

    emit(&app, "compressing", json!({ "id": f.id, "seconds": f.seconds }));
    let ogg = f.wav.with_extension("ogg");
    {
        let (wav, ogg) = (f.wav.clone(), ogg.clone());
        tokio::task::spawn_blocking(move || recorder::encode_ogg(&wav, &ogg))
            .await
            .map_err(|e| e.to_string())??;
    }
    let bytes = tokio::fs::read(&ogg).await.map_err(|e| e.to_string())?;
    crate::log!("[call] {} — {:.0}s, {:.1} MB ogg", f.id, f.seconds, bytes.len() as f64 / 1e6);

    emit(&app, "uploading", json!({ "id": f.id }));
    let token = auth::access_token(&state).await?;
    let mut form = reqwest::multipart::Form::new()
        .part("audio", reqwest::multipart::Part::bytes(bytes).file_name("recording.ogg").mime_str("audio/ogg").unwrap())
        .text("duration_sec", format!("{}", f.seconds.round() as u64))
        .text("recording_id", f.id.clone())
        .text("source", "record");
    if !settings.language.is_empty() {
        form = form.text("language", settings.language.clone());
    }
    let r = state
        .http
        .post(format!("{API_BASE}/api/transcribe"))
        .bearer_auth(&token)
        .multipart(form)
        .timeout(Duration::from_secs(15 * 60))
        .send()
        .await
        .map_err(|e| format!("Upload failed: {e}"))?;
    if r.status().as_u16() == 402 {
        return Err("Your minutes are used up — upgrade on skriptly.io".into());
    }
    let v: Value = r.json().await.map_err(|e| format!("Upload failed: {e}"))?;
    let job = v.get("job_id").and_then(Value::as_str).ok_or_else(|| {
        format!("Upload failed: {}", v.get("error").and_then(Value::as_str).unwrap_or("no job id"))
    })?.to_string();

    emit(&app, "transcribing", json!({ "id": f.id, "label": "Transcribing…" }));
    let t0 = Instant::now();
    let result = loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let token = auth::access_token(&state).await?;
        let r = state.http.get(format!("{API_BASE}/api/jobs/{job}")).bearer_auth(token).send().await;
        let Ok(r) = r else { continue }; // сеть моргнула — пробуем дальше
        let v: Value = r.json().await.unwrap_or(Value::Null);
        match v.get("status").and_then(Value::as_str) {
            Some("done") => break v,
            Some("error") => return Err(format!("Transcription failed: {}", v.get("error").and_then(Value::as_str).unwrap_or(""))),
            Some("cancelled") => return Err("Transcription was cancelled".into()),
            _ => emit(&app, "transcribing", json!({ "id": f.id, "label": stage_label(&v) })),
        }
        if t0.elapsed() > POLL_LIMIT {
            return Err("Transcription is taking too long — try again later".into());
        }
    };
    let segments = result.get("segments").and_then(Value::as_array).cloned().unwrap_or_default();
    if segments.is_empty() {
        return Err("No speech found in the recording".into());
    }

    emit(&app, "saving", json!({ "id": f.id }));
    let token = auth::access_token(&state).await?;
    let lang = if settings.language.is_empty() { Value::Null } else { json!(settings.language) };
    let row = json!({
        "user_id": session.user_id, "title": auto_title(&segments), "title_is_auto": true,
        "language": lang, "segments": segments, "speaker_names": {}, "notes": "", "ai_results": {},
        "visibility": "private",
    });
    let r = state
        .http
        .post(format!("{SUPABASE_URL}/rest/v1/transcripts"))
        .header("apikey", SUPABASE_ANON_KEY)
        .bearer_auth(&token)
        .header("Prefer", "return=representation")
        .json(&row)
        .send()
        .await
        .map_err(|e| format!("Saving failed: {e}"))?;
    let saved: Value = r.json().await.map_err(|e| format!("Saving failed: {e}"))?;
    let id = saved
        .as_array()
        .and_then(|a| a.first())
        .and_then(|r| r.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Saving failed: {saved}"))?
        .to_string();

    // Готово — запись в истории, локальные файлы больше не нужны.
    let _ = tokio::fs::remove_file(&f.wav).await;
    let _ = tokio::fs::remove_file(&ogg).await;
    crate::log!("[call] saved transcript {id} ({} segments) in {:.0}s", segments.len(), t0.elapsed().as_secs_f64());

    Ok(id)
}
