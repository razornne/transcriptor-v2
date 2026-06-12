// Конфигурация Ink-аппки (/v2). Значения зеркалят боевой templates/index.html.

// API напрямую на Modal, мимо Vercel-прокси: Vercel Edge имеет ~4MB body
// limit на проксированных запросах — аудио легко больше (см. CLAUDE.md).
// CORS на Flask открыт. На localhost тоже бьём в прод-Modal (бэк один).
export const API_BASE = "https://razornne--transcriptor-v2-flask-app.modal.run";

// Публичные client-side ключи Supabase (безопасно в коде)
export const SUPABASE_URL = "https://bmonakhktbaliwgobrxv.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtb25ha2hrdGJhbGl3Z29icnh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMTY4OTMsImV4cCI6MjA5NDc5Mjg5M30.HeY7nTJrAKPPHNRrPQwrIlx0HTd5L8a3xYZNgL-zWX4";

export const SUPPORTED_LANGUAGES = [
  { value: "", label: "Auto" },
  { value: "en", label: "EN" },
  { value: "ru", label: "RU" },
  { value: "uk", label: "UK" },
  { value: "pl", label: "PL" },
] as const;
