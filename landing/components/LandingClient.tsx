"use client";
import { useEffect, useState, type ReactNode } from "react";
import "@/app/landing.css";
import { COPY, type Copy, type Lang, type PricingPlan } from "@/lib/content";
import { useReveal, useTween } from "@/lib/hooks";

type Os = "windows" | "mac" | "other";
type Billing = "monthly" | "annual";

const APP_URL = "/app";
const DOWNLOAD_URL = "/api/download/windows";
const WAITLIST_ANCHOR = "#desktop-wait";

const WinIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M3 5.5 10.5 4.5V11H3zM11.5 4.4 21 3v8h-9.5zM3 12.5h7.5V19L3 18zM11.5 12.5H21V21l-9.5-1.4z" />
  </svg>
);

const WAY_ICONS = {
  call: <path d="M9 3h6v11H9zM5 11a7 7 0 0 0 14 0M12 18v3" />,
  dictate: <path d="M4 7h16M4 12h10M4 17h13" />,
  file: <path d="M12 16V4m0 0-4 4m4-4 4 4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />,
};

function detectOs(): Os {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return "other";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  return "windows";
}

function planHref(name: string, billing: Billing): string {
  const n = name.toLowerCase();
  if (n === "free") return APP_URL;
  return `${APP_URL}?upgrade=${n}&billing=${billing}`;
}

function Money({ value, currency }: { value: ReactNode; currency: "$" | "₴" }) {
  return currency === "$" ? <>${value}</> : <>{value} ₴</>;
}

function Price({ plan, billing }: { plan: PricingPlan; billing: Billing }) {
  const target = billing === "annual" ? plan.annual : plan.monthly;
  const v = useTween(target, 280);
  const strike = billing === "annual" && plan.monthly > plan.annual;
  return (
    <div className="lp-price">
      <span className="amt"><Money value={Math.round(v)} currency={plan.currency} /></span>
      <span className="per">{plan.per}</span>
      {strike && <span className="strike"><Money value={plan.monthly} currency={plan.currency} /></span>}
    </div>
  );
}

