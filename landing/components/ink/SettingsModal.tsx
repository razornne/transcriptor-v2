"use client";
import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import type { Profile } from "@/lib/ink/api";
import { setPrivacyMode, UpgradeRequiredError } from "@/lib/ink/api";
import { saveSettings, type InkSettings } from "@/lib/ink/settings";
import { SUPPORTED_LANGUAGES } from "@/lib/ink/config";

// Оверлей налаштувань /v2 — поверх поточного стейту (не навігація).
// Розділи: Account · Recording defaults · Privacy · Appearance.
// Best Quality і Privacy Mode — тільки для max/team.
// Оптимістичний UI для Privacy Mode: flip → POST → rollback при помилці.
// DotField гасне до 0.35 автоматично (page.tsx передає mode="reading" при settingsOpen).

function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

function Toggle({
  checked, onChange, disabled, id,
}: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; id: string }) {
  return (
    <label className="i-toggle" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="i-toggle-track" />
      <span className="i-toggle-thumb" />
    </label>
  );
}

function MaxBadge() {
  return <span className="i-badge">MAX</span>;
}

export function SettingsModal({
  session, profile, settings, onSettingsChange, onClose, onSignOut,
}: {
  session: Session;
  profile: Profile | null;
  settings: InkSettings;
  onSettingsChange: (patch: Partial<InkSettings>) => void;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const plan = profile?.plan || "free";
  const isPremium = plan === "max" || plan === "team";

  // Privacy Mode — optimistic toggle
  const [privMode, setPrivMode] = useState<boolean>(!!profile?.privacy_mode);
  const [privSaving, setPrivSaving] = useState(false);
  const [privError, setPrivError] = useState("");

  useEffect(() => { setPrivMode(!!profile?.privacy_mode); }, [profile?.privacy_mode]);

  const handlePrivMode = async (next: boolean) => {
    if (privSaving) return;
    setPrivMode(next);
    setPrivError("");
    setPrivSaving(true);
    try {
      await setPrivacyMode(next);
    } catch (e) {
      setPrivMode(!next); // rollback
      if (e instanceof UpgradeRequiredError) {
        setPrivError("Requires Max or Team plan.");
      } else {
        setPrivError(e instanceof Error ? e.message : "save failed");
      }
    } finally {
      setPrivSaving(false);
    }
  };

  // Appearance: тема зі спостереженням за <html data-theme>
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    setTheme((document.documentElement.getAttribute("data-theme") || "light") as "light" | "dark");
  }, []);
  const toggleTheme = (next: "light" | "dark") => {
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("skriptly-theme", next); } catch {}
    setTheme(next);
  };

  // Закрити по Escape або по кліку на backdrop
  const backdropRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  const email = session.user?.email || "";
  const used = profile?.minutes_used || 0;
  const limit = profile?.minutes_limit || 60;
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const filledDots = Math.round(ratio * 16);

  const patch = (p: Partial<InkSettings>) => {
    const next = saveSettings(p);
    onSettingsChange(next);
  };

  return (
    <div
      ref={backdropRef}
      className="i-modal-back"
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="i-modal" role="dialog" aria-modal="true" aria-label="Settings">
        {/* ── header ── */}
        <div className="i-modal-header">
          <GearIcon />
          <span className="i-modal-title">Settings</span>
          <button type="button" className="i-modal-close" onClick={onClose} aria-label="Close settings">✕</button>
        </div>

        {/* ── body ── */}
        <div className="i-modal-body">

          {/* ── Account ── */}
          <section>
            <p className="i-msect-title">Account</p>
            <div className="i-msect-card">
              <div className="i-mrow">
                <div>
                  <div className="i-account-email">{email}</div>
                  <div className="i-account-plan">
                    {plan.charAt(0).toUpperCase() + plan.slice(1)} plan
                  </div>
                </div>
              </div>
              <div className="i-mrow" style={{ flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
                <span className="i-mrow-label">Usage this month</span>
                <div className="i-usage-meter">
                  {Array.from({ length: 16 }, (_, k) => (
                    <span key={k} className={`i-um-dot${k < filledDots ? " fill" : ""}`} />
                  ))}
                  <span className="i-um-label">
                    {Math.round(used / 60 * 10) / 10} / {Math.round(limit / 60)}h
                  </span>
                </div>
              </div>
            </div>
            <button type="button" className="i-signout" onClick={() => { onSignOut(); onClose(); }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
              </svg>
              Sign out
            </button>
          </section>

          {/* ── Recording defaults ── */}
          <section>
            <p className="i-msect-title">Recording defaults</p>
            <div className="i-msect-card">
              <div className="i-mrow">
                <label className="i-mrow-label" htmlFor="s-lang">Language</label>
                <select
                  id="s-lang"
                  className="i-mini"
                  value={settings.language}
                  onChange={(e) => patch({ language: e.target.value })}
                >
                  {SUPPORTED_LANGUAGES.map((l) => (
                    <option key={l.value} value={l.value}>{l.label}</option>
                  ))}
                </select>
              </div>
              <div className="i-mrow">
                <label className="i-mrow-label" htmlFor="s-spk">Speakers</label>
                <select
                  id="s-spk"
                  className="i-mini"
                  value={settings.speakers}
                  onChange={(e) => patch({ speakers: e.target.value })}
                >
                  <option value="">Auto</option>
                  {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={String(n)}>{n}</option>)}
                </select>
              </div>

              {/* Best Quality — тільки max/team */}
              {isPremium && (
                <div className="i-mrow">
                  <div>
                    <div className="i-toggle-wrap">
                      <span className="i-mrow-label">Best Quality</span>
                      <MaxBadge />
                    </div>
                    <div className="i-mrow-sub">large-v3 — slower but more accurate</div>
                  </div>
                  <Toggle
                    id="s-quality"
                    checked={settings.quality === "best"}
                    onChange={(v) => patch({ quality: v ? "best" : "fast" })}
                  />
                </div>
              )}
            </div>
          </section>

          {/* ── Privacy Mode — тільки max/team ── */}
          {isPremium && (
            <section>
              <p className="i-msect-title">Privacy</p>
              <div className="i-msect-card">
                <div className="i-mrow">
                  <div>
                    <div className="i-toggle-wrap">
                      <span className="i-mrow-label">Privacy Mode</span>
                      <MaxBadge />
                    </div>
                    <div className="i-mrow-sub">No Gemini — self-hosted models only</div>
                    {privError && <div className="i-error" style={{ marginTop: 4 }}>{privError}</div>}
                  </div>
                  <Toggle
                    id="s-privacy"
                    checked={privMode}
                    onChange={handlePrivMode}
                    disabled={privSaving}
                  />
                </div>
              </div>
            </section>
          )}

          {/* ── Appearance ── */}
          <section>
            <p className="i-msect-title">Appearance</p>
            <div className="i-msect-card">
              <div className="i-mrow" style={{ gap: 6 }}>
                <span className="i-mrow-label">Theme</span>
                <div className="i-theme-seg">
                  <button
                    type="button"
                    className={`i-theme-btn${theme === "light" ? " on" : ""}`}
                    onClick={() => toggleTheme("light")}
                  >
                    Light
                  </button>
                  <button
                    type="button"
                    className={`i-theme-btn${theme === "dark" ? " on" : ""}`}
                    onClick={() => toggleTheme("dark")}
                  >
                    Dark
                  </button>
                </div>
              </div>
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}
