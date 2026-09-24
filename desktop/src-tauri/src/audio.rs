// Захват микрофона (cpal/WASAPI) → моно → 16 кГц → i16 (pcm_s16le для Soniox).
// Микрофон открывается только на время диктовки (индикатор микрофона в Windows
// не горит постоянно). cpal::Stream не Send — живёт на своём потоке до stop().
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;

pub const TARGET_RATE: u32 = 16_000;

pub struct Capture {
    stop: std::sync::mpsc::Sender<()>,
    pub rate: u32,
    pub device: String,
}

impl Capture {
    pub fn stop(self) {
        let _ = self.stop.send(());
    }
}

/// Усреднение по окну (box-фильтр) + прореживание до 16 кГц — для речи хватает.
struct Downsampler {
    step: f64,
    acc: f64,
    sum: f32,
    n: u32,
}

impl Downsampler {
    fn new(in_rate: u32, out_rate: u32) -> Self {
        Self { step: in_rate as f64 / out_rate as f64, acc: 0.0, sum: 0.0, n: 0 }
    }

    fn push(&mut self, x: f32, out: &mut Vec<i16>) {
        self.sum += x;
        self.n += 1;
        self.acc += 1.0;
        if self.acc >= self.step {
            self.acc -= self.step;
            let v = (self.sum / self.n as f32).clamp(-1.0, 1.0);
            out.push((v * 32767.0) as i16);
            self.sum = 0.0;
            self.n = 0;
        }
    }
}

pub fn list_devices() -> Vec<String> {
    cpal::default_host()
        .input_devices()
        .map(|it| it.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

fn pick_device(name: Option<&str>) -> Option<cpal::Device> {
    let host = cpal::default_host();
    if let Some(name) = name {
        if let Ok(mut it) = host.input_devices() {
            if let Some(d) = it.find(|d| d.name().map(|n| n == name).unwrap_or(false)) {
                return Some(d);
            }
        }
        crate::log!("[audio] mic '{name}' not found, using default");
    }
    host.default_input_device()
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    out_rate: u32,
    tx: UnboundedSender<Vec<i16>>,
    level: Arc<AtomicU32>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    let mut ds = Downsampler::new(config.sample_rate.0, out_rate);
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let mut out = Vec::with_capacity(data.len() / channels.max(1) / 2 + 1);
                let mut sq = 0f32;
                for frame in data.chunks(channels.max(1)) {
                    let mono = frame.iter().map(|s| f32::from_sample(*s)).sum::<f32>() / frame.len() as f32;
                    sq += mono * mono;
                    ds.push(mono, &mut out);
                }
                let frames = (data.len() / channels.max(1)).max(1);
                level.store((sq / frames as f32).sqrt().to_bits(), Ordering::Relaxed);
                if !out.is_empty() {
                    let _ = tx.send(out);
                }
            },
            |e| crate::log!("[audio] stream error: {e}"),
            None,
        )
        .map_err(|e| e.to_string())
}

/// Открывает микрофон и шлёт куски PCM в `tx`. Когда Capture остановлен,
/// поток дропается вместе с `tx` — получатель видит конец аудио.
pub fn start(mic: Option<String>, tx: UnboundedSender<Vec<i16>>, level: Arc<AtomicU32>) -> Result<Capture, String> {
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(u32, String), String>>();
    std::thread::Builder::new()
        .name("skriptly-audio".into())
        .spawn(move || {
            let res = (|| {
                let device = pick_device(mic.as_deref()).ok_or("no microphone found")?;
                let name = device.name().unwrap_or_default();
                let supported = device.default_input_config().map_err(|e| e.to_string())?;
                let format = supported.sample_format();
                let config: cpal::StreamConfig = supported.into();
                let out_rate = TARGET_RATE.min(config.sample_rate.0);
                let stream = match format {
                    cpal::SampleFormat::F32 => build::<f32>(&device, &config, out_rate, tx, level),
                    cpal::SampleFormat::I16 => build::<i16>(&device, &config, out_rate, tx, level),
                    cpal::SampleFormat::U16 => build::<u16>(&device, &config, out_rate, tx, level),
                    cpal::SampleFormat::I32 => build::<i32>(&device, &config, out_rate, tx, level),
                    f => Err(format!("unsupported sample format {f:?}")),
                }?;
                stream.play().map_err(|e| e.to_string())?;
                Ok::<_, String>((stream, out_rate, name))
            })();
            match res {
                Ok((stream, rate, name)) => {
                    let _ = ready_tx.send(Ok((rate, name)));
                    let _ = stop_rx.recv();
                    drop(stream);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    let (rate, device) = ready_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "microphone didn't start".to_string())??;
    Ok(Capture { stop: stop_tx, rate, device })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downsampler_keeps_duration_and_level() {
        for in_rate in [16_000u32, 44_100, 48_000] {
            let mut ds = Downsampler::new(in_rate, TARGET_RATE);
            let mut out = Vec::new();
            // 1 с синуса 440 Гц с амплитудой 0.5
            for i in 0..in_rate {
                let x = 0.5 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / in_rate as f32).sin();
                ds.push(x, &mut out);
            }
            assert!((out.len() as i64 - 16_000).abs() <= 2, "{in_rate}: {} samples", out.len());
            let peak = out.iter().map(|s| s.unsigned_abs()).max().unwrap();
            assert!(peak > 14_000 && peak < 17_000, "{in_rate}: peak {peak}");
        }
    }
}
