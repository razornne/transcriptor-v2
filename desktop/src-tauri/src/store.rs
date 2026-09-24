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
    /// Сочетание для диктовки — виртуальные коды клавиш (hotkey.rs), по умолчанию Ctrl+Win.
    pub hotkey: Vec<u16>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            language: String::new(),
            cleanup: true,
            mic: None,
            autostart: true,
            hotkey: crate::hotkey::DEFAULT_HOTKEY.to_vec(),
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

    fn write<T: Serialize>(&self, name: &str, v: &T) {
        if let Ok(s) = serde_json::to_string_pretty(v) {
            let tmp = self.dir.join(format!("{name}.tmp"));
            if std::fs::write(&tmp, s).is_ok() {
                let _ = std::fs::rename(tmp, self.dir.join(name));
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
