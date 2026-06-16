import type { Copy } from "@/lib/content";

type FolderItem = { name: string; when: string; active?: boolean };
type Folder = { label: string; open: boolean; items: FolderItem[] };

const SIDEBAR: Folder[] = [
  {
    label: "User Research",
    open: true,
    items: [
      { name: "Interview · Sara T.",   when: "11:08" },
      { name: "Interview · Marcos A.", when: "Mon" },
    ],
  },
  {
    label: "Client Calls",
    open: true,
    items: [
      { name: "Strategy sync · Maya", when: "14:32", active: true },
      { name: "Sales call · Innova",  when: "Wed" },
    ],
  },
];

const RECENT: FolderItem[] = [
  { name: "Q4 planning",       when: "Wed" },
  { name: "Brand workshop",    when: "May 12" },
  { name: "Investor update",   when: "May 10" },
];

export function Breakout({ t }: { t: Copy }) {
  return (
    <section className="inapp" id="app">
      <div className="wrap">
        <div className="s-head reveal" style={{ marginBottom: 28 }}>
          <span className="eyebrow">{t.breakout.eyebrow}</span>
          <h2 className="display xl">{t.breakout.title}</h2>
          <p className="lede">{t.breakout.sub}</p>
        </div>

        <div className="inapp-mock reveal">
          {/* Sidebar: Projects / Folders tree */}
          <aside className="inapp-sidebar">
            <div className="inapp-sidebar-hd">
              <span className="inapp-sidebar-title">Recordings</span>
              <span className="inapp-new" aria-hidden="true">+</span>
            </div>
            <div className="inapp-tree">
              <span className="inapp-grp-lbl">Projects</span>
              {SIDEBAR.map((folder) => (
                <div key={folder.label}>
                  <div className={"inapp-folder" + (folder.open ? " open" : "")}>
                    <span className="inapp-folder-arr">▶</span>
                    <span className="inapp-folder-ico">📁</span>
                    <span>{folder.label}</span>
                  </div>
                  {folder.open && folder.items.map((item) => (
                    <div key={item.name} className={"inapp-row" + (item.active ? " on" : "")}>
                      <span className={"inapp-row-dot" + (item.active ? " live" : " idle")} aria-hidden="true" />
                      <span className="inapp-row-name">{item.name}</span>
                      <span className="inapp-row-when">{item.when}</span>
                    </div>
                  ))}
                </div>
              ))}

              <span className="inapp-grp-lbl" style={{ marginTop: 4 }}>Recently</span>
              {RECENT.map((item) => (
                <div key={item.name} className="inapp-row">
                  <span className="inapp-row-dot idle" aria-hidden="true" />
                  <span className="inapp-row-name">{item.name}</span>
                  <span className="inapp-row-when">{item.when}</span>
                </div>
              ))}
            </div>
          </aside>

          {/* Main panel: active transcript */}
          <div className="inapp-main">
            <div className="mock-head">
              <span className="eyebrow">{t.mock.eyebrow}</span>
              <div className="right">
                <span className="pill"><span className="dot live" />REC · {t.mock.rec}</span>
                <span className="pill m-lang">{t.mock.langPill}</span>
              </div>
            </div>
            <div className="tx" style={{ gap: 18, marginTop: 18 }}>
              {t.mock.lines.map((l, i) => (
                <div className="tx-line" key={i}>
                  <span className={"spk-dot spk-" + l.spk}>{l.name[0]}</span>
                  <div>
                    <div className="tx-meta"><b>{l.name}</b>{l.time}</div>
                    <div className={"tx-text" + (l.live ? " tx-cursor" : "")}>{l.text}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mock-summary" style={{ marginTop: 22 }}>
              <span className="eyebrow" style={{ color: "var(--accent)", fontSize: "10.5px", display: "block", marginBottom: 8 }}>
                {t.mock.summaryLabel}
              </span>
              <ul>
                {t.mock.summary.map((s, i) => <li key={i} style={{ fontSize: "13.5px", color: "var(--graphite)", margin: "4px 0" }}>{s}</li>)}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
