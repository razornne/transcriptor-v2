"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HistoryEntry } from "@/lib/studio/mock-data";

// Command palette — ⌘K overlay. Phase 1: визуал + клавиатурная навигация,
// action'ы пока stub. Реальные подключим когда recording flow появится.

type Item = {
  id: string;
  group: "Actions" | "Recent" | "Settings";
  label: string;
  meta?: string;           // справа от label (shortcut или duration · date)
  icon: ReactNode;
  onSelect: () => void;
};

export function CommandPalette({
  open,
  onClose,
  history,
  isRecording,
  onToggleRecord,
  onOpenSettings,
  onSelectRecording,
}: {
  open: boolean;
  onClose: () => void;
  history: HistoryEntry[];
  isRecording: boolean;
  onToggleRecord?: () => void;
  onOpenSettings?: () => void;
  onSelectRecording?: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state когда открывается
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
      // Focus input через rAF чтобы overlay уже отрендерился
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Все item'ы palette
  const allItems: Item[] = useMemo(() => {
    const actions: Item[] = [
      {
        id: "rec",
        group: "Actions",
        label: isRecording ? "Stop recording" : "Start recording",
        meta: "⌘R",
        icon: (
          <span
            style={{
              width: 22, height: 22, borderRadius: 6,
              background: "linear-gradient(135deg, var(--s-accent), var(--s-accent-hi))",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <span
              style={{
                width: isRecording ? 8 : 10,
                height: isRecording ? 8 : 10,
                background: "var(--s-on-accent)",
                borderRadius: isRecording ? 2 : "50%",
              }}
            />
          </span>
        ),
        onSelect: () => { onToggleRecord?.(); onClose(); },
      },
      {
        id: "last",
        group: "Actions",
        label: "Open last session",
        meta: "⌘L",
        icon: (
          <SquareIcon>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2.5" y="2.5" width="8" height="8" rx="1.5" />
              <rect x="5" y="5" width="3" height="3" />
            </svg>
          </SquareIcon>
        ),
        onSelect: () => {
          const first = history[0];
          if (first) onSelectRecording?.(first.id);
          onClose();
        },
      },
      {
        id: "upload",
        group: "Actions",
        label: "Upload audio file",
        meta: "⌘U",
        icon: (
          <SquareIcon>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l3.5-3.5L10 9" />
              <path d="M6.5 5.5v6" />
              <path d="M2.5 12h8" />
            </svg>
          </SquareIcon>
        ),
        onSelect: () => { onClose(); },
      },
      {
        id: "blank",
        group: "Actions",
        label: "New blank session",
        meta: "⌘N",
        icon: (
          <SquareIcon>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 10l6.5-6.5 1.5 1.5L4.5 11.5z" />
              <path d="M8.5 4.5l1.5 1.5" />
            </svg>
          </SquareIcon>
        ),
        onSelect: () => { onClose(); },
      },
    ];

    const recent: Item[] = history.slice(0, 5).map((h) => ({
      id: `h-${h.id}`,
      group: "Recent",
      label: h.title,
      meta: `${h.duration} · ${h.group.toLowerCase()}`,
      icon: (
        <SquareIcon variant="ghost">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor">
            <path d="M3 2v7l6-3.5z" />
          </svg>
        </SquareIcon>
      ),
      onSelect: () => { onSelectRecording?.(h.id); onClose(); },
    }));

    const settings: Item[] = [
      {
        id: "settings",
        group: "Settings",
        label: "Open settings",
        meta: "⌘,",
        icon: (
          <SquareIcon>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="6.5" cy="6.5" r="2" />
              <path d="M6.5 1.5v1.5M6.5 10v1.5M1.5 6.5h1.5M10 6.5h1.5M3 3l1 1M9 9l1 1M3 10l1-1M9 4l1-1" strokeLinecap="round" />
            </svg>
          </SquareIcon>
        ),
        onSelect: () => { onOpenSettings?.(); onClose(); },
      },
    ];

    return [...actions, ...recent, ...settings];
  }, [history, isRecording, onClose, onSelectRecording, onToggleRecord, onOpenSettings]);

  // Фильтр по query
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allItems;
    return allItems.filter((it) => it.label.toLowerCase().includes(q));
  }, [allItems, query]);

  // Сброс selectedIdx когда query меняется
  useEffect(() => { setSelectedIdx(0); }, [query]);

  // Группировка для отображения секций
  const groups = useMemo(() => {
    const order: Item["group"][] = ["Actions", "Recent", "Settings"];
    return order
      .map((g) => ({ label: g, items: filtered.filter((it) => it.group === g) }))
      .filter((g) => g.items.length > 0);
  }, [filtered]);

  // Keyboard handling
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(filtered.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const it = filtered[selectedIdx];
        if (it) it.onSelect();
        return;
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, filtered, selectedIdx, onClose]);

  if (!open) return null;

  // Считаем "глобальный" индекс для каждого item чтобы подсветить активный
  let runningIdx = -1;

  return (
    <div className="s-palette-overlay" onClick={onClose}>
      <div className="s-palette" onClick={(e) => e.stopPropagation()}>
        <div className="s-palette-input">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: "var(--s-accent)" }}>
            <path d="M4.5 3.5L8 7l-3.5 3.5" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search…"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="s-palette-kbd">⌘K</kbd>
        </div>

        <div className="s-palette-list">
          {groups.length === 0 && (
            <div className="s-palette-empty">No matches for "{query}"</div>
          )}
          {groups.map((g) => (
            <div className="s-palette-group" key={g.label}>
              <div className="s-palette-section-label">{g.label}</div>
              {g.items.map((it) => {
                runningIdx++;
                const active = runningIdx === selectedIdx;
                return (
                  <button
                    key={it.id}
                    type="button"
                    className={"s-palette-item" + (active ? " active" : "")}
                    onMouseEnter={() => setSelectedIdx(runningIdx)}
                    onClick={() => it.onSelect()}
                  >
                    {active && <span className="s-palette-bar" />}
                    <span className="s-palette-icon">{it.icon}</span>
                    <span className="s-palette-label">{it.label}</span>
                    {it.meta && <span className="s-palette-meta">{it.meta}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="s-palette-footer">
          <div className="s-palette-hints">
            <span><kbd>↑↓</kbd> navigate</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>esc</kbd> close</span>
          </div>
          <div className="s-palette-footer-right">
            Studio · <kbd>⌘K</kbd>
          </div>
        </div>
      </div>
    </div>
  );
}

function SquareIcon({ children, variant = "default" }: { children: ReactNode; variant?: "default" | "ghost" }) {
  return (
    <span
      style={{
        width: 22, height: 22, borderRadius: 6,
        background: variant === "ghost" ? "transparent" : "var(--s-surface-2)",
        border: variant === "ghost" ? "none" : "1px solid var(--s-border)",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "var(--s-ink-soft)",
      }}
    >
      {children}
    </span>
  );
}
