// PostHog для лендинга: события воронки (CTA, скачивание, вейтлист, тарифы).
// Тот же проект и reverse proxy /ingest, что у приложения. Реплеи и автозахват здесь выключены:
// на лендинге нам нужны только именованные события.
/* eslint-disable @typescript-eslint/no-explicit-any */
const KEY = "phc_yXYdbAQoySKp6BaHbpkZ3kawiByFRjERMYo5VBNMyvFE";

const ph = (): any => (typeof window !== "undefined" ? (window as any).posthog : null);

export function initAnalytics() {
  if (typeof window === "undefined") return;
  const w = window as any;
  if (w.__lp_ph_init || w.__ink_ph_init) return;
  w.__lp_ph_init = true;

  const isLocal = location.hostname === "localhost";
  const apiHost = isLocal ? "https://eu.i.posthog.com" : `${location.origin}/ingest`;
  const staticHost = isLocal ? "https://eu-assets.i.posthog.com" : `${location.origin}/ingest`;

  const script = document.createElement("script");
  script.src = `${staticHost}/static/array.js`;
  script.defer = true;
  script.onload = () => {
    w.posthog?.init?.(KEY, {
      api_host: apiHost,
      ui_host: "https://eu.posthog.com",
      person_profiles: "identified_only",
      autocapture: false,
      disable_session_recording: true,
      capture_pageview: true,
    });
  };
  document.head.appendChild(script);
}

export function track(event: string, props?: Record<string, unknown>) {
  try { ph()?.capture?.(event, props); } catch { /* аналитика не должна ломать страницу */ }
}

// Клики по элементам с data-track="имя" (и необязательным data-loc="место") — одним обработчиком на страницу.
export function trackClicksByAttribute(root: HTMLElement) {
  const onClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement | null)?.closest?.("[data-track]") as HTMLElement | null;
    if (!el) return;
    const name = el.dataset.track!;
    const props: Record<string, unknown> = { location: el.dataset.loc || null };
    if (el.dataset.plan) props.plan = el.dataset.plan;
    track(name, props);
  };
  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}
