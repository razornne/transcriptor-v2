"use client";
// Мост «веб ↔ приложение Skriptly для Windows». Когда /app открыт в окне приложения
// (desktop/ → Tauri), страница получает нативные возможности: запись звонка
// (микрофон + звук компьютера), сессию, настройки диктовки. В обычном браузере
// всё это недоступно — isDesktop() === false, и страница работает как раньше.
//
// Список команд ограничен на стороне приложения: desktop/src-tauri/build.rs
// и capabilities/remote.json.

type Invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T = unknown>(event: string, cb: (e: { payload: T }) => void) => Promise<() => void>;

type TauriInternals = {
  invoke: Invoke;
  transformCallback: (cb: (e: unknown) => void) => number;
  unregisterCallback?: (id: number) => void;
};

declare global {
  interface Window {
    __SKRIPTLY_DESKTOP__?: { version: string; platform: string };
    __TAURI__?: { core: { invoke: Invoke }; event: { listen: Listen } };
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

export function isDesktop(): boolean {
  return typeof window !== "undefined" && !!window.__SKRIPTLY_DESKTOP__;
}

export function desktopVersion(): string {
  return (typeof window !== "undefined" && window.__SKRIPTLY_DESKTOP__?.version) || "";
}

export function desktopInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const g = window.__TAURI__?.core.invoke;
  if (g) return g<T>(cmd, args);
  const i = window.__TAURI_INTERNALS__;
  if (i) return i.invoke<T>(cmd, args);
  return Promise.reject(new Error("desktop bridge unavailable"));
}

export async function desktopListen<T = unknown>(
  event: string,
  cb: (e: { payload: T }) => void,
): Promise<() => void> {
  const g = window.__TAURI__?.event.listen;
  if (g) return g<T>(event, cb);
  const i = window.__TAURI_INTERNALS__;
  if (!i) throw new Error("desktop bridge unavailable");
  // то же, что делает @tauri-apps/api/event
  const handler = i.transformCallback(cb as (e: unknown) => void);
  const id = await i.invoke<number>("plugin:event|listen", { event, target: { kind: "Any" }, handler });
  return () => {
    void i.invoke("plugin:event|unlisten", { event, eventId: id });
    i.unregisterCallback?.(handler);
  };
}

export type DesktopSession = {
  signed_in: boolean;
  access_token?: string;
  user?: { id: string; email: string };
};

/** Свежий токен от приложения (оно само обновляет refresh-токен). */
export async function desktopAccessToken(): Promise<string | null> {
  try {
    const s = await desktopInvoke<DesktopSession>("desktop_session");
    return s.signed_in ? s.access_token ?? null : null;
  } catch {
    return null;
  }
}

/** Ссылки target=_blank и window.open в окне приложения — в системный браузер. */
export function installExternalLinks(): () => void {
  if (!isDesktop()) return () => {};
  const open = (url: string) => { void desktopInvoke("open_external", { url }).catch(() => {}); };
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || e.defaultPrevented) return;
    const external = /^https?:/i.test(a.href) && new URL(a.href).origin !== window.location.origin;
    if (a.target === "_blank" || external) { e.preventDefault(); open(a.href); }
  };
  const nativeOpen = window.open;
  window.open = ((url?: string | URL) => {
    if (url) open(String(url));
    return null;
  }) as typeof window.open;
  document.addEventListener("click", onClick, true);
  return () => { document.removeEventListener("click", onClick, true); window.open = nativeOpen; };
}
