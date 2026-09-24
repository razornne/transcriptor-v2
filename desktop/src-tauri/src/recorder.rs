// Запись созвона: L = микрофон, R = звук компьютера (WASAPI loopback) —
// тот же стерео-формат, что пишет веб (landing/lib/ink/audio.ts), поэтому
// бэкенд распознаёт каналы раздельно и знает, кто владелец микрофона.
//
// Во время записи — несжатый WAV 16 кГц стерео прямо на диск
// (%APPDATA%\io.skriptly.desktop\recordings\call-<id>.wav): упало приложение
// или компьютер — запись не пропала, при следующем запуске её можно отправить.
// После Stop — сжатие в Ogg Vorbis (~25 МБ/ч вместо 230 МБ/ч) и отправка.
use crate::audio;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::unbounded_channel;

pub const RATE: u32 = audio::TARGET_RATE;
const TICK: Duration = Duration::from_millis(100);

// ── Микшер: два потока с разными часами → кадры (L, R) по настенному времени ──

pub struct Mixer {
    mic: VecDeque<i16>,
    sys: VecDeque<i16>,
    written: u64,
}

impl Mixer {
    pub fn new() -> Self {
        Self { mic: VecDeque::new(), sys: VecDeque::new(), written: 0 }
    }

    pub fn push_mic(&mut self, s: &[i16]) {
        self.mic.extend(s);
    }

    pub fn push_sys(&mut self, s: &[i16]) {
        self.sys.extend(s);
    }

    /// Кадры до момента `target` (в сэмплах от начала). Loopback в тишине молчит
    /// совсем — его дополняем нулями сразу; микрофону даём до 0.5 с догнать
    /// (буферы драйвера), потом тоже нули. Излишек больше секунды (часы
    /// устройства спешат) срезаем, чтобы каналы не расползались.
    pub fn take_until(&mut self, target: u64, out: &mut Vec<i16>) {
        let need = target.saturating_sub(self.written) as usize;
        let lag_ok = RATE as usize / 2;
        let n = if self.mic.len() >= need || need - self.mic.len() > lag_ok { need } else { self.mic.len() };
        for _ in 0..n {
            out.push(self.mic.pop_front().unwrap_or(0));
            out.push(self.sys.pop_front().unwrap_or(0));
        }
        self.written += n as u64;
        for q in [&mut self.mic, &mut self.sys] {
            if q.len() > RATE as usize {
                let excess = q.len() - RATE as usize / 2;
                q.drain(..excess);
            }
        }
    }

    /// Всё, что осталось (на Stop).
    pub fn drain(&mut self, out: &mut Vec<i16>) {
        let n = self.mic.len().max(self.sys.len());
        for _ in 0..n {
            out.push(self.mic.pop_front().unwrap_or(0));
            out.push(self.sys.pop_front().unwrap_or(0));
        }
        self.written += n as u64;
    }
}

// ── WAV (PCM s16le, 2 канала, 16 кГц) ──────────────────────────────────────

fn wav_header(data_len: u32) -> [u8; 44] {
    let mut h = [0u8; 44];
    let byte_rate = RATE * 2 * 2;
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_len).to_le_bytes());
    h[8..16].copy_from_slice(b"WAVEfmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&2u16.to_le_bytes()); // stereo
    h[24..28].copy_from_slice(&RATE.to_le_bytes());
    h[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    h[32..34].copy_from_slice(&4u16.to_le_bytes()); // block align
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_len.to_le_bytes());
    h
}

/// Чинит заголовок по размеру файла (после падения размеры в заголовке — нули).
/// Возвращает длительность в секундах.
pub fn finalize_wav(path: &Path) -> std::io::Result<f64> {
    let len = std::fs::metadata(path)?.len();
    let data = len.saturating_sub(44).min(u32::MAX as u64 - 36) as u32;
    let data = data - data % 4;
    let mut f = std::fs::OpenOptions::new().write(true).open(path)?;
    f.seek(SeekFrom::Start(0))?;
    f.write_all(&wav_header(data))?;
    Ok(data as f64 / (RATE as f64 * 4.0))
}

// ── Запись ────────────────────────────────────────────────────────────────

pub struct Recording {
    pub id: String,
    pub wav: PathBuf,
    pub started: Instant,
    pub mic_level: Arc<AtomicU32>,
    pub sys_level: Arc<AtomicU32>,
    pub has_system_audio: bool,
    stop: Arc<AtomicBool>,
    writer: std::thread::JoinHandle<std::io::Result<()>>,
    mic: audio::Capture,
    sys: Option<audio::Capture>,
}

pub struct Finished {
    pub id: String,
    pub wav: PathBuf,
    pub seconds: f64,
}

