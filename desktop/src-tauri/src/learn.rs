// Обучение на правках после диктовки: после вставки читаем то же текстовое поле и, когда юзер
// закончил править, отправляем «вставили → стало» на сервер; там находятся пары wrong→right для
// личного словаря (vocab_learn.py). Читаем только поле, в которое сами вставили; парольные
// пропускаем; на сервер уходит лишь вставленный фрагмент и его правленая версия.
use crate::platform::learn::focused_field;
use crate::state::AppState;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Каждая новая диктовка отменяет слежку за предыдущей.
static GEN: AtomicU64 = AtomicU64::new(0);

const POLL: Duration = Duration::from_millis(1500);
/// Правки закончились, если текст не меняется столько.
const SETTLE: Duration = Duration::from_secs(5);
/// Дольше не следим.
const MAX_WATCH: Duration = Duration::from_secs(60);
/// Слишком большие документы не читаем (Word на 200 страниц).
const MAX_DOC_CHARS: usize = 120_000;

/// Что стало на месте вставленного `pasted`, если в поле было `before` (с вставкой), а теперь `after`.
/// Опираемся на текст вокруг вставки: правки внутри неё меняют только середину.
pub fn edited_region(before: &str, after: &str, pasted: &str) -> Option<String> {
    let idx = before.find(pasted)?;
    let prefix = &before[..idx];
    let suffix = &before[idx + pasted.len()..];
    // Начало и конец совпали с прежними — середина и есть правленая вставка
    if after.len() >= prefix.len() + suffix.len() && after.starts_with(prefix) && after.ends_with(suffix) {
        return Some(after[prefix.len()..after.len() - suffix.len()].to_string());
    }
    // Правили и вне вставки (дописали после, поправили до): якоря — хвост префикса и голова суффикса
    let anchor_l = tail(prefix, 24);
    let anchor_r = head(suffix, 24);
    let start = if anchor_l.is_empty() { 0 } else { after.find(anchor_l)? + anchor_l.len() };
    let end = if anchor_r.is_empty() { after.len() } else { start + after[start..].find(anchor_r)? };
    let region = &after[start..end];
    if region.chars().count() > pasted.chars().count() * 2 + 200 {
        return None;
    }
    Some(region.to_string())
}

fn tail(s: &str, n: usize) -> &str {
    let k = s.char_indices().rev().nth(n.saturating_sub(1)).map(|(i, _)| i).unwrap_or(0);
    &s[k..]
}

fn head(s: &str, n: usize) -> &str {
    let k = s.char_indices().nth(n).map(|(i, _)| i).unwrap_or(s.len());
    &s[..k]
}

/// Запускает слежку в фоне. `pasted` — ровно то, что вставили.
pub fn watch(state: Arc<AppState>, pasted: String, language: Option<String>) {
    let my = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let Some((before, after)) = observe(my, &pasted) else { return };
        let Some(region) = edited_region(&before, &after, &pasted) else { return };
        let region = region.trim().to_string();
        if region.is_empty() || region == pasted.trim() {
            return;
        }
        crate::log!("[learn] edit seen ({} -> {} chars)", pasted.chars().count(), region.chars().count());
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::api::learn(&state, &pasted, &region, language.as_deref().unwrap_or("")).await {
                crate::log!("[learn] send failed: {e:?}");
            }
        });
    });
}

fn observe(my: u64, pasted: &str) -> Option<(String, String)> {
    std::thread::sleep(Duration::from_millis(900)); // дать приложению принять вставку
    if GEN.load(Ordering::SeqCst) != my {
        return None;
    }
    let field = focused_field()?;
    let before = field.read(MAX_DOC_CHARS)?;
    if !before.contains(pasted) {
        return None; // поле не приняло вставку как есть (форматирующий редактор) — не гадаем
    }
    let started = Instant::now();
    let mut last = before.clone();
    let mut last_change = Instant::now();
    while started.elapsed() < MAX_WATCH {
        std::thread::sleep(POLL);
        if GEN.load(Ordering::SeqCst) != my {
            return None;
        }
        let Some(now) = field.read(MAX_DOC_CHARS) else { break };
        if now != last {
            last = now;
            last_change = Instant::now();
        } else if last != before && last_change.elapsed() >= SETTLE {
            break;
        }
    }
    (last != before).then_some((before, last))
}

#[cfg(test)]
mod tests {
    use super::edited_region;

    #[test]
    fn edit_inside_the_pasted_text() {
        let before = "Hi team. We use scripty for calls. Thanks";
        let after = "Hi team. We use Skriptly for calls. Thanks";
        assert_eq!(edited_region(before, after, "We use scripty for calls.").as_deref(), Some("We use Skriptly for calls."));
    }

    #[test]
    fn edits_outside_the_pasted_text_are_ignored() {
        let before = "Intro line\nsend the report by Friday\nbye";
        let after = "Intro line\nsend the report by Friday\nbye, Anna";
        assert_eq!(edited_region(before, after, "send the report by Friday").as_deref(), Some("send the report by Friday"));
    }

    #[test]
    fn paste_into_an_empty_field() {
        assert_eq!(edited_region("hello pozhika", "hello ЖК", "hello pozhika").as_deref(), Some("hello ЖК"));
    }

    #[test]
    fn text_is_gone() {
        assert_eq!(edited_region("a b c", "completely different", "b"), None);
    }
}
