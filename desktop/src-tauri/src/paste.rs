// Вставка текста в активное окно: буфер обмена + Ctrl+V, потом возвращаем
// юзеру его прежний буфер (текст или картинку). Печать посимвольно
// (KEYEVENTF_UNICODE) медленная на длинном тексте и ломается в части приложений.
use crate::hotkey::{key_input, modifiers_held, send_keys};
use std::time::{Duration, Instant};

const VK_CONTROL: u16 = 0x11;
const VK_V: u16 = 0x56;

enum Saved {
    Text(String),
    Image(arboard::ImageData<'static>),
    Nothing,
}

/// Блокирующая: вызывать из spawn_blocking.
pub fn paste(text: &str) -> Result<(), String> {
    // Юзер ещё держит Ctrl/Win после горячей клавиши — Win+Ctrl+V открыл бы
    // системную панель звука. Ждём отпускания (не дольше 3 с).
    let until = Instant::now() + Duration::from_secs(3);
    while modifiers_held() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(15));
    }

    let mut cb = arboard::Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
    let saved = match cb.get_text() {
        Ok(t) => Saved::Text(t),
        Err(_) => cb.get_image().map(|i| Saved::Image(i.to_owned_img())).unwrap_or(Saved::Nothing),
    };
    cb.set_text(text.to_string()).map_err(|e| format!("clipboard: {e}"))?;
    std::thread::sleep(Duration::from_millis(30));
    send_keys(&[
        key_input(VK_CONTROL, false),
        key_input(VK_V, false),
        key_input(VK_V, true),
        key_input(VK_CONTROL, true),
    ]);
    // Приложение читает буфер асинхронно — не возвращаем старое содержимое слишком рано.
    std::thread::sleep(Duration::from_millis(400));
    match saved {
        Saved::Text(t) => {
            let _ = cb.set_text(t);
        }
        Saved::Image(i) => {
            let _ = cb.set_image(i);
        }
        Saved::Nothing => {}
    }
    Ok(())
}

pub fn copy(text: &str) {
    if let Ok(mut cb) = arboard::Clipboard::new() {
        let _ = cb.set_text(text.to_string());
    }
}
