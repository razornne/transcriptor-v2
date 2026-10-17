// Команды, которые вообще можно вызвать со страницы. Всё остальное закрыто, а для
// удалённой страницы (skriptly.io) нужные разрешены поимённо в capabilities/remote.json.
const COMMANDS: &[&str] = &[
    "app_url",
    "open_external",
    "get_state",
    "desktop_session",
    "sign_in_google",
    "sign_in_email",
    "sign_out",
    "forget_token",
    "save_settings",
    "open_log_folder",
    "set_hotkey",
    "hotkey_label",
    "reset_hotkey",
    "call_start",
    "call_stop",
    "call_take",
    "call_pending",
    "call_discard",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri build");
}
