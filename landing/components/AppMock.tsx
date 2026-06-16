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
  const typed = useTypewriter(liveText, { speed: 38, loop: true, holdMs: 4000, enabled: animate });

  return (
    <div className="m-card">
      {/* Session header */}
      <div className="m-header">
        <span className="eyebrow">{mock.eyebrow}</span>
        <div className="m-header-pills">
          <span className="pill"><span className="dot live" />REC · {mock.rec}</span>
          <span className="pill m-lang">{mock.langPill}</span>
        </div>
      </div>

      {/* Tab bar */}
      <div className="m-tabbar">
        <div className="m-segctl">
          <button className="m-tab on">Transcript</button>
          <button className="m-tab">Summary</button>
          <button className="m-tab">Actions</button>
        </div>
      </div>

      {/* Transcript segments */}
      <div className="m-segments">
        {mock.lines.map((l, i) => {
          const isLast = i === mock.lines.length - 1;
          const text = isLast && animate ? typed : l.text;
          const showCursor = isLast && animate;
          return (
            <div className="m-seg" key={i}>
              <div className={"m-seg-avatar spk-" + l.spk} aria-hidden="true">
                {l.name[0]}
              </div>
              <div className="m-seg-body">
                <div className="m-seg-head">
                  <span className={"m-seg-name spk-c-" + l.spk}>{l.name}</span>
                  <span className="m-seg-time">{l.time}</span>
                </div>
                <div className={"m-seg-text" + (showCursor ? " m-cursor" : "")}>
                  {text}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Auto-summary */}
      <div className="m-summary">
        <span className="m-summary-label">{mock.summaryLabel}</span>
        <ul className="m-summary-list">
          {mock.summary.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      </div>
    </div>
  );
}
