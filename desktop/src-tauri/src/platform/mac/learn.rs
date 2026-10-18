// macOS: чтение поля в фокусе — не реализовано (Accessibility API).
pub struct Field;

pub fn focused_field() -> Option<Field> {
    None
}

impl Field {
    pub fn read(&self, _max_chars: usize) -> Option<String> {
        None
    }
}
