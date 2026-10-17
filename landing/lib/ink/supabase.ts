"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";
import { desktopAccessToken, isDesktop } from "./desktop";

// Supabase-клиент используется ТОЛЬКО для auth (Google OAuth + magic link).
// Запросы к Postgres идут raw fetch'ем (lib/ink/db.ts): PostgrestClient
// в нашей среде зависал на .then() — проверенный паттерн из старого app
// (см. CLAUDE.md "Supabase JS PostgrestClient зависает").
//
// В окне приложения Skriptly сессией владеет приложение (lib/ink/session.ts):
// клиент берёт токен у него и НЕ трогает sb.auth — иначе два клиента делили бы
// один refresh-токен и разлогинивали друг друга.
function make(): SupabaseClient {
  if (isDesktop()) {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      accessToken: async () => (await desktopAccessToken()) ?? SUPABASE_ANON_KEY,
    }) as unknown as SupabaseClient;
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

export const sb: SupabaseClient = make();