function Nav({ t, lang, setLang }: { t: Copy; lang: Lang; setLang: (l: Lang) => void }) {
  const [scrolled, setScrolled] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    setTheme((document.documentElement.getAttribute("data-theme") as "light" | "dark") || "light");
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("skriptly-theme", next); } catch {}
    setTheme(next);
  };

  return (
    <header className={"lp-nav" + (scrolled ? " scrolled" : "")}>
      <div className="lp-wrap lp-nav-in">
        <a className="lp-logo" href="#top" aria-label="Skriptly">
          <span className="lp-logo-mark" aria-hidden="true">S</span>
          <span>Skriptly</span>
        </a>
        <nav className="lp-links" aria-label="Primary">
          <a href="#features">{t.nav.features}</a>
          <a href="#desktop">{t.nav.desktop}</a>
          <a href="#pricing">{t.nav.pricing}</a>
          <a href="#faq">{t.nav.faq}</a>
        </nav>
        <div className="lp-tools">
          <div className="lp-seg" role="group" aria-label="Language">
            {(["en", "ua"] as Lang[]).map((l) => (
              <button key={l} type="button" className={lang === l ? "on" : ""} aria-pressed={lang === l} onClick={() => setLang(l)}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <button type="button" className="lp-icon-btn" onClick={toggleTheme} aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}>
            {theme === "light" ? (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
            ) : (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>
            )}
          </button>
          <a className="lp-btn lp-btn-primary lp-btn-sm" href={APP_URL}><span className="lp-full">{t.nav.openApp}</span><span className="lp-short">{t.nav.openAppShort}</span></a>
        </div>
      </div>
    </header>
  );
}

// Вторая кнопка героя и финала: Windows → скачать, Mac → вейтлист, телефон → ничего лишнего.
function OsButton({ t, os, label }: { t: Copy; os: Os; label: string }) {
  if (os === "other") return null;
  if (os === "mac") {
    return <a className="lp-btn lp-btn-ghost" href={WAITLIST_ANCHOR}>{t.hero.ctaMacWait}</a>;
  }
  return <a className="lp-btn lp-btn-ghost" href={DOWNLOAD_URL}><WinIcon />{label}</a>;
}

function Hero({ t, os }: { t: Copy; os: Os }) {
  const m = t.mock;
  return (
    <section className="lp-wrap lp-hero" id="top">
      <div className="lp-hero-copy">
        <div className="lp-eyebrow">{t.hero.eyebrow}</div>
        <h1 className="lp-h1">{t.hero.titleA} <em>{t.hero.titleAccent}</em></h1>
        <p className="lp-sub">{t.hero.sub}</p>
        <div className="lp-cta">
          <a className="lp-btn lp-btn-primary" href={APP_URL}>{t.hero.ctaPrimary}</a>
          <OsButton t={t} os={os} label={t.hero.ctaWin} />
        </div>
        <div className="lp-note">{os === "mac" ? t.hero.noteMac : t.hero.note}</div>
      </div>

      <div className="lp-hero-mock" aria-hidden="true">
        <div className="lp-win">
          <div className="lp-win-bar"><i /><i /><i /><span>{m.title}</span></div>
          <div className="lp-win-body">
            <div className="lp-share">
              {m.speakers.map((s) => <span key={s.name} style={{ width: `${s.share}%` }} />)}
            </div>
            <div className="lp-legend">
              {m.speakers.map((s) => (
                <span key={s.name} className={"t" + s.tone}>{s.name} <small>{s.share}%</small></span>
              ))}
            </div>
            <div className="lp-suggest">
              <span><b>{m.suggest.text}</b> <em>{m.suggest.quote}</em></span>
              <span className="acc">{m.suggest.accept}</span>
            </div>
            {m.lines.map((l) => (
              <div className="lp-turn" key={l.time}>
                <div className={"lp-av t" + l.tone}>{l.initial}</div>
                <div>
                  <div className={"lp-turn-name t" + l.tone}>{l.name} <small>{l.time}</small></div>
                  <p>{l.text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Facts({ t }: { t: Copy }) {
  return (
    <section className="lp-facts" aria-label="Facts">
      <div className="lp-wrap lp-facts-in">
        {t.facts.map((f) => <span key={f}>{f}</span>)}
      </div>
    </section>
  );
}

function Dictation({ t }: { t: Copy }) {
  const d = t.dictation;
  return (
    <section className="lp-wrap lp-dict">
      <div className="lp-dict-copy lp-rv">
        <div className="lp-eyebrow">{d.eyebrow}</div>
        <h2 className="lp-h2">{d.titleA} <em>{d.titleAccent}</em>.<br />{d.titleB}</h2>
        <p>{d.subBefore}<b>{d.keys.join(" + ")}</b>{d.subAfter}</p>
        <div className="lp-keys">
          <span className="lp-key">{d.keys[0]}</span><span>+</span><span className="lp-key">{d.keys[1]}</span>
          <small>{d.keysHint}</small>
        </div>
      </div>
      <div className="lp-dict-demo lp-rv">
        <div className="lp-say">
          <div className="lp-card-label">{d.sayLabel}</div>
          <p>{d.say.map((f, i) => (f.x ? <s key={i}>{f.t}</s> : <span key={i}>{f.t}</span>))}</p>
        </div>
        <div className="lp-get">
          <div className="lp-card-label">{d.getLabel}</div>
          <p>{d.getBefore}<mark>{d.getMark}</mark>{d.getAfter}</p>
        </div>
      </div>
    </section>
  );
}

function Ways({ t }: { t: Copy }) {
  return (
    <section className="lp-wrap lp-section" id="how">
      <div className="lp-rv">
        <div className="lp-eyebrow">{t.ways.eyebrow}</div>
        <h2 className="lp-h2">{t.ways.title}</h2>
        <p className="lp-lede">{t.ways.sub}</p>
      </div>
      <div className="lp-grid">
        {t.ways.items.map((it, i) => (
          <div key={it.kind} className={"lp-card lp-rv" + (it.kind === "file" ? " dashed" : "")} style={{ transitionDelay: `${i * 70}ms` }}>
            <div className={"lp-ic " + it.kind}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {WAY_ICONS[it.kind]}
              </svg>
            </div>
            <h3>{it.h}</h3>
            <p>{it.p}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Features({ t }: { t: Copy }) {
  return (
    <section className="lp-wrap lp-section" id="features">
      <div className="lp-rv">
        <div className="lp-eyebrow">{t.features.eyebrow}</div>
        <h2 className="lp-h2">{t.features.titleA} <em>{t.features.titleAccent}</em></h2>
      </div>
      <div className="lp-grid">
        {t.features.items.map((f, i) => (
          <div key={f.h} className="lp-card lp-feat lp-rv" style={{ transitionDelay: `${(i % 3) * 70}ms` }}>
            <h3>{f.h}</h3>
            <p>{f.p}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

type DlInfo = { available: boolean; version?: string; size_mb?: number };

function Waitlist({ t, lang }: { t: Copy; lang: Lang }) {
  const w = t.desktop.wait;
  const [email, setEmail] = useState("");
  const [hp, setHp] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state === "sending") return;
    setState("sending");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), platform: "macos", lang, website: hp }),
      });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  };

  return (
    <div className="lp-wait" id="desktop-wait">
      <b>{w.title}</b>
      <span>{w.sub}</span>
      {state === "done" ? (
        <p className="lp-wait-msg ok" role="status">{w.done}</p>
      ) : (
        <form onSubmit={submit} noValidate={false}>
          <input
            type="email" required inputMode="email" autoComplete="email" aria-label="Email"
            placeholder={w.placeholder} value={email} onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="lp-hp" type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true"
            value={hp} onChange={(e) => setHp(e.target.value)}
          />
          <button className="lp-btn" type="submit" disabled={state === "sending"}>
            {state === "sending" ? w.sending : w.button}
          </button>
        </form>
      )}
      {state === "error" && <p className="lp-wait-msg err" role="alert">{w.error}</p>}
      {state !== "done" && <small>{w.privacy}</small>}
    </div>
  );
}

function Desktop({ t, lang }: { t: Copy; lang: Lang }) {
  const d = t.desktop;
  const [info, setInfo] = useState<DlInfo | null>(null);

  useEffect(() => {
    let off = false;
    fetch("/api/download/windows/info")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!off && j) setInfo(j); })
      .catch(() => {});
    return () => { off = true; };
  }, []);

  const line = info?.available && info.version && info.size_mb
    ? d.infoVersion.replace("{v}", info.version).replace("{mb}", String(info.size_mb))
    : d.infoDefault;

  return (
    <section className="lp-wrap lp-section" id="desktop">
      <div className="lp-plate lp-rv">
        <div className="lp-plate-copy">
          <div className="lp-eyebrow">{d.eyebrow}</div>
          <h2>{d.titleA} <em>{d.titleAccent}</em></h2>
          <p className="lp-plate-sub">{d.sub}</p>
          <div className="lp-plate-cta">
            <a className="lp-btn lp-btn-paper" href={DOWNLOAD_URL}><WinIcon />{d.ctaWin}</a>
            <span className="lp-pill">{d.macSoon}</span>
          </div>
          <div className="lp-plate-info">{line}</div>
          <Waitlist t={t} lang={lang} />
        </div>
        <div className="lp-perks">
          {d.perks.map((p) => (
            <div className="lp-perk" key={p.h}><b>{p.h}</b><div>{p.p}</div></div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Pricing({ t }: { t: Copy }) {
  const [billing, setBilling] = useState<Billing>("monthly");
  const p = t.pricing;
  return (
    <section className="lp-wrap lp-section" id="pricing">
      <div className="lp-rv">
        <div className="lp-eyebrow">{p.eyebrow}</div>
        <h2 className="lp-h2">{p.title}</h2>
        <p className="lp-lede">{p.sub}</p>
      </div>
      <div className="lp-bill">
        <div className="lp-seg" role="group" aria-label="Billing period">
          <button type="button" className={billing === "monthly" ? "on" : ""} aria-pressed={billing === "monthly"} onClick={() => setBilling("monthly")}>{p.monthly}</button>
          <button type="button" className={billing === "annual" ? "on" : ""} aria-pressed={billing === "annual"} onClick={() => setBilling("annual")}>{p.annual}</button>
        </div>
        <span className={"lp-save" + (billing === "annual" ? " on" : "")}>{p.save}</span>
      </div>
      <div className="lp-plans">
        {p.plans.map((plan, i) => (
          <article key={plan.name} className={"lp-plan lp-rv" + (plan.featured ? " featured" : "")} style={{ transitionDelay: `${i * 70}ms` }}>
            <div className="lp-plan-head">{plan.name}{plan.badge && <span className="lp-badge">{plan.badge}</span>}</div>
            <div className="lp-tag">{plan.tagline}</div>
            <Price plan={plan} billing={billing} />
            <ul>{plan.features.map((f) => <li key={f}>{f}</li>)}</ul>
            <div className="lp-plan-foot">
              {plan.fine && <div className="lp-fine">{plan.fine}</div>}
              <a className={"lp-btn " + (plan.ctaKind === "primary" ? "lp-btn-primary" : "lp-btn-ghost")} href={planHref(plan.name, billing)}>{plan.cta}</a>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function Faq({ t }: { t: Copy }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section className="lp-wrap lp-faq lp-section" id="faq">
      <h2 className="lp-rv">{t.faq.title}</h2>
      <div className="lp-faq-list">
        {t.faq.items.map((it, i) => (
          <div key={it.q} className={"lp-q" + (open === i ? " open" : "")}>
            <button type="button" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
              {it.q}<span aria-hidden="true">+</span>
            </button>
            <div className="lp-q-a"><div><p>{it.a}</p></div></div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Final({ t, os }: { t: Copy; os: Os }) {
  return (
    <section className="lp-wrap lp-final">
      <h2 className="lp-rv">{t.final.titleA} <em>{t.final.titleAccent}</em></h2>
      <div className="lp-cta">
        <a className="lp-btn lp-btn-primary" href={APP_URL}>{t.final.ctaPrimary}</a>
        <OsButton t={t} os={os} label={t.final.ctaWin} />
      </div>
      <div className="lp-note">{t.final.fine}</div>
    </section>
  );
}

function Footer({ t }: { t: Copy }) {
  return (
    <footer className="lp-foot">
      <div className="lp-wrap lp-foot-in">
        <span className="brand"><i>S</i>{t.foot.copy}</span>
        <span className="lp-foot-links">
          {t.foot.links.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
        </span>
      </div>
    </footer>
  );
}

export function LandingClient() {
  const [lang, setLang] = useState<Lang>("en");
  const [os, setOs] = useState<Os>("windows");

  useEffect(() => {
    let saved: Lang = "en";
    try { saved = ((localStorage.getItem("skriptly-lang") as Lang | null) || "en"); } catch {}
    setLang(saved);
    setOs(detectOs());
  }, []);

  const changeLang = (v: Lang) => {
    setLang(v);
    document.documentElement.setAttribute("data-lang", v);
    document.documentElement.lang = v === "ua" ? "uk" : "en";
    try { localStorage.setItem("skriptly-lang", v); } catch {}
  };

  useReveal(".lp-rv");

  const t = COPY[lang];
  return (
    <div className="lp">
      <Nav t={t} lang={lang} setLang={changeLang} />
      <main>
        <Hero t={t} os={os} />
        <Facts t={t} />
        <Dictation t={t} />
        <Ways t={t} />
        <Features t={t} />
        <Desktop t={t} lang={lang} />
        <Pricing t={t} />
        <Faq t={t} />
        <Final t={t} os={os} />
      </main>
      <Footer t={t} />
    </div>
  );
}
