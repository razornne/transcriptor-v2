// Пауза медиа на время диктовки: YouTube/сериал в браузере, Spotify, плееры — всё,
// что Windows показывает в системной медиапанели (Global System Media Transport
// Controls). Ставим на паузу только то, что реально играет, и после диктовки
// возобновляем ровно эти сессии. Клавиша Play/Pause не годится: если ничего не
// играло, она наоборот включила бы музыку.
use std::sync::Mutex;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

/// AppUserModelId сессий, которые поставили на паузу мы.
static PAUSED: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn manager() -> windows::core::Result<Manager> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED); // WinRT на рабочем потоке
    }
    Manager::RequestAsync()?.get()
}

/// Блокирующая (десятки мс): вызывать из spawn_blocking.
pub fn pause_playing() {
    let res = (|| -> windows::core::Result<Vec<String>> {
        let mut paused = vec![];
        for s in manager()?.GetSessions()? {
            if s.GetPlaybackInfo()?.PlaybackStatus()? == Status::Playing && s.TryPauseAsync()?.get()? {
                paused.push(s.SourceAppUserModelId()?.to_string());
            }
        }
        Ok(paused)
    })();
    match res {
        Ok(p) => {
            if !p.is_empty() {
                crate::log!("[media] paused {p:?}");
            }
            PAUSED.lock().unwrap().extend(p);
        }
        Err(e) => crate::log!("[media] pause failed: {e}"),
    }
}

/// Возобновить то, что ставили на паузу (если юзер сам не переключил трек/вкладку).
pub fn resume() {
    let ids: Vec<String> = std::mem::take(&mut *PAUSED.lock().unwrap());
    if ids.is_empty() {
        return;
    }
    let res = (|| -> windows::core::Result<()> {
        for s in manager()?.GetSessions()? {
            let id = s.SourceAppUserModelId()?.to_string();
            if ids.contains(&id) && s.GetPlaybackInfo()?.PlaybackStatus()? == Status::Paused {
                let _ = s.TryPlayAsync()?.get();
            }
        }
        Ok(())
    })();
    if let Err(e) = res {
        crate::log!("[media] resume failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Только чтение: какие медиасессии видит Windows (ничего не ставит на паузу).
    #[test]
    #[ignore]
    fn lists_media_sessions() {
        let sessions = manager().expect("SMTC manager").GetSessions().expect("sessions");
        for s in sessions {
            println!("{} → {:?}", s.SourceAppUserModelId().unwrap(), s.GetPlaybackInfo().unwrap().PlaybackStatus().unwrap());
        }
    }
}
