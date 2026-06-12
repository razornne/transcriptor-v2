"use client";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";

// Supabase-клиент используется ТОЛЬКО для auth (Google OAuth + magic link).
// Запросы к Postgres идут raw fetch'ем (lib/ink/db.ts): PostgrestClient
// в нашей среде зависал на .then() — проверенный паттерн из старого app
// (см. CLAUDE.md "Supabase JS PostgrestClient зависает").
export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
