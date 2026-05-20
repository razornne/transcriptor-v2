"use client";
import { useMemo } from "react";
import type { HistoryEntry } from "@/lib/studio/mock-data";
import { waveBars } from "@/lib/studio/mock-data";

export function Sidebar({
  history,
  activeId,
  user,
  onSelect,
  onUserClick,
}: {
  history: HistoryEntry[];
  activeId?: string;
  user: {
    displayName: string;
    initials: string;
    plan: string;
    hoursUsed: number;
    hoursLimit: number;
  };
  onSelect?: (id: string) => void;
  onUserClick?: () => void;
}) {
  // Группируем history по полю group (Today / Yesterday / This week)
  const groups = useMemo(() => {
    const order = ["Today", "Yesterday", "This week", "Earlier"];
    const byGroup: Record<string, HistoryEntry[]> = {};
    for (const h of history) {
      (byGroup[h.group] ||= []).push(h);
    }
    return order
      .filter((g) => byGroup[g]?.length)
      .map((g) => ({ label: g, items: byGroup[g] }));
  }, [history]);

  return (
    <aside className="s-sidebar">
      {/* Header: mic icon + Studio + SKRIPTLY · LOCAL */}
      <div className="s-side-header">
        <div className="s-side-mic" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        </div>
        <div className="s-side-label">
          <div className="title">Studio</div>
          <div className="eyebrow">Skriptly · Cloud</div>
        </div>
      </div>

      {/* Search */}
      <div className="s-search">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="6.2" cy="6.2" r="4.2" />
          <path d="M9.5 9.5l3 3" />
        </svg>
        <input type="text" placeholder="Search transcripts…" />
        <span className="s-search-kbd">⌘K</span>
      </div>

      {/* Date-grouped history */}
      <nav className="s-history" aria-label="Recordings">
        {groups.map((g) => (
          <div className="s-history-group" key={g.label}>
            <div className="s-history-group-label">{g.label}</div>
            {g.items.map((h) => {
              const active = h.id === activeId;
              return (
                <button
                  key={h.id}
                  type="button"
                  className={"s-history-item" + (active ? " active" : "")}
                  onClick={() => onSelect?.(h.id)}
                >
                  <MiniWave seed={h.waveSeed} active={active} />
                  <div className="s-history-content">
                    <span className="s-history-title">{h.title}</span>
                    <span className="s-history-meta">
                      {h.duration} · {h.speakers} spk
                    </span>
                  </div>
                  {active && <span className="s-history-active-dot" />}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* User pill — initials + name + FREE · usage */}
      <button type="button" className="s-user" onClick={onUserClick}>
        <span className="s-user-avatar">{user.initials}</span>
        <span className="s-user-text">
          <div className="s-user-name">{user.displayName}</div>
          <div className="s-user-meta">
            <span className="plan">{user.plan.toUpperCase()}</span>
            <span className="usage">
              {" · "}
              {user.hoursUsed.toFixed(1)} / {user.hoursLimit}h
            </span>
          </div>
        </span>
      </button>
    </aside>
  );
}

// Маленький waveform-thumbnail для history item. Static SVG.
function MiniWave({ seed, active }: { seed: number; active: boolean }) {
  const bars = waveBars(11, seed);
  return (
    <div className="s-history-wave" aria-hidden="true">
      {bars.map((v, i) => (
        <span
          key={i}
          style={{ height: `${Math.max(15, v * 100).toFixed(2)}%` }}
        />
      ))}
    </div>
  );
}
