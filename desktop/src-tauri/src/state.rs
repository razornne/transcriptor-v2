use crate::api::LiveToken;
use crate::store::{Session, Settings, Store};
use std::sync::Mutex;

pub struct AppState {
    pub store: Store,
    pub settings: Mutex<Settings>,
    pub session: tokio::sync::Mutex<Option<Session>>,
    /// Временный ключ Soniox живёт час — держим его, чтобы диктовка стартовала
    /// без похода на сервер (там scale-to-zero, холодный старт — секунды).
    pub token: tokio::sync::Mutex<Option<LiveToken>>,
    pub last_text: Mutex<String>,
    pub http: reqwest::Client,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        let settings = store.settings();
        let session = store.session();
        Self {
            settings: Mutex::new(settings),
            session: tokio::sync::Mutex::new(session),
            token: tokio::sync::Mutex::new(None),
            last_text: Mutex::new(String::new()),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("http client"),
            store,
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }
}
