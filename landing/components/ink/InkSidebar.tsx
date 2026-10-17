"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryEntry } from "@/lib/ink/db";
import type { Profile, Project } from "@/lib/ink/api";

const DICT = {
  en: {
    personal: "Personal", team: "Team", search: "Search…",
    noShared: "No shared recordings yet — team items appear here.",
    noFound: "Nothing found.", noRecs: "Your recordings will appear here.",
    settings: "Settings", signOut: "Sign out", newRec: "New recording", collapse: "Collapse sidebar",
    today: "Today", yesterday: "Yesterday", thisWeek: "This week", earlier: "Earlier",
    untitled: "Untitled",
    newProject: "+ New project",
    unsorted: "Unsorted",
    removeFromProject: "Remove from project",
  },
  ua: {
    personal: "Особисте", team: "Команда", search: "Пошук…",
    noShared: "Немає спільних записів — командні матеріали тут.",
    noFound: "Нічого не знайдено.", noRecs: "Тут з'являться ваші записи.",
    settings: "Налаштування", signOut: "Вийти", newRec: "Новий запис", collapse: "Згорнути панель",
    today: "Сьогодні", yesterday: "Вчора", thisWeek: "Цього тижня", earlier: "Раніше",
    untitled: "Без назви",
    newProject: "+ Новий проект",
    unsorted: "Без проекту",
    removeFromProject: "Видалити з проекту",
  },
} as const;
type Lang = keyof typeof DICT;

