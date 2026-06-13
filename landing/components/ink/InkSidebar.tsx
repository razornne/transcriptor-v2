"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryEntry } from "@/lib/ink/db";
import type { Profile } from "@/lib/ink/api";

// Сайдбар: реальна історія з Supabase. Personal = свої записи,
// Team = visibility==='workspace'. Пошук по title/тексту.
// Видалення — двокліковий паттерн: перший клік → "Delete?" (3с), другий → onDelete.
// Settings шестерёнка → onSettings().

function fmtDur(e: HistoryEntry): string {
  if (!e.segments.length) return "—";
  const s = Math.max(...e.segments.map((x) => x.end));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}` : `${Math.max(1, Math.round(s / 60))}m`;
}

function groupOf(iso: string): string {
  const d = new Date(iso), now = new Date();
  const day = 86400000;
  const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const nn = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = Math.round((nn - dd) / day);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "This week";
  return "Earlier";
}

export function InkSidebar({
  open, team, entries, activeId, profile, onClose, onTeamChange, onSelect, onDelete, onSignOut, onSettings,
}: {
  open: boolean;
  team: boolean;
  entries: HistoryEntry[];
  activeId: string | null;
  profile: Profile | null;
  onClose: () => void;
  onTeamChange: (team: boolean) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onSignOut: () => void;
  onSettings?: () => void;
}) {
  const [q, setQ] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmTimerRef = useRef<number>(0);

  // Сбрасываем confirm при закрытии сайдбара
  useEffect(() => {
    if (!open) {
      window.clearTimeout(confirmTimerRef.current);
      setConfirmingId(null);
    }
  }, [open]);

  useEffect(() => () => window.clearTimeout(confirmTimerRef.current), []);

  const handleDeleteClick = (id: string) => {
    if (confirmingId === id) {
      window.clearTimeout(confirmTimerRef.current);
      setConfirmingId(null);
      onDelete(id);
    } else {
      window.clearTimeout(confirmTimerRef.current);
      setConfirmingId(id);
      confirmTimerRef.current = window.setTimeout(() => setConfirmingId(null), 3000);
    }
  };

  const filtered = useMemo(() => {
    let list = entries.filter((e) => (team ? e.visibility === "workspace" : true));
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter((e) =>
        (e.title || "").toLowerCase().includes(needle) ||
        e.segments.some((s) => s.text.toLowerCase().includes(needle)),
      );
    }
    return list;
  }, [entries, team, q]);

  const groups = useMemo(() => {
    const m = new Map<string, HistoryEntry[]>();
    for (const e of filtered) {
      const g = groupOf(e.date);
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(e);
    }
    return ["Today", "Yesterday", "This week", "Earlier"].filter((g) => m.has(g)).map((g) => [g, m.get(g)!] as const);
  }, [filtered]);

  const usedRatio = profile && profile.minutes_limit > 0 ? profile.minutes_used / profile.minutes_limit : 0;

  return (
    <>
      <div className="i-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="i-sb" aria-hidden={!open} aria-label="Workspace and history">
        <div className="i-seg-toggle" role="tablist">
          <button type="button" className={team ? "" : "on"} onClick={() => onTeamChange(false)}>Personal</button>
          <button type="button" className={team ? "on" : ""} onClick={() => onTeamChange(true)}>Team</button>
        </div>

        <div className="i-search">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search history" />
        </div>

        <div className="i-sb-scroll">
          {groups.length === 0 && (
            <p className="i-sb-empty">
              {team ? "No shared recordings yet — team items appear here." : q ? "Nothing found." : "Your recordings will appear here."}
            </p>
          )}
          {groups.map(([g, items]) => (
            <div key={g}>
              <div className="i-sect">{g}</div>
              {items.map((e) => (
                <div key={e.id} className={`i-item${e.id === activeId ? " active" : ""}`}>
                  <button type="button" className="i-item-main" onClick={() => { onSelect(e.id); onClose(); }}>
                    <span className="i-item-title">{e.title || "Untitled"}</span>
                    <span className="dur">{fmtDur(e)}</span>
                  </button>
                  <button
                    type="button"
                    className={`i-del${confirmingId === e.id ? " confirming" : ""}`}
                    aria-label={confirmingId === e.id ? "Confirm delete" : "Delete recording"}
                    onClick={() => handleDeleteClick(e.id)}
                  >
                    {confirmingId === e.id ? "Delete?" : "✕"}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="i-sb-bottom">
          <div className="i-sb-actions">
            {onSettings && (
              <button type="button" className="i-item i-sb-settings" onClick={() => { onSettings(); onClose(); }} aria-label="Open settings">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
                </svg>
                Settings
              </button>
            )}
            <button type="button" className="i-item" onClick={onSignOut}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
              </svg>
              Sign out
            </button>
          </div>
          <div className="i-usage" title={profile ? `${Math.round(profile.minutes_used)} / ${profile.minutes_limit} min · ${profile.plan}` : ""}>
            {Array.from({ length: 10 }, (_, k) => (
              <span key={k} className={`i-usage-dot${k < Math.round(usedRatio * 10) ? " fill" : ""}`} />
            ))}
            <span className="i-usage-label">
              {profile ? `${(profile.minutes_used / 60).toFixed(1)} / ${Math.round(profile.minutes_limit / 60)}h · ${profile.plan}` : "…"}
            </span>
          </div>
        </div>
      </aside>
    </>
  );
}
