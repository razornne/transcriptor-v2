// Микрофон для диктовки: открывается на нажатие (по умолчанию) или держится
// открытым («Instant start»). Во втором случае последние PREROLL секунд до
// нажатия тоже уходят в распознавание — первое слово не теряется даже у
// Bluetooth-гарнитуры, которой на переключение в режим звонка нужны сотни мс.
// Цена: Windows постоянно показывает индикатор микрофона, а BT-наушники
// остаются в «звонковом» качестве звука — поэтому опция выключена по умолчанию.
use crate::audio;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

const PREROLL_SAMPLES: usize = audio::TARGET_RATE as usize / 2; // 0.5 с

struct Inner {
    sink: Option<UnboundedSender<Vec<i16>>>,
    ring: VecDeque<i16>,
}

struct Warm {
    capture: audio::Capture,
    inner: Arc<Mutex<Inner>>,
    level: Arc<AtomicU32>,
    mic: Option<String>,
}

static WARM: Mutex<Option<Warm>> = Mutex::new(None);

/// Включить/выключить «всегда готовый» микрофон (и перезапустить при смене устройства).
pub fn set_warm(on: bool, mic: Option<String>) {
    let mut w = WARM.lock().unwrap();
    if let Some(cur) = w.as_ref() {
        if on && cur.mic == mic {
            return;
        }
    }
    if let Some(old) = w.take() {
        old.capture.stop();
    }
    if !on {
        return;
    }
    let (tx, mut rx) = unbounded_channel::<Vec<i16>>();
    let level = Arc::new(AtomicU32::new(0));
    let got = Arc::new(AtomicBool::new(false));
    match audio::start(mic.clone(), tx, level.clone(), got) {
        Ok(capture) => {
            let inner = Arc::new(Mutex::new(Inner { sink: None, ring: VecDeque::with_capacity(PREROLL_SAMPLES * 2) }));
            let fwd = inner.clone();
            std::thread::Builder::new()
                .name("skriptly-mic-warm".into())
                .spawn(move || {
                    while let Some(chunk) = rx.blocking_recv() {
                        let mut i = fwd.lock().unwrap();
                        match &i.sink {
                            Some(s) => {
                                if s.send(chunk).is_err() {
                                    i.sink = None;
                                }
                            }
                            None => {
                                i.ring.extend(chunk);
                                let excess = i.ring.len().saturating_sub(PREROLL_SAMPLES);
                                i.ring.drain(..excess);
                            }
                        }
                    }
                })
                .expect("mic thread");
            crate::log!("[mic] instant start on ({})", capture.device);
            *w = Some(Warm { capture, inner, level, mic });
        }
        Err(e) => crate::log!("[mic] instant start failed: {e}"),
    }
}

pub struct Session {
    pub rate: u32,
    pub device: String,
    pub level: Arc<AtomicU32>,
    /// Пришёл ли уже реальный звук (для плашки «готовлюсь → говорите»).
    pub got_audio: Arc<AtomicBool>,
    kind: Kind,
}

enum Kind {
    Cold(audio::Capture),
    Warm(Arc<Mutex<Inner>>),
}

impl Session {
    /// Конец диктовки: у tx в stt кончается аудио → Soniox финализирует.
    pub fn stop(self) {
        match self.kind {
            Kind::Cold(c) => c.stop(),
            Kind::Warm(inner) => inner.lock().unwrap().sink = None,
        }
    }
}

pub fn open(mic: Option<String>, tx: UnboundedSender<Vec<i16>>) -> Result<Session, String> {
    if let Some(w) = WARM.lock().unwrap().as_ref() {
        if w.mic == mic {
            let mut i = w.inner.lock().unwrap();
            let pre: Vec<i16> = i.ring.drain(..).collect();
            if !pre.is_empty() {
                let _ = tx.send(pre);
            }
            i.sink = Some(tx);
            return Ok(Session {
                rate: w.capture.rate,
                device: w.capture.device.clone(),
                level: w.level.clone(),
                got_audio: Arc::new(AtomicBool::new(true)),
                kind: Kind::Warm(w.inner.clone()),
            });
        }
    }
    let level = Arc::new(AtomicU32::new(0));
    let got = Arc::new(AtomicBool::new(false));
    let c = audio::start(mic, tx, level.clone(), got.clone())?;
    Ok(Session { rate: c.rate, device: c.device.clone(), level, got_audio: got, kind: Kind::Cold(c) })
}

pub fn is_warm() -> bool {
    WARM.lock().unwrap().is_some()
}

#[allow(dead_code)]
pub fn level_of(s: &Session) -> f32 {
    f32::from_bits(s.level.load(Ordering::Relaxed))
}
