// Значения зеркалят landing/lib/ink/config.ts (бэкенд один на веб и десктоп).

pub const API_BASE: &str = "https://razornne--transcriptor-v2-flask-app.modal.run";
pub const WEB_APP: &str = "https://skriptly.io/app";
pub const SUPABASE_URL: &str = "https://bmonakhktbaliwgobrxv.supabase.co";
// Публичный anon-ключ (тот же, что в вебе) — безопасно держать в клиенте.
pub const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtb25ha2hrdGJhbGl3Z29icnh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMTY4OTMsImV4cCI6MjA5NDc5Mjg5M30.HeY7nTJrAKPPHNRrPQwrIlx0HTd5L8a3xYZNgL-zWX4";

// Вход: браузер → Supabase → редирект на этот адрес (должен быть в Supabase
// Auth → URL Configuration → Redirect URLs).
pub const LOOPBACK_PORT: u16 = 53682;

pub const SONIOX_WS: &str = "wss://stt-rt.soniox.com/transcribe-websocket";
