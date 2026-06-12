"use client";

// Collapsible-сайдбар: ЕДИНСТВЕННОЕ место командного функционала.
// Personal и Team — один компонент, два состояния данных: в Team
// появляются аватары авторов, pin и Team presets; в Personal это просто
// личный архив без командного шума. Открытие: ≡ или ⌘\ (page.tsx).

type HistItem = { title: string; dur: string; author: string; pinned?: boolean };

const TODAY: HistItem[] = [
  { title: "Sprint stand-up", dur: "12m", author: "KS" },
  { title: "Client call — billing", dur: "47m", author: "NB", pinned: true },
];
const YESTERDAY: HistItem[] = [
  { title: "Lecture: biochem", dur: "1h 04", author: "NB" },
  { title: "Voice note → blog draft", dur: "6m", author: "MR" },
];

export function InkSidebar({
  open,
  team,
  onClose,
  onTeamChange,
}: {
  open: boolean;
  team: boolean;
  onClose: () => void;
  onTeamChange: (team: boolean) => void;
}) {
  return (
    <>
      <div className="i-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="i-sb" aria-hidden={!open} aria-label="Workspace and history">
        <div className="i-seg" role="tablist">
          <button type="button" className={team ? "" : "on"} onClick={() => onTeamChange(false)}>
            Personal
          </button>
          <button type="button" className={team ? "on" : ""} onClick={() => onTeamChange(true)}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
              <circle cx="9" cy="7" r="4" />
            </svg>
            Acme team
          </button>
        </div>

        <div className="i-search">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          Search…
          <span className="i-kbd">⌘K</span>
        </div>

        <div className="i-sect">Today</div>
        {TODAY.map((h) => <Row key={h.title} item={h} />)}
        <div className="i-sect">Yesterday</div>
        {YESTERDAY.map((h) => <Row key={h.title} item={h} />)}

        <button type="button" className="i-item i-teamonly" style={{ marginTop: 10 }}>
          <span aria-hidden="true">✦</span> Team presets <span className="dur">4</span>
        </button>

        <div className="i-sb-bottom">
          <button type="button" className="i-item i-teamonly">＋ Invite teammate</button>
          <button type="button" className="i-item">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Settings
          </button>
          <div className="i-usage">
            {Array.from({ length: 10 }, (_, k) => (
              <span key={k} className={`i-usage-dot${k < 3 ? " fill" : ""}`} />
            ))}
            <span className="i-usage-label">6.2 / 20h</span>
          </div>
        </div>
      </aside>
    </>
  );
}

function Row({ item }: { item: HistItem }) {
  return (
    <button type="button" className="i-item">
      <span className="i-av">{item.author}</span>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {item.title}
      </span>
      {item.pinned && (
        <svg className="i-teamonly" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ color: "var(--i-graphite)", flex: "none" }}>
          <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 1 0 0-4H8a2 2 0 1 0 0 4h1z" />
        </svg>
      )}
      <span className="dur">{item.dur}</span>
    </button>
  );
}
