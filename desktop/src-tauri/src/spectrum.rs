// Спектр речи для волны на плашке: из потока PCM (моно, 16 бит) раз в ~50 мс считаем
// энергию в BANDS частотных полосах (логарифмическая шкала 90 Гц … 6.5 кГц), в дБ относительно
// полной шкалы. Усиление, порог тишины и рисунок — на стороне плашки (ui/overlay.html).
use std::f32::consts::PI;

pub const BANDS: usize = 24;
const N: usize = 1024; // окно ~64 мс при 16 кГц
const FMIN: f32 = 90.0;
const FMAX: f32 = 6500.0;
/// Как часто выдавать новый спектр.
const HOP_SECONDS: f32 = 0.05;

pub struct Analyzer {
    hop: usize,
    since: usize,
    buf: Vec<f32>,
    window: Vec<f32>,
    wsum: f32,
    edges: [usize; BANDS + 1],
    re: Vec<f32>,
    im: Vec<f32>,
}

impl Analyzer {
    pub fn new(rate: u32) -> Self {
        let rate = rate.max(8000) as f32;
        let window: Vec<f32> = (0..N).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / (N as f32 - 1.0)).cos()).collect();
        let wsum = window.iter().sum();
        let hz = rate / N as f32;
        let fmax = FMAX.min(rate / 2.0 * 0.95);
        let mut edges = [0usize; BANDS + 1];
        for (i, e) in edges.iter_mut().enumerate() {
            let f = FMIN * (fmax / FMIN).powf(i as f32 / BANDS as f32);
            *e = ((f / hz).round() as usize).clamp(1, N / 2 - 1);
        }
        Analyzer {
            hop: (rate * HOP_SECONDS) as usize,
            since: 0,
            buf: Vec::with_capacity(N * 2),
            window,
            wsum,
            edges,
            re: vec![0.0; N],
            im: vec![0.0; N],
        }
    }

    /// Добавить звук; когда накопился шаг — вернуть спектр (дБ на полосу).
    pub fn push(&mut self, pcm: &[i16]) -> Option<[f32; BANDS]> {
        self.buf.extend(pcm.iter().map(|&s| s as f32 / 32768.0));
        if self.buf.len() > N {
            let extra = self.buf.len() - N;
            self.buf.drain(..extra);
        }
        self.since += pcm.len();
        if self.since < self.hop {
            return None;
        }
        self.since -= self.hop; // остаток не теряем — иначе шаг «плывёт» от размера кусков
        Some(self.compute())
    }

    fn compute(&mut self) -> [f32; BANDS] {
        let pad = N - self.buf.len(); // в самом начале записи окно короче — добиваем тишиной спереди
        for i in 0..N {
            self.re[i] = if i < pad { 0.0 } else { self.buf[i - pad] * self.window[i] };
            self.im[i] = 0.0;
        }
        fft(&mut self.re, &mut self.im);
        let mut out = [-120.0f32; BANDS];
        for b in 0..BANDS {
            let (k0, k1) = (self.edges[b], self.edges[b + 1].max(self.edges[b] + 1));
            let mut sum = 0.0;
            for k in k0..k1 {
                sum += (self.re[k] * self.re[k] + self.im[k] * self.im[k]).sqrt() * 2.0 / self.wsum;
            }
            out[b] = 20.0 * (sum / (k1 - k0) as f32).max(1e-6).log10();
        }
        out
    }
}

/// Радикс-2 БПФ на месте (длина — степень двойки).
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        for i in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let (a, b) = (i + k, i + k + len / 2);
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
        }
        len <<= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, amp: f32, rate: u32, n: usize) -> Vec<i16> {
        (0..n).map(|i| ((2.0 * PI * freq * i as f32 / rate as f32).sin() * amp * 32767.0) as i16).collect()
    }

    fn spectrum_of(pcm: &[i16], rate: u32) -> [f32; BANDS] {
        let mut a = Analyzer::new(rate);
        let mut last = None;
        for c in pcm.chunks(320) {
            if let Some(s) = a.push(c) {
                last = Some(s);
            }
        }
        last.expect("spectrum")
    }

    #[test]
    fn tone_lights_the_band_it_falls_into() {
        let low = spectrum_of(&sine(200.0, 0.5, 16_000, 16_000), 16_000);
        let high = spectrum_of(&sine(3000.0, 0.5, 16_000, 16_000), 16_000);
        let argmax = |s: &[f32; BANDS]| s.iter().enumerate().max_by(|a, b| a.1.partial_cmp(b.1).unwrap()).unwrap().0;
        assert!(argmax(&low) < argmax(&high), "low tone {} high tone {}", argmax(&low), argmax(&high));
        assert!(argmax(&low) < BANDS / 3);
        assert!(argmax(&high) > BANDS / 2);
    }

    #[test]
    fn silence_is_far_below_a_tone() {
        let quiet = spectrum_of(&vec![0i16; 16_000], 16_000);
        let tone = spectrum_of(&sine(1000.0, 0.3, 16_000, 16_000), 16_000);
        let max = |s: &[f32; BANDS]| s.iter().cloned().fold(-200.0, f32::max);
        assert!(max(&tone) > max(&quiet) + 40.0);
    }

    #[test]
    fn gives_about_twenty_updates_per_second() {
        let mut a = Analyzer::new(16_000);
        let n = sine(500.0, 0.2, 16_000, 16_000).chunks(320).filter(|c| a.push(c).is_some()).count();
        assert!((18..=22).contains(&n), "{n}");
    }
}
