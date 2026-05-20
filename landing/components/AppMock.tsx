"use client";
import type { Copy } from "@/lib/content";
import { useTypewriter } from "@/lib/hooks";

export function AppMock({
  mock,
  animate = false,
}: {
  mock: Copy["mock"];
  animate?: boolean;
}) {
  const liveText = mock.lines[mock.lines.length - 1].text;
  const typed = useTypewriter(liveText, { speed: 32, loop: false, enabled: animate });

  return (
    <div className="mock">
      <div className="mock-chrome">
        <div className="mock-tabs">
          <div className="mock-tab on">
            <span className="favicon">S</span>
            <span className="title">Skriptly · Live transcript</span>
            <span className="close">×</span>
          </div>
          <div className="mock-tab">
            <span className="favicon" style={{ background: "var(--ground-3)", color: "var(--muted)" }}>G</span>
            <span className="title">Strategy doc</span>
          </div>
          <div className="mock-tab-new">+</div>
        </div>
        <div className="mock-urlbar">
          <span className="navs">
            <span className="live">‹</span>
            <span className="live">›</span>
            <span>↻</span>
          </span>
          <span className="field">
            <span className="lock" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M3 5V3.5a2.5 2.5 0 1 1 5 0V5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                <rect x="2" y="5" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" fill="none" />
              </svg>
            </span>
            <span className="url">{mock.url}</span>
          </span>
          <span className="menu">⋮</span>
        </div>
      </div>
      <div className="mock-body">
        <div className="mock-head">
          <span className="eyebrow">{mock.eyebrow}</span>
          <div className="right">
            <span className="pill"><span className="dot live" />REC · {mock.rec}</span>
            <span className="pill" style={{ background: "rgba(63,101,221,0.10)", color: "var(--cta)" }}>{mock.langPill}</span>
          </div>
        </div>

        <div className="tx">
          {mock.lines.map((l, i) => {
            const isLast = i === mock.lines.length - 1;
            const text = isLast && animate ? typed : l.text;
            const showCursor = isLast && (animate || l.live);
            return (
              <div className="tx-line" key={i}>
                <span className={"spk-dot spk-" + l.spk}>S{l.spk}</span>
                <div>
                  <div className="tx-meta"><b>{l.name}</b>{l.time}</div>
                  <div className={"tx-text" + (showCursor ? " tx-cursor" : "")}>{text}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mock-summary">
          <span className="eyebrow">{mock.summaryLabel}</span>
          <ul>
            {mock.summary.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      </div>
    </div>
  );
}