function fmtDur(e: HistoryEntry): string {
  if (!e.segments.length && e.durationSec == null) return "—";
  const s = e.durationSec ?? Math.max(...e.segments.map((x) => x.end));
  return s >= 3600
    ? `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`
    : `${Math.max(1, Math.round(s / 60))}m`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
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
  open, team, entries, activeId, profile, hasWorkspace,
  projects, onCreateProject, onDeleteProject, onMoveEntry,
  onClose, onToggle, onNew, onTeamChange, onSelect, onDelete, onSettings,
  email, loading = false, profileLoading = false, uiLang = "en",
}: {
  open: boolean;
  team: boolean;
  entries: HistoryEntry[];
  activeId: string | null;
  profile: Profile | null;
  hasWorkspace: boolean;
  projects: Project[];
  onCreateProject: (name: string) => void;
  onDeleteProject: (id: string) => void;
  onMoveEntry: (entryId: string, targetProjectId: string | null) => void;
  /** Закрыть выезжающую панель (только мобильный) */
  onClose: () => void;
  /** Свернуть/развернуть колонку (десктоп) */
  onToggle: () => void;
  /** Перейти на пустой экран «новая запись» */
  onNew: () => void;
  onTeamChange: (team: boolean) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onSettings?: () => void;
  email: string;
  /** История ещё грузится: вместо «пусто» — скелетоны, счётчики проектов скрыты. */
  loading?: boolean;
  /** Профиль (план, минуты) ещё грузится. */
  profileLoading?: boolean;
  uiLang?: Lang;
}) {
  const [q, setQ] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [openedProjects, setOpenedProjects] = useState<Set<string>>(new Set());
  const [moveDropEntry, setMoveDropEntry] = useState<string | null>(null);
  const [newProjOpen, setNewProjOpen] = useState(false);
  const [newProjName, setNewProjName] = useState("");
  const confirmTimerRef = useRef<number>(0);
  const newProjRef = useRef<HTMLInputElement>(null);

  const s = DICT[uiLang] ?? DICT.en;

  const groupLabelOf = (key: string): string => {
    switch (key) {
      case "Today": return s.today;
      case "Yesterday": return s.yesterday;
      case "This week": return s.thisWeek;
      case "Earlier": return s.earlier;
      default: return key;
    }
  };

  useEffect(() => {
    if (!open) {
      window.clearTimeout(confirmTimerRef.current);
      setConfirmingId(null);
      setMoveDropEntry(null);
    }
  }, [open]);

  useEffect(() => () => window.clearTimeout(confirmTimerRef.current), []);

  useEffect(() => { if (newProjOpen) newProjRef.current?.focus(); }, [newProjOpen]);

  // Close move dropdown when clicking outside
  useEffect(() => {
    if (!moveDropEntry) return;
    const h = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".i-move-drop, .i-move-btn")) {
        setMoveDropEntry(null);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [moveDropEntry]);

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
        e.segments.some((seg) => seg.text.toLowerCase().includes(needle)),
      );
    }
    return list;
  }, [entries, team, q]);

  const entryById = useMemo(() => {
    const m = new Map<string, HistoryEntry>();
    for (const e of filtered) m.set(e.id, e);
    return m;
  }, [filtered]);

  // When searching, show everything flat (no project grouping)
  const searching = q.trim().length > 0;

  const projectedIds = useMemo(
    () => searching ? new Set<string>() : new Set(projects.flatMap((p) => p.entryIds)),
    [projects, searching],
  );

  const unsorted = useMemo(
    () => filtered.filter((e) => !projectedIds.has(e.id)),
    [filtered, projectedIds],
  );

  const unsortedGroups = useMemo(() => {
    const m = new Map<string, HistoryEntry[]>();
    for (const e of unsorted) {
      const g = groupOf(e.date);
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(e);
    }
    return ["Today", "Yesterday", "This week", "Earlier"]
      .filter((g) => m.has(g))
      .map((g) => [g, m.get(g)!] as const);
  }, [unsorted]);

  const usedRatio = profile && profile.minutes_limit > 0
    ? profile.minutes_used / profile.minutes_limit
    : 0;

  const handleNewProject = () => {
    const name = newProjName.trim();
    if (!name) return;
    onCreateProject(name);
    setNewProjName("");
    setNewProjOpen(false);
  };

  const toggleProject = (id: string) => {
    setOpenedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const renderEntry = (e: HistoryEntry, inProjectId?: string) => (
    <div key={e.id} className={`i-item${e.id === activeId ? " active" : ""}`}>
      <button
        type="button"
        className="i-item-main"
        onClick={() => { onSelect(e.id); onClose(); }}
        title={e.title || s.untitled}
      >
        <span className="i-item-title">{e.title || s.untitled}</span>
        <span className="dur">{fmtDur(e)} · {fmtDate(e.date)}</span>
      </button>

      {/* Move-to folder dropdown — only for real entries when projects exist */}
      {e.id !== "demo" && projects.length > 0 && (
        <div className="i-move-wrap">
          <button
            type="button"
            className={`i-move-btn${moveDropEntry === e.id ? " open" : ""}`}
            aria-label="Move to project"
            onClick={(ev) => {
              ev.stopPropagation();
              setMoveDropEntry((v) => (v === e.id ? null : e.id));
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          {moveDropEntry === e.id && (
            <div className="i-move-drop">
              {inProjectId && (
                <button
                  type="button"
                  className="i-move-opt i-move-opt-remove"
                  onClick={() => { onMoveEntry(e.id, null); setMoveDropEntry(null); }}
                >
                  {s.removeFromProject}
                </button>
              )}
              {projects.filter((p) => p.id !== inProjectId).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="i-move-opt"
                  onClick={() => { onMoveEntry(e.id, p.id); setMoveDropEntry(null); }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        className={`i-del${confirmingId === e.id ? " confirming" : ""}`}
        aria-label={confirmingId === e.id ? "Confirm delete" : "Delete recording"}
        onClick={() => handleDeleteClick(e.id)}
      >
        {confirmingId === e.id ? "Delete?" : "✕"}
      </button>
    </div>
  );

  const showProjects = !searching && !team;
  const showUnsortedLabel = showProjects && projects.length > 0 && unsortedGroups.length > 0;

  return (
    <>
      <div className="i-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="i-sb" aria-hidden={!open} aria-label="Workspace and history">

        <div className="i-sb-head">
          <div className="i-brand">
            <span className="i-brand-mark" aria-hidden="true">S</span>
            <span className="i-brand-name">Skriptly</span>
          </div>
          <button type="button" className="i-flatbtn" aria-label={s.collapse} onClick={onToggle}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" />
            </svg>
          </button>
        </div>

        <button type="button" className="i-newrec" onClick={() => { onNew(); onClose(); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {s.newRec}
        </button>

        {/* Personal / Team toggle */}
        {hasWorkspace && (
          <div className="i-seg-toggle" role="tablist">
            <button type="button" className={team ? "" : "on"} onClick={() => onTeamChange(false)}>
              {s.personal}
            </button>
            <button type="button" className={team ? "on" : ""} onClick={() => onTeamChange(true)}>
              {s.team}
            </button>
          </div>
        )}

        {/* Search */}
        <div className={`i-search${hasWorkspace ? "" : " i-search-top"}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={s.search}
            aria-label="Search history"
          />
        </div>

        <div className="i-sb-scroll">

          {/* ── Projects section ── */}
          {showProjects && (
            <div className="i-proj-section">
              {projects.map((proj) => {
                const projEntries = proj.entryIds
                  .map((id) => entryById.get(id))
                  .filter((e): e is HistoryEntry => !!e);
                const isOpen = openedProjects.has(proj.id);
                return (
                  <div key={proj.id} className="i-proj">
                    <div className="i-proj-head">
                      <button
                        type="button"
                        className="i-proj-toggle"
                        onClick={() => toggleProject(proj.id)}
                        aria-expanded={isOpen}
                      >
                        <svg
                          className={`i-proj-chevron${isOpen ? " open" : ""}`}
                          width="9" height="9" viewBox="0 0 24 24"
                          fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                        >
                          <path d="M9 18l6-6-6-6" />
                        </svg>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                        <span className="i-proj-name">{proj.name}</span>
                        <span className="i-proj-count">{loading ? "" : projEntries.length}</span>
                      </button>
                      <button
                        type="button"
                        className="i-proj-del"
                        aria-label={`Delete project ${proj.name}`}
                        onClick={() => onDeleteProject(proj.id)}
                      >✕</button>
                    </div>
                    {isOpen && (
                      <div className="i-proj-entries">
                        {projEntries.length === 0
                          ? <p className="i-proj-empty">No recordings yet</p>
                          : projEntries.map((e) => renderEntry(e, proj.id))}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* New project input / button */}
              {newProjOpen ? (
                <div className="i-proj-new-row">
                  <input
                    ref={newProjRef}
                    className="i-proj-new-input"
                    value={newProjName}
                    onChange={(e) => setNewProjName(e.target.value)}
                    placeholder="Project name"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); handleNewProject(); }
                      if (e.key === "Escape") { setNewProjOpen(false); setNewProjName(""); }
                    }}
                    onBlur={() => {
                      if (!newProjName.trim()) { setNewProjOpen(false); setNewProjName(""); }
                    }}
                  />
                  <button
                    type="button"
                    className="i-proj-new-ok"
                    onClick={handleNewProject}
                    disabled={!newProjName.trim()}
                  >✓</button>
                </div>
              ) : (
                <button
                  type="button"
                  className="i-proj-new-btn"
                  onClick={() => setNewProjOpen(true)}
                >
                  {s.newProject}
                </button>
              )}
            </div>
          )}

          {/* ── Unsorted / flat entries ── */}
          {filtered.length === 0 && loading && (
            <div className="i-skel-list" aria-hidden="true">
              {[0, 1, 2, 3].map((k) => (
                <div key={k} className="i-skel-item">
                  <span className="i-skel" style={{ width: `${78 - k * 9}%`, height: 12 }} />
                  <span className="i-skel" style={{ width: 62, height: 9 }} />
                </div>
              ))}
            </div>
          )}

          {filtered.length === 0 && !loading && (
            <p className="i-sb-empty">
              {team ? s.noShared : q ? s.noFound : s.noRecs}
            </p>
          )}

          {showUnsortedLabel && (
            <div className="i-sect">{s.unsorted}</div>
          )}

          {unsortedGroups.map(([g, items]) => (
            <div key={g}>
              <div className={`i-sect${showUnsortedLabel ? " i-sect-sub" : ""}`}>
                {groupLabelOf(g)}
              </div>
              {items.map((e) => renderEntry(e))}
            </div>
          ))}
        </div>

        <div className="i-sb-bottom">
          <div className="i-acct">
            <div className="i-acct-av" aria-hidden="true">{(email[0] || "?").toUpperCase()}</div>
            <div className="i-acct-text">
              <div className="i-acct-name" title={email}>{email || "…"}</div>
              <div className="i-acct-plan">
                {profile ? `${profile.plan} plan` : profileLoading ? <span className="i-skel" style={{ width: 54, height: 9 }} /> : "…"}
              </div>
            </div>
            {onSettings && (
              <button
                type="button"
                className="i-flatbtn"
                onClick={() => { onSettings(); onClose(); }}
                aria-label={s.settings}
                title={s.settings}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 7h9M16 7h5M3 17h5M12 17h9" /><circle cx="14" cy="7" r="2" /><circle cx="10" cy="17" r="2" />
                </svg>
              </button>
            )}
          </div>
          <div
            className="i-usage"
            title={profile ? `${Math.round(profile.minutes_used)} / ${profile.minutes_limit} min · ${profile.plan}` : ""}
          >
            <div className="i-usage-row">
              <span>Call minutes</span>
              <span>
                {profile
                  ? `${Math.round(profile.minutes_used)} / ${Math.round(profile.minutes_limit)}`
                  : profileLoading ? <span className="i-skel" style={{ width: 52, height: 9 }} /> : "…"}
              </span>
            </div>
            <div className="i-usage-track">
              <div className="i-usage-fill" style={{ width: `${Math.round(Math.min(1, usedRatio) * 100)}%` }} />
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
