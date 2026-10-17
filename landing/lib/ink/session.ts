"use client";
// Сессия пользователя. В браузере — Supabase Auth как раньше; в окне приложения
// сессией владеет само приложение (вход через системный браузер, обновление
// токена в Rust), а страница только спрашивает у него свежий токен.
// Один refresh-токен на двух клиентов нельзя: при ротации один из них разлогинится.
import { sb } from "./supabase";
import { desktopInvoke, desktopListen, isDesktop, type DesktopSession } from "./desktop";

/** Минимум, который нужен странице от сессии (supabase Session ему удовлетворяет). */
export type AppSession = {
  access_token: string;
  user: { id: string; email?: string };
};

async function desktopSession(): Promise<AppSession | null> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const s = await desktopInvoke<DesktopSession>("desktop_session");
      if (!s.signed_in || !s.access_token || !s.user) return null;
      return { access_token: s.access_token, user: s.user };
    } catch (e) {
      lastErr = e; // сеть моргнула — обновление токена не удалось, пробуем ещё
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  console.warn("[session] desktop_session failed:", lastErr);
  return null;
}

export async function getAccessToken(): Promise<string | null> {
  if (isDesktop()) return (await desktopSession())?.access_token ?? null;
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function getSessionUser(): Promise<AppSession["user"] | null> {
  if (isDesktop()) return (await desktopSession())?.user ?? null;
  const { data } = await sb.auth.getSession();
  return data.session?.user ?? null;
}

/** Подписка на сессию: сразу отдаёт текущую (null — не вошёл), затем следит за входом/выходом. */
export function watchSession(cb: (s: AppSession | null) => void): () => void {
  if (isDesktop()) {
    let alive = true;
    const push = () => { void desktopSession().then((s) => { if (alive) cb(s); }); };
    push();
    let un: (() => void) | undefined;
    void desktopListen("auth-changed", push).then((u) => { if (alive) un = u; else u(); });
    return () => { alive = false; un?.(); };
  }
  void sb.auth.getSession().then(({ data }) => cb(data.session));
  const { data: sub } = sb.auth.onAuthStateChange((_e, s) => cb(s));
  return () => sub.subscription.unsubscribe();
}

export async function signOutEverywhere(): Promise<void> {
  if (isDesktop()) await desktopInvoke("sign_out");
  else await sb.auth.signOut();
}
