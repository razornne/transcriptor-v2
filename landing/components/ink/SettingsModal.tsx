"use client";
import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import type { Profile, WorkspaceInfo } from "@/lib/ink/api";
import {
  setPrivacyMode, UpgradeRequiredError,
  createWorkspace as apiCreateWorkspace,
  inviteMember as apiInviteMember,
  removeMember as apiRemoveMember,
  leaveWorkspace as apiLeaveWorkspace,
} from "@/lib/ink/api";
import { saveSettings, type InkSettings } from "@/lib/ink/settings";
import { SUPPORTED_LANGUAGES, BILLING_URL } from "@/lib/ink/config";

// SettingsModal v2 (Sprint 5) — двухколоночный макет.
// Левый nav (168px): Account | Subscription | Workspace | Settings | Invite | Danger.
// Правый content: динамическая панель для активного раздела.
// Custom webkit scrollbar 4px. Plan comparison cards.
// Workspace: create/invite/remove/leave. Referral link copy.

type NavSection = "account" | "subscription" | "workspace" | "settings" | "invite" | "danger";

const PLAN_DATA = [
  {
    id: "free", name: "Free", price: "$0", period: "forever", minutes: "60 min / mo",
    features: ["Basic transcription", "Speaker detection", "Export .md / .txt"],
  },
  {
    id: "pro", name: "Pro", price: "$15", period: "/mo", minutes: "600 min / mo",
    features: ["Everything in Free", "AI summary & actions", "Custom presets"],
  },
  {
    id: "max", name: "Max", price: "$29", period: "/mo", minutes: "1,800 min / mo",
    features: ["Everything in Pro", "large-v3 model", "Privacy mode", "Priority support"],
  },
] as const;

function Toggle({ checked, onChange, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; id: string }) {
  return (
    <label className="i-toggle" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="i-toggle-track" />
      <span className="i-toggle-thumb" />
    </label>
  );
}

function MaxBadge() { return <span className="i-badge">MAX</span>; }

function NavIcon({ id }: { id: NavSection }) {
  const p = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (id) {
    case "account": return <svg {...p}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>;
    case "subscription": return <svg {...p}><rect x="1" y="4" width="22" height="16" rx="2"/><path d="M1 10h22"/></svg>;
    case "workspace": return <svg {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
    case "settings": return <svg {...p}><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>;
    case "invite": return <svg {...p}><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>;
    case "danger": return <svg {...p}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
  }
}

const NAV_ITEMS: { id: NavSection; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "subscription", label: "Subscription" },
  { id: "workspace", label: "Workspace" },
  { id: "settings", label: "Settings" },
  { id: "invite", label: "Invite friends" },
  { id: "danger", label: "Danger zone" },
];