pub fn uuid4() -> String {
    let b: [u8; 16] = rand::random();
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    // версия 4 / вариант RFC 4122
    format!(
        "{}-{}-4{}-{:x}{}-{}",
        &h[0..8], &h[8..12], &h[13..16], (b[8] & 0x3) | 0x8, &h[17..20], &h[20..32]
    )
}

pub fn recordings_dir(base: &Path) -> PathBuf {
    let d = base.join("recordings");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn start(base: &Path, mic: Option<String>) -> Result<Recording, String> {
    let id = uuid4();
    let wav = recordings_dir(base).join(format!("call-{id}.wav"));
    let (mic_tx, mut mic_rx) = unbounded_channel::<Vec<i16>>();
    let (sys_tx, mut sys_rx) = unbounded_channel::<Vec<i16>>();
    let mic_level = Arc::new(AtomicU32::new(0));
    let sys_level = Arc::new(AtomicU32::new(0));

    let mic_cap = audio::start(mic, mic_tx, mic_level.clone()).map_err(|e| format!("Microphone problem: {e}"))?;
    let sys_cap = match audio::start_loopback(sys_tx, sys_level.clone()) {
        Ok(c) => Some(c),
        Err(e) => {
            crate::log!("[record] no system audio: {e}"); // пишем только микрофон
            None
        }
    };
    if mic_cap.rate != RATE || sys_cap.as_ref().map(|c| c.rate != RATE).unwrap_or(false) {
        crate::log!("[record] device below 16 kHz — channels resampled to its rate are written as 16 kHz");
    }

    let mut file = BufWriter::new(File::create(&wav).map_err(|e| format!("can't create recording file: {e}"))?);
    file.write_all(&wav_header(0)).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop_w = stop.clone();
    let path_w = wav.clone();
    let started = Instant::now();
    let writer = std::thread::Builder::new()
        .name("skriptly-record".into())
        .spawn(move || -> std::io::Result<()> {
            let mut mixer = Mixer::new();
            let mut frames = Vec::with_capacity(RATE as usize / 5);
            let t0 = Instant::now();
            let mut last_flush = Instant::now();
            loop {
                let stopping = stop_w.load(Ordering::SeqCst);
                while let Ok(c) = mic_rx.try_recv() {
                    mixer.push_mic(&c);
                }
                while let Ok(c) = sys_rx.try_recv() {
                    mixer.push_sys(&c);
                }
                frames.clear();
                if stopping {
                    mixer.drain(&mut frames);
                } else {
                    mixer.take_until((t0.elapsed().as_secs_f64() * RATE as f64) as u64, &mut frames);
                }
                let mut bytes = Vec::with_capacity(frames.len() * 2);
                for s in &frames {
                    bytes.extend_from_slice(&s.to_le_bytes());
                }
                file.write_all(&bytes)?;
                // Раз в 5 с — на диск и правильный заголовок: падение теряет максимум 5 с.
                if stopping || last_flush.elapsed() > Duration::from_secs(5) {
                    file.flush()?;
                    let _ = finalize_wav(&path_w);
                    last_flush = Instant::now();
                }
                if stopping {
                    return Ok(());
                }
                std::thread::sleep(TICK);
            }
        })
        .map_err(|e| e.to_string())?;

    crate::log!("[record] started {id} mic='{}' system={}", mic_cap.device, sys_cap.is_some());
    Ok(Recording {
        id,
        wav,
        started,
        mic_level,
        sys_level,
        has_system_audio: sys_cap.is_some(),
        stop,
        writer,
        mic: mic_cap,
        sys: sys_cap,
    })
}

impl Recording {
    pub fn stop(self) -> Result<Finished, String> {
        self.mic.stop();
        if let Some(s) = self.sys {
            s.stop();
        }
        std::thread::sleep(Duration::from_millis(150)); // последние куски из драйверов
        self.stop.store(true, Ordering::SeqCst);
        self.writer.join().map_err(|_| "recorder crashed".to_string())?.map_err(|e| e.to_string())?;
        let seconds = finalize_wav(&self.wav).map_err(|e| e.to_string())?;
        crate::log!("[record] stopped {} — {seconds:.1}s", self.id);
        Ok(Finished { id: self.id, wav: self.wav, seconds })
    }
}

/// Незавершённые/неотправленные записи (после падения или неудачной отправки).
pub fn pending(base: &Path) -> Vec<Finished> {
    let Ok(rd) = std::fs::read_dir(recordings_dir(base)) else { return vec![] };
    let mut out = vec![];
    for e in rd.flatten() {
        let p = e.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        if let Some(id) = name.strip_prefix("call-").and_then(|n| n.strip_suffix(".wav")) {
            if let Ok(seconds) = finalize_wav(&p) {
                if seconds >= 1.0 {
                    out.push(Finished { id: id.to_string(), wav: p.clone(), seconds });
                } else {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    }
    out
}

// ── Сжатие WAV → Ogg Vorbis ───────────────────────────────────────────────

/// ~48 кбит/с на стерео 16 кГц — речь без потерь для распознавания, ~22 МБ/ч.
pub fn encode_ogg(wav: &Path, ogg: &Path) -> Result<(), String> {
    use std::num::{NonZeroU32, NonZeroU8};
    use vorbis_rs::{VorbisBitrateManagementStrategy, VorbisEncoderBuilder};

    let mut input = std::io::BufReader::new(File::open(wav).map_err(|e| e.to_string())?);
    let mut header = [0u8; 44];
    input.read_exact(&mut header).map_err(|e| e.to_string())?;
    let out = BufWriter::new(File::create(ogg).map_err(|e| e.to_string())?);
    let mut enc = VorbisEncoderBuilder::new(NonZeroU32::new(RATE).unwrap(), NonZeroU8::new(2).unwrap(), out)
        .map_err(|e| e.to_string())?
        .bitrate_management_strategy(VorbisBitrateManagementStrategy::Vbr {
            target_bitrate: NonZeroU32::new(48_000).unwrap(),
        })
        .build()
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; RATE as usize * 4]; // 1 с
    loop {
        let n = read_full(&mut input, &mut buf).map_err(|e| e.to_string())?;
        let n = n - n % 4;
        if n == 0 {
            break;
        }
        let frames = n / 4;
        let (mut l, mut r) = (Vec::with_capacity(frames), Vec::with_capacity(frames));
        for f in buf[..n].chunks_exact(4) {
            l.push(i16::from_le_bytes([f[0], f[1]]) as f32 / 32768.0);
            r.push(i16::from_le_bytes([f[2], f[3]]) as f32 / 32768.0);
        }
        enc.encode_audio_block([&l, &r]).map_err(|e| e.to_string())?;
    }
    enc.finish().map_err(|e| e.to_string())?.flush().map_err(|e| e.to_string())?;
    Ok(())
}

fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixer_pads_silent_loopback_and_keeps_channels_aligned() {
        let mut m = Mixer::new();
        m.push_mic(&[1; 1600]); // 100 мс речи, loopback молчит
        let mut out = vec![];
        m.take_until(1600, &mut out);
        assert_eq!(out.len(), 3200);
        assert!(out.chunks(2).all(|f| f == [1, 0]));
        m.push_sys(&[2; 800]);
        m.push_mic(&[1; 800]);
        out.clear();
        m.take_until(2400, &mut out);
        assert!(out.chunks(2).all(|f| f == [1, 2]));
    }

    #[test]
    fn mixer_waits_briefly_for_a_lagging_mic_then_pads() {
        let mut m = Mixer::new();
        let mut out = vec![];
        m.take_until(1600, &mut out); // микрофон ещё не прислал — ждём (в пределах 0.5 с)
        assert!(out.is_empty());
        m.take_until(16_000, &mut out); // отстал на секунду — пишем тишину, чтобы не копить
        assert_eq!(out.len(), 32_000);
    }

    #[test]
    fn uuid_is_v4_shaped() {
        let u = uuid4();
        let parts: Vec<_> = u.split('-').map(str::len).collect();
        assert_eq!(parts, [8, 4, 4, 4, 12]);
        assert_eq!(&u[14..15], "4");
        assert!("89ab".contains(&u[19..20]));
    }

    #[test]
    fn wav_roundtrip_and_ogg_encode() {
        let dir = std::env::temp_dir().join(format!("skriptly-test-{}", uuid4()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("t.wav");
        let mut f = File::create(&wav).unwrap();
        f.write_all(&wav_header(0)).unwrap(); // как после падения: размеры не проставлены
        for i in 0..RATE * 2 {
            let l = ((i as f32 * 0.05).sin() * 8000.0) as i16;
            f.write_all(&l.to_le_bytes()).unwrap();
            f.write_all(&(l / 2).to_le_bytes()).unwrap();
        }
        drop(f);
        let secs = finalize_wav(&wav).unwrap();
        assert!((secs - 2.0).abs() < 0.01, "{secs}");
        let ogg = dir.join("t.ogg");
        encode_ogg(&wav, &ogg).unwrap();
        let size = std::fs::metadata(&ogg).unwrap().len();
        assert!(size > 1000 && size < 40_000, "ogg {size} bytes");
        let _ = std::fs::remove_dir_all(dir);
    }
}
