// Лог в файл рядом с настройками (%APPDATA%\io.skriptly.desktop\skriptly.log) —
// знакомые пришлют его, если что-то не работает.
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static FILE: OnceLock<Mutex<Option<std::fs::File>>> = OnceLock::new();

pub fn init(dir: &PathBuf) {
    let path = dir.join("skriptly.log");
    // Не даём логу расти бесконечно.
    if std::fs::metadata(&path).map(|m| m.len() > 2_000_000).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("skriptly.old.log"));
    }
    let file = std::fs::OpenOptions::new().create(true).append(true).open(path).ok();
    let _ = FILE.set(Mutex::new(file));
}

pub fn write(msg: &str) {
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let line = format!("{ts} {msg}\n");
    eprint!("{line}");
    if let Some(m) = FILE.get() {
        if let Ok(mut guard) = m.lock() {
            if let Some(f) = guard.as_mut() {
                let _ = f.write_all(line.as_bytes());
            }
        }
    }
}

#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => { $crate::log::write(&format!($($arg)*)) };
}
