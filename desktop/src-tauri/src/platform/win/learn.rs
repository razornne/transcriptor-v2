// Windows: чтение текстового поля в фокусе через UI Automation (TextPattern, иначе ValuePattern).
// Нужно только для обучения на правках (learn.rs): после вставки смотрим, поправил ли юзер слово.
// Парольные поля не читаем. Вызывать на одном потоке: COM-объекты живут на нём.
use windows::core::Interface;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern, IUIAutomationValuePattern,
    UIA_TextPatternId, UIA_ValuePatternId,
};

pub struct Field {
    _uia: IUIAutomation,
    el: IUIAutomationElement,
}

/// Поле ввода в фокусе (None — нет фокуса, пароль или UIA недоступен).
pub fn focused_field() -> Option<Field> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let el = uia.GetFocusedElement().ok()?;
        if el.CurrentIsPassword().ok()?.as_bool() {
            return None;
        }
        Some(Field { _uia: uia, el })
    }
}

impl Field {
    /// Весь текст поля (до `max_chars`; больше — None, такие документы не читаем).
    pub fn read(&self, max_chars: usize) -> Option<String> {
        unsafe {
            if let Ok(p) = self.el.GetCurrentPattern(UIA_TextPatternId) {
                if let Ok(tp) = p.cast::<IUIAutomationTextPattern>() {
                    if let Ok(range) = tp.DocumentRange() {
                        if let Ok(t) = range.GetText(max_chars as i32 + 1) {
                            let t = t.to_string();
                            return (t.chars().count() <= max_chars).then_some(t);
                        }
                    }
                }
            }
            if let Ok(p) = self.el.GetCurrentPattern(UIA_ValuePatternId) {
                if let Ok(vp) = p.cast::<IUIAutomationValuePattern>() {
                    if let Ok(v) = vp.CurrentValue() {
                        let t = v.to_string();
                        return (t.chars().count() <= max_chars).then_some(t);
                    }
                }
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    /// Ручной прогон: открывает Блокнот, вставляет текст и читает его через UI Automation.
    /// `cargo test -- --ignored reads_notepad` (окно Блокнота закрывается в конце).
    #[test]
    #[ignore]
    fn reads_notepad() {
        let mut child = std::process::Command::new("notepad.exe").spawn().expect("notepad");
        std::thread::sleep(std::time::Duration::from_secs(4));
        crate::paste::paste("hello pozhika world").expect("paste");
        std::thread::sleep(std::time::Duration::from_millis(1200));
        let field = super::focused_field();
        let text = field.as_ref().and_then(|f| f.read(10_000));
        let _ = child.kill();
        println!("read: {text:?}");
        assert!(text.is_some_and(|t| t.contains("hello pozhika world")));
    }
}