export function SettingsModal({
  session, profile, settings, onSettingsChange, onClose, onSignOut,
  workspace, onWorkspaceChange,
}: {
  session: Session;
  profile: Profile | null;
  settings: InkSettings;
  onSettingsChange: (patch: Partial<InkSettings>) => void;
  onClose: () => void;
  onSignOut: () => void;
  workspace?: WorkspaceInfo | null;
  onWorkspaceChange?: (ws: WorkspaceInfo | null) => void;
}) {
  const [nav, setNav] = useState<NavSection>("account");
  const plan = profile?.plan || "free";
  const isPremium = plan === "max" || plan === "team";

  // Best Quality
  const [qualityError, setQualityError] = useState("");
  const handleQuality = (v: boolean) => {
    if (v && !isPremium) { setQualityError("Requires Max or Team plan."); return; }
    setQualityError("");
    const next = saveSettings({ quality: v ? "best" : "fast" });
    onSettingsChange(next);
  };

  // Privacy Mode
  const [privMode, setPrivMode] = useState<boolean>(!!profile?.privacy_mode);
  const [privSaving, setPrivSaving] = useState(false);
  const [privError, setPrivError] = useState("");
  useEffect(() => { setPrivMode(!!profile?.privacy_mode); }, [profile?.privacy_mode]);

  const handlePrivMode = async (next: boolean) => {
    if (privSaving) return;
    if (next && !isPremium) { setPrivError("Requires Max or Team plan."); return; }
    setPrivMode(next); setPrivError(""); setPrivSaving(true);
    try {
      await setPrivacyMode(next);
    } catch (e) {
      setPrivMode(!next);
      setPrivError(e instanceof UpgradeRequiredError ? "Requires Max or Team plan." : (e instanceof Error ? e.message : "save failed"));
    } finally { setPrivSaving(false); }
  };

  // Theme
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => { setTheme((document.documentElement.getAttribute("data-theme") || "light") as "light" | "dark"); }, []);
  const toggleTheme = (next: "light" | "dark") => {
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("skriptly-theme", next); } catch {}
    setTheme(next);
  };

  // Workspace state
  const [wsName, setWsName] = useState("");
  const [wsCreating, setWsCreating] = useState(false);
  const [wsError, setWsError] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteOk, setInviteOk] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const handleCreateWs = async () => {
    if (!wsName.trim()) return;
    setWsCreating(true); setWsError("");
    try {
      const ws = await apiCreateWorkspace(wsName.trim());
      onWorkspaceChange?.(ws);
      setWsName("");
    } catch (e) {
      setWsError(e instanceof Error ? e.message : "failed");
    } finally { setWsCreating(false); }
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true); setInviteError(""); setInviteOk(false);
    try {
      await apiInviteMember(inviteEmail.trim());
      setInviteEmail(""); setInviteOk(true);
      setTimeout(() => setInviteOk(false), 3000);
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : "failed");
    } finally { setInviting(false); }
  };

  const handleRemoveMember = async (memberId: string) => {
    setRemoving(memberId);
    try {
      await apiRemoveMember(memberId);
      if (workspace) {
        onWorkspaceChange?.({ ...workspace, members: workspace.members.filter((m) => m.id !== memberId) });
      }
    } catch { /* best-effort */ } finally { setRemoving(null); }
  };

  const handleLeave = async () => {
    if (!window.confirm("Leave the workspace? You will lose access to shared recordings.")) return;
    setLeaving(true);
    try {
      await apiLeaveWorkspace();
      onWorkspaceChange?.(null);
      onClose();
    } catch { /* best-effort */ } finally { setLeaving(false); }
  };

  // Referral copy
  const [refCopied, setRefCopied] = useState(false);
  const refUrl = profile?.referral_code ? `https://skriptly.io?ref=${profile.referral_code}` : null;
  const copyRef = () => {
    if (!refUrl) return;
    navigator.clipboard.writeText(refUrl).then(() => { setRefCopied(true); setTimeout(() => setRefCopied(false), 2500); }).catch(() => {});
  };

  // Close on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  const backdropRef = useRef<HTMLDivElement>(null);
  const email = session.user?.email || "";
  const used = profile?.minutes_used || 0;
  const limit = profile?.minutes_limit || 60;
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const filledDots = Math.round(ratio * 16);

  return (
    <div
      ref={backdropRef}
      className="i-modal-back"
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="i-modal i-modal-wide" role="dialog" aria-modal="true" aria-label="Settings">
        {/* ── Header ── */}
        <div className="i-modal-header">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>
          </svg>
          <span className="i-modal-title">Settings</span>
          <button type="button" className="i-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* ── Two-column body ── */}
        <div className="i-modal-2col">
          {/* Left nav */}
          <nav className="i-modal-nav" aria-label="Settings navigation">
            {NAV_ITEMS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={`i-modal-nav-item${nav === id ? " on" : ""}${id === "danger" ? " danger" : ""}`}
                onClick={() => setNav(id)}
              >
                <NavIcon id={id} />
                {label}
              </button>
            ))}
          </nav>

          {/* Right content */}
          <div className="i-modal-content">

            {/* ── Account ── */}
            {nav === "account" && (
              <div className="i-modal-pane">
                <p className="i-msect-title">Account</p>
                <div className="i-msect-card">
                  <div className="i-mrow">
                    <div>
                      <div className="i-account-email">{email}</div>
                      <div className="i-account-plan">{plan.charAt(0).toUpperCase() + plan.slice(1)} plan</div>
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
              </div>
            )}

            {/* ── Subscription ── */}
            {nav === "subscription" && (
              <div className="i-modal-pane">
                <p className="i-msect-title">Your plan</p>
                <div className="i-plan-cards">
                  {PLAN_DATA.map((p) => (
                    <div key={p.id} className={`i-plan-card${p.id === plan ? " current" : ""}`}>
                      <div className="i-plan-name">{p.name}</div>
                      <div>
                        <span className="i-plan-price">{p.price}</span>
                        <span className="i-plan-price-period"> {p.period}</span>
                      </div>
                      <span className="i-plan-mins">{p.minutes}</span>
                      <div className="i-plan-feats">
                        {p.features.map((f) => (
                          <div key={f} className="i-plan-feat">{f}</div>
                        ))}
                      </div>
                      {p.id === plan
                        ? <span className="i-plan-current-badge">CURRENT PLAN</span>
                        : <a href={BILLING_URL} target="_blank" rel="noreferrer" className="i-plan-cta">
                            {plan === "free" || PLAN_DATA.findIndex((x) => x.id === p.id) > PLAN_DATA.findIndex((x) => x.id === plan) ? "Upgrade →" : "Downgrade"}
                          </a>
                      }
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Workspace ── */}
            {nav === "workspace" && (
              <div className="i-modal-pane">
                {!workspace ? (
                  <>
                    <p className="i-msect-title">Create a workspace</p>
                    {plan === "team" ? (
                      <div className="i-ws-create">
                        <p style={{ fontSize: 13, color: "var(--i-graphite)", margin: 0 }}>
                          Invite teammates to share transcripts and presets.
                        </p>
                        <input
                          className="i-field"
                          value={wsName}
                          onChange={(e) => setWsName(e.target.value)}
                          placeholder="Workspace name"
                          onKeyDown={(e) => { if (e.key === "Enter") void handleCreateWs(); }}
                        />
                        {wsError && <p className="i-error">{wsError}</p>}
                        <button
                          type="button"
                          className="i-ws-invite-btn"
                          disabled={wsCreating || !wsName.trim()}
                          onClick={() => void handleCreateWs()}
                        >
                          {wsCreating ? "Creating…" : "Create workspace"}
                        </button>
                      </div>
                    ) : (
                      <div className="i-upsell" style={{ marginTop: 0 }}>
                        <div className="i-upsell-text">
                          <div className="i-upsell-title">Team plan required</div>
                          <div className="i-upsell-body">Workspace collaboration is available on the Team plan.</div>
                        </div>
                        <a href={BILLING_URL} target="_blank" rel="noreferrer" className="i-upsell-cta">View plans →</a>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <p className="i-msect-title">Workspace</p>
                    <div className="i-msect-card">
                      <div className="i-mrow">
                        <div>
                          <div className="i-account-email">{workspace.name}</div>
                          <div className="i-account-plan">{workspace.role} · {workspace.plan} plan</div>
                        </div>
                      </div>
                    </div>

                    {workspace.role === "owner" && (
                      <>
                        <p className="i-msect-title" style={{ marginTop: 14 }}>Invite by email</p>
                        <div className="i-ws-invite">
                          <input
                            className="i-field"
                            value={inviteEmail}
                            onChange={(e) => setInviteEmail(e.target.value)}
                            placeholder="teammate@company.com"
                            onKeyDown={(e) => { if (e.key === "Enter") void handleInvite(); }}
                          />
                          <button
                            type="button"
                            className="i-ws-invite-btn"
                            disabled={inviting || !inviteEmail.trim()}
                            onClick={() => void handleInvite()}
                          >
                            {inviting ? "…" : inviteOk ? "Sent ✓" : "Invite"}
                          </button>
                        </div>
                        {inviteError && <p className="i-error">{inviteError}</p>}
                      </>
                    )}

                    <p className="i-msect-title" style={{ marginTop: 14 }}>Members</p>
                    <div className="i-ws-members">
                      {workspace.members.map((m) => (
                        <div key={m.id} className="i-ws-member">
                          <div className="i-ws-member-email">{m.email}</div>
                          {m.status === "invited" && <span className="i-ws-member-status">invited</span>}
                          <span className={`i-ws-member-role${m.role === "owner" ? " owner" : ""}`}>{m.role}</span>
                          {workspace.role === "owner" && m.role !== "owner" && (
                            <button
                              type="button"
                              className="i-ws-remove"
                              disabled={removing === m.id}
                              onClick={() => void handleRemoveMember(m.id)}
                              aria-label={`Remove ${m.email}`}
                            >
                              {removing === m.id ? "…" : "Remove"}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>

                    {workspace.role === "member" && (
                      <button
                        type="button"
                        className="i-signout"
                        style={{ marginTop: 16, color: "var(--i-danger)", borderColor: "color-mix(in srgb, var(--i-danger) 35%, var(--i-hairline))" }}
                        disabled={leaving}
                        onClick={() => void handleLeave()}
                      >
                        {leaving ? "Leaving…" : "Leave workspace"}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── Settings (recording + appearance) ── */}
            {nav === "settings" && (
              <div className="i-modal-pane">
                <p className="i-msect-title">Recording defaults</p>
                <div className="i-msect-card">
                  <div className="i-mrow">
                    <label className="i-mrow-label" htmlFor="s-lang">Language</label>
                    <select
                      id="s-lang" className="i-mini" value={settings.language}
                      onChange={(e) => { const next = saveSettings({ language: e.target.value }); onSettingsChange(next); }}
                    >
                      {SUPPORTED_LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                    </select>
                  </div>
                  <div className="i-mrow">
                    <label className="i-mrow-label" htmlFor="s-spk">Speakers</label>
                    <select
                      id="s-spk" className="i-mini" value={settings.speakers}
                      onChange={(e) => { const next = saveSettings({ speakers: e.target.value }); onSettingsChange(next); }}
                    >
                      <option value="">Auto</option>
                      {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={String(n)}>{n}</option>)}
                    </select>
                  </div>
                  <div className="i-mrow">
                    <div>
                      <div className="i-toggle-wrap">
                        <span className="i-mrow-label">Best Quality</span>
                        <MaxBadge />
                      </div>
                      <div className="i-mrow-sub">large-v3 — slower but more accurate</div>
                      {qualityError && (
                        <div className="i-toggle-nudge">
                          {qualityError} <a href={BILLING_URL} target="_blank" rel="noreferrer">Upgrade →</a>
                        </div>
                      )}
                    </div>
                    <Toggle id="s-quality" checked={settings.quality === "best"} onChange={handleQuality} />
                  </div>
                </div>

                <p className="i-msect-title" style={{ marginTop: 14 }}>Privacy</p>
                <div className="i-msect-card">
                  <div className="i-mrow">
                    <div>
                      <div className="i-toggle-wrap">
                        <span className="i-mrow-label">Privacy Mode</span>
                        <MaxBadge />
                      </div>
                      <div className="i-mrow-sub">No Gemini — self-hosted models only</div>
                      {privError && (
                        <div className="i-toggle-nudge">
                          {privError} <a href={BILLING_URL} target="_blank" rel="noreferrer">Upgrade →</a>
                        </div>
                      )}
                    </div>
                    <Toggle id="s-privacy" checked={privMode} onChange={(v) => void handlePrivMode(v)} disabled={privSaving} />
                  </div>
                </div>

                <p className="i-msect-title" style={{ marginTop: 14 }}>Appearance</p>
                <div className="i-msect-card">
                  <div className="i-mrow" style={{ gap: 6 }}>
                    <span className="i-mrow-label">Theme</span>
                    <div className="i-theme-seg">
                      <button type="button" className={`i-theme-btn${theme === "light" ? " on" : ""}`} onClick={() => toggleTheme("light")}>Light</button>
                      <button type="button" className={`i-theme-btn${theme === "dark" ? " on" : ""}`} onClick={() => toggleTheme("dark")}>Dark</button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Invite friends ── */}
            {nav === "invite" && (
              <div className="i-modal-pane">
                <p className="i-msect-title">Refer a friend</p>
                <p style={{ fontSize: 13, color: "var(--i-graphite)", margin: "0 0 12px" }}>
                  Share your referral link — you both get +60 min when they subscribe.
                </p>
                {refUrl ? (
                  <div className="i-ref-box">
                    <span className="i-ref-url">{refUrl}</span>
                    <button type="button" className="i-ref-copy" onClick={copyRef}>
                      {refCopied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                ) : (
                  <p style={{ fontSize: 12.5, color: "var(--i-graphite)" }}>Loading referral link…</p>
                )}
              </div>
            )}

            {/* ── Danger zone ── */}
            {nav === "danger" && (
              <div className="i-modal-pane">
                <p className="i-msect-title">Danger zone</p>
                <div className="i-msect-card">
                  <div className="i-mrow">
                    <div>
                      <div className="i-mrow-label">Sign out</div>
                      <div className="i-mrow-sub">You will need to sign in again to access your recordings.</div>
                    </div>
                    <button
                      type="button"
                      className="i-pill"
                      style={{ color: "var(--i-danger)", borderColor: "color-mix(in srgb, var(--i-danger) 35%, var(--i-hairline))" }}
                      onClick={() => { onSignOut(); onClose(); }}
                    >
                      Sign out
                    </button>
                  </div>
                </div>
                <p style={{ fontSize: 12, color: "var(--i-graphite)", marginTop: 16 }}>
                  To delete your account and all data, contact{" "}
                  <a href="mailto:support@skriptly.io" style={{ color: "var(--i-accent)" }}>support@skriptly.io</a>.
                </p>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
