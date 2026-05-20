"use client";
import type { HistoryEntry } from "@/lib/studio/mock-data";

export function Sidebar({
  history,
  activeId,
  user,
  onNew,
  onSelect,
  onUserClick,
}: {
  history: HistoryEntry[];
  activeId?: string;
  user: { email: string; plan: string };
  onNew?: () => void;
  onSelect?: (id: string) => void;
  onUserClick?: () => void;
}) {
  const initials = user.email.charAt(0).toUpperCase();
  const shortName = user.email.split("@")[0];

  return (
    <aside className="s-sidebar">
      {/* Logo */}
      <div className="s-logo">
        <span className="s-logo-mark">S</span>
        <span>Skriptly</span>
      </div>

      {/* New recording */}
      <button type="button" className="s-newrec" onClick={onNew}>
        <span className="dot" />
        New recording
      </button>

      {/* History */}
      <div className="s-section-label">Recent</div>
      <nav className="s-history" aria-label="Recordings">
        {history.map((h, i) => (
          <button
            key={h.id}
            type="button"
            className={"s-history-item" + (h.id === activeId ? " active" : "")}
            onClick={() => onSelect?.(h.id)}
          >
            <span className="s-history-num">#{String(history.length - i).padStart(4, "0")}</span>
            <span className="s-history-title">{h.title}</span>
            <span className="s-history-meta">{h.duration}</span>
          </button>
        ))}
      </nav>

      {/* User pill — клик → Settings (Phase 4+) */}
      <button type="button" className="s-user" onClick={onUserClick}>
        <span className="s-user-avatar">{initials}</span>
        <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <span className="s-user-name">{shortName}</span>
          <span className="s-user-plan">{user.plan} plan</span>
        </span>
        <svg className="s-user-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="7" cy="7" r="1.2" />
          <circle cx="7" cy="2.5" r="1.2" />
          <circle cx="7" cy="11.5" r="1.2" />
        </svg>
      </button>
    </aside>
  );
}
