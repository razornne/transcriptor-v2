// Всё, что зависит от операционной системы, живёт здесь; остальной код приложения общий.
// Общий для платформ ключ клавиши — «виртуальный код Windows» (VK): им хранятся шорткаты в настройках
// и кодирует их страница; macOS-слой переводит их из/в свои коды.
//
//   keyboard — глобальный перехват клавиш, Ctrl/Cmd+V, «зажат ли модификатор»
//   overlay  — окно плашки диктовки: окно без фокуса, поверх всех, положение, полноэкранные окна
//   media    — пауза/возобновление играющего медиа
//   learn    — чтение текстового поля после вставки (обучение на правках)
//   loopback — звук компьютера для записи звонка
//   config_base — где лежат настройки и сессия
#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use self::win::*;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
pub use self::mac::*;

#[cfg(not(any(windows, target_os = "macos")))]
compile_error!("Skriptly desktop supports Windows and macOS only");
