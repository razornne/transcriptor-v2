// Настройки и сессия — JSON-файлы в %APPDATA%\io.skriptly.desktop.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    /// "" = автоопределение, иначе en/ru/uk/pl/cs.
    pub language: String,
    /// Чистить текст через LLM перед вставкой (слова-паразиты, самоисправления).
    pub cleanup: bool,
    /// Имя микрофона; None = системный по умолчанию.
    pub mic: Option<String>,
    pub autostart: bool,
    /// «Удерживать» — виртуальные коды клавиш (hotkey.rs), по умолчанию Ctrl+Win.
    pub hotkey: Vec<u16>,
    /// «Закрепить» (диктовка без удержания), по умолчанию Ctrl+Win+Space.
    pub lock_hotkey: Vec<u16>,
    /// Капсула диктовки всегда видна внизу экрана (как у Wispr Flow).
    pub show_bar: bool,
    /// Микрофон держится открытым: диктовка стартует мгновенно, с 0.5 с «до нажатия».
    pub instant_start: bool,
    /// Ставить играющее медиа (YouTube, музыка) на паузу на время диктовки.
    pub pause_media: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            language: String::new(),
            cleanup: true,
            mic: None,
            autostart: true,
            hotkey: crate::hotkey::DEFAULT_HOTKEY.to_vec(),
            lock_hotkey: crate::hotkey::DEFAULT_LOCK_HOTKEY.to_vec(),
            show_bar: true,
            instant_start: false,
            pause_media: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Session {
    pub access_token: String,
    pub refresh_token: String,
    /// unix-секунды
    pub expires_at: i64,
    pub email: String,
    pub user_id: String,
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Self { dir }
    }

    pub fn dir(&self) -> &PathBuf {
        &self.dir
    }

    fn read<T: for<'de> Deserialize<'de>>(&self, name: &str) -> Option<T> {
        let s = std::fs::read_to_string(self.dir.join(name)).ok()?;
        serde_json::from_str(&s).ok()
    }

    /// Через временный файл + переименование (не оставить полузаписанный JSON).
    /// Если переименование не прошло — пишем напрямую; любая ошибка — в лог
    /// (раньше молча терялась: настройки 0.1–0.3 так ни разу и не сохранились).
    fn write<T: Serialize>(&self, name: &str, v: &T) {
        let s = match serde_json::to_string_pretty(v) {
            Ok(s) => s,
            Err(e) => return crate::log!("[store] {name}: serialize failed: {e}"),
        };
        let (tmp, dst) = (self.dir.join(format!("{name}.tmp")), self.dir.join(name));
        let res = std::fs::write(&tmp, &s).and_then(|_| std::fs::rename(&tmp, &dst));
        if let Err(e) = res {
            crate::log!("[store] {name}: atomic write failed ({e}), writing directly");
            let _ = std::fs::remove_file(&tmp);
            if let Err(e) = std::fs::write(&dst, &s) {
                crate::log!("[store] {name}: write failed: {e}");
            }
        }
    }

    pub fn settings(&self) -> Settings {
        self.read("settings.json").unwrap_or_default()
    }

    pub fn save_settings(&self, s: &Settings) {
        self.write("settings.json", s)
    }

    pub fn session(&self) -> Option<Session> {
        self.read("session.json")
    }

    pub fn save_session(&self, s: &Session) {
        self.write("session.json", s)
    }

    pub fn clear_session(&self) {
        let _ = std::fs::remove_file(self.dir.join("session.json"));
    }
}
