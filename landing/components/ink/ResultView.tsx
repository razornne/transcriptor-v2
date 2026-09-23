"use client";
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { HistoryEntry, Segment } from "@/lib/ink/db";
import { generate, sendToNotion, UpgradeRequiredError } from "@/lib/ink/api";
import { UpgradeCard } from "./UpgradeCard";

// ── Markdown renderer ────────────────────────────────────────────
function inlineMd(text: string): ReactNode {
  const re = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  const parts: ReactNode[] = [];
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] !== undefined) parts.push(<strong key={k++}>{m[1]}</strong>);
    else parts.push(<em key={k++}>{m[2]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function renderMd(md: string): ReactNode {
  const lines = md.split("\n");
  const out: ReactNode[] = [];
  let i = 0;

  // Collect consecutive bullet/to-do lines (respects indentation for nesting)
  function collectList(minIndent: number): ReactNode[] {
    const items: ReactNode[] = [];
    while (i < lines.length) {
      const raw = lines[i];
      const t = raw.trim();
      if (!t) { i++; continue; }
      const indent = raw.length - raw.trimStart().length;
      if (indent < minIndent) break;
      if (!/^[-*•]\s/.test(t)) break;
      const content = t.replace(/^[-*•]\s*/, "");
      i++;
      // Peek: nested list?
      let nested: ReactNode = null;
      if (i < lines.length) {
        const ni = lines[i].length - lines[i].trimStart().length;
        if (ni > indent && lines[i].trim() && /^[-*•]\s/.test(lines[i].trim())) {
          nested = <ul key={`n${i}`}>{collectList(ni)}</ul>;
        }
      }
      if (content.startsWith("[ ] ") || content === "[ ]") {
        const task = content.slice(4);
        items.push(<li key={i} className="i-cb-row"><span className="i-cb" aria-hidden="true" /><span>{inlineMd(task)}{nested}</span></li>);
      } else if (/^\[x\] /i.test(content) || /^\[x\]$/i.test(content)) {
        items.push(<li key={i} className="i-cb-row"><span className="i-cb done" aria-hidden="true">✓</span><span>{inlineMd(content.slice(4))}{nested}</span></li>);
      } else {
        items.push(<li key={i}>{inlineMd(content)}{nested}</li>);
      }
    }
    return items;
  }

  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) { i++; continue; }
    if (t === "---" || t === "___" || t === "***") {
      out.push(<hr key={i++} />);
    } else if (raw.startsWith("#### ")) {
      out.push(<h4 key={i++}>{inlineMd(raw.slice(5))}</h4>);
    } else if (raw.startsWith("### ")) {
      out.push(<h3 key={i++}>{inlineMd(raw.slice(4))}</h3>);
    } else if (raw.startsWith("## ")) {
      out.push(<h2 key={i++}>{inlineMd(raw.slice(3))}</h2>);
    } else if (raw.startsWith("# ")) {
      out.push(<h2 key={i++}>{inlineMd(raw.slice(2))}</h2>);
    } else if (/^[-*•]\s/.test(t)) {
      const indent = raw.length - raw.trimStart().length;
      out.push(<ul key={`ul${i}`}>{collectList(indent)}</ul>);
    } else if (/^\d+\.\s/.test(t)) {
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const l = lines[i].trim();
        if (!l || !/^\d+\.\s/.test(l)) break;
        items.push(<li key={i++}>{inlineMd(l.replace(/^\d+\.\s/, ""))}</li>);
      }
      out.push(<ol key={`ol${i}`}>{items}</ol>);
    } else {
      out.push(<p key={i++}>{inlineMd(t)}</p>);
    }
  }
  return <>{out}</>;
}

// Результат (OUTPUT): заголовок + segmented control Transcript/Summary/Actions.
// Спринт 4: Notes (4th tab, дебаунс 600ms), інлайн-редагування тексту сегмента,
//           Notion export, .txt download, tab state lifted (activeTab/onTabChange від page.tsx).

export type Tab = "transcript" | "summary" | "actions";

// Matte "expensive ink" speaker palette — defined as CSS vars in ink.css so the
// whole set is themeable in one place. Klein blue + muted copper/plum/teal.
const SPK_COLORS = ["var(--i-spk-1)", "var(--i-spk-2)", "var(--i-spk-3)", "var(--i-spk-4)"];

function spkColor(label: string): string {
  const m = label.match(/(\d+)/);
  return SPK_COLORS[(m ? parseInt(m[1], 10) : 0) % SPK_COLORS.length];
}

function spkDisplay(label: string, names: Record<string, string>): string {
  if (names[label]) return names[label];
  const m = label.match(/(\d+)/);
  return m ? `Speaker ${parseInt(m[1], 10) + 1}` : label;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, "0")}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  return d.toLocaleDateString("en-GB", {
    day: "numeric", month: "short",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

function stripDash(text: string): string {
  return text.replace(/^—\s*/, "").trim();
}

export function transcriptText(segments: Segment[], names: Record<string, string>): string {
  return segments.map((s) => `[${spkDisplay(s.speaker, names)}]: ${stripDash(s.text)}`).join("\n\n");
}

function txtText(segments: Segment[], names: Record<string, string>): string {
  return segments.map((s) => `${spkDisplay(s.speaker, names)}: ${stripDash(s.text)}`).join("\n\n");
}

function NotionIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.14c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.046 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" />
    </svg>
  );
}

// ── мемоизированная строка сегмента ─────────────────────────────
const SegmentRow = memo(function SegmentRow({
  idx, speaker, name, displayName, color, time, text, edited,
  editingSpk, editingText,
  onStartEdit, onRename, onCancelEdit,
  onStartTextEdit, onSaveText, onCancelTextEdit,
}: {
  idx: number; speaker: string; name: string; displayName: string; color: string;
  time: string; text: string; edited?: boolean;
  editingSpk: boolean; editingText: boolean;
  onStartEdit: (idx: number) => void;
  onRename: (label: string, value: string) => void;
  onCancelEdit: () => void;
  onStartTextEdit: (idx: number) => void;
  onSaveText: (idx: number, val: string) => void;
  onCancelTextEdit: () => void;
}) {
  // Focus the rename input WITHOUT scrolling the page. The browser's default
  // autofocus scroll-into-view is what yanked the transcript around on click.
  const spkInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editingSpk) spkInputRef.current?.focus({ preventScroll: true });
  }, [editingSpk]);

  return (
    <div className="i-seg">
      <div className="i-seg-head">
        {editingSpk ? (
          <input
            ref={spkInputRef}
            className="i-spk-edit"
            style={{ color }}
            defaultValue={name} placeholder={displayName}
            // Keep every interaction inside the input — never let it bubble to
            // the segment row (which could seek/scroll the player).
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onBlur={(e) => onRename(speaker, e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") onCancelEdit();
            }}
          />
        ) : (
          <button
            type="button" className="i-spk" style={{ color }}
            title="Click to rename"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onStartEdit(idx);
            }}
          >
            {displayName}<span className="i-spk-hint"> ✎</span>
          </button>
        )}
        <span className="i-seg-time">{time}</span>
        {edited && <span className="i-seg-edited">edited</span>}
      </div>

      {editingText ? (
        <textarea
          className="i-seg-edit-area"
          autoFocus
          defaultValue={text}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSaveText(idx, (e.target as HTMLTextAreaElement).value);
            }
            if (e.key === "Escape") onCancelTextEdit();
          }}
          onBlur={(e) => onSaveText(idx, e.target.value)}
        />
      ) : (
        <div className="i-seg-text-wrap" onDoubleClick={() => onStartTextEdit(idx)}>
          <p className="i-seg-text">{stripDash(text)}</p>
          <button
            type="button" className="i-seg-pencil"
            aria-label="Edit text" onClick={() => onStartTextEdit(idx)}
          >✎</button>
        </div>
      )}
    </div>
  );
});

// ── ResultView ────────────────────────────────────────────────────
export function ResultView({
  entry, plan, notionConnected,
  activeTab, onTabChange,
  onPatch,
  onUpgrade, autoSummaryPending = false,
}: {
  entry: HistoryEntry;
  plan: string;
  notionConnected?: boolean;
  activeTab: Tab;
  onTabChange: (t: Tab) => void;
  onPatch: (fields: Partial<HistoryEntry>, db: Record<string, unknown>) => void;
  onUpgrade?: () => void;
  /** A summary is being generated automatically after the call. */
  autoSummaryPending?: boolean;
}) {
  const [genBusy, setGenBusy] = useState<Tab | null>(null);
  const [genError, setGenError] = useState("");
  const [gated, setGated] = useState(false);
  const [detail, setDetail] = useState("medium");
  const [focus, setFocus] = useState("");

  // Speaker rename
  const [editingSpk, setEditingSpk] = useState<number | null>(null);

  // Inline segment text editing
  const [editingSegIdx, setEditingSegIdx] = useState<number | null>(null);


  // Notion send state
  const [notionSending, setNotionSending] = useState(false);
  const [notionSent, setNotionSent] = useState(false);
  const [notionError, setNotionError] = useState("");

  const [copied, setCopied] = useState(false);

  const names = entry.speakerNames;
  const isAiGated = plan === "free" || gated;

  const runAI = async (template: "summary" | "actions") => {
    if (genBusy) return;
    setGenBusy(template);
    setGenError("");
    try {
      const text = await generate(
        entry.segments, names, template,
        entry.lang === "auto" ? "" : entry.lang, detail, focus,
      );
      const ai = { ...entry.aiResults, [template]: text };
      onPatch({ aiResults: ai }, { ai_results: ai });
    } catch (e) {
      if (e instanceof UpgradeRequiredError) setGated(true);
      else setGenError(`generation failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setGenBusy(null);
    }
  };

  // Speaker rename handlers
  const onStartEdit = useCallback((segIdx: number) => {
    setEditingSegIdx(null);
    setEditingSpk(segIdx);
  }, []);
  const onCancelEdit = useCallback(() => setEditingSpk(null), []);
  const onRename = useCallback((label: string, value: string) => {
    setEditingSpk(null);
    const trimmed = value.trim();
    const names = { ...entry.speakerNames };
    if (trimmed) names[label] = trimmed; else delete names[label];
    onPatch({ speakerNames: names }, { speaker_names: names });
  }, [entry.speakerNames, onPatch]);

  // Segment text edit handlers
  const onStartTextEdit = useCallback((idx: number) => {
    setEditingSpk(null);
    setEditingSegIdx(idx);
  }, []);
  const onCancelTextEdit = useCallback(() => setEditingSegIdx(null), []);
  const onSaveText = useCallback((idx: number, val: string) => {
    setEditingSegIdx(null);
    const trimmed = val.trim();
    if (!trimmed || trimmed === entry.segments[idx]?.text) return;
    const newSegs = entry.segments.map((s, i) =>
      i === idx ? { ...s, text: trimmed, edited: true } : s,
    );
    onPatch({ segments: newSegs }, { segments: newSegs });
  }, [entry.segments, onPatch]);

  const runBoth = async () => {
    if (genBusy) return;
    setGenBusy("summary"); setGenError("");
    const lang = entry.lang === "auto" ? "" : entry.lang;
    let summaryText = "";
    try {
      summaryText = await generate(entry.segments, names, "summary", lang, detail, focus);
      const ai = { ...entry.aiResults, summary: summaryText };
      onPatch({ aiResults: ai }, { ai_results: ai });
    } catch (e) {
      if (e instanceof UpgradeRequiredError) { setGated(true); setGenBusy(null); return; }
      setGenError(`generation failed: ${e instanceof Error ? e.message : e}`);
      setGenBusy(null); return;
    }
    setGenBusy("actions");
    try {
      const actionsText = await generate(entry.segments, names, "actions", lang, detail, focus);
      const ai = { ...entry.aiResults, summary: summaryText, actions: actionsText };
      onPatch({ aiResults: ai }, { ai_results: ai });
    } catch (e) {
      if (e instanceof UpgradeRequiredError) setGated(true);
      else setGenError(`generation failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setGenBusy(null);
    }
  };

  // Notion send
  const handleSendNotion = async () => {
    if (notionSending) return;
    setNotionSending(true);
    setNotionError("");
    try {
      await sendToNotion(
        entry.title || "Untitled",
        transcriptText(entry.segments, names),
        entry.aiResults.summary,
        entry.aiResults.actions,
      );
      setNotionSent(true);
      setTimeout(() => setNotionSent(false), 3000);
    } catch (e) {
      setNotionError(e instanceof Error ? e.message : "Notion send failed");
    } finally {
      setNotionSending(false);
    }
  };

  // Export helpers
  const exportText = activeTab === "transcript"
    ? transcriptText(entry.segments, names)
    : (entry.aiResults[activeTab] || "");

  const copy = async () => {
    try { await navigator.clipboard.writeText(exportText); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch {}
  };

  const downloadMd = () => {
    const md = `# ${entry.title || "Transcript"}\n\n${transcriptText(entry.segments, names)}\n` +
      (entry.aiResults.summary ? `\n---\n\n## Summary\n\n${entry.aiResults.summary}\n` : "") +
      (entry.aiResults.actions ? `\n---\n\n## Action items\n\n${entry.aiResults.actions}\n` : "");
    const slug = (entry.title || "transcript").replace(/[^\wЀ-ӿ -]+/g, "").slice(0, 60) || "transcript";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    a.download = `${slug}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const downloadTxt = () => {
    const text = txtText(entry.segments, names);
    const slug = (entry.title || "transcript").replace(/[^\wЀ-ӿ -]+/g, "").slice(0, 60) || "transcript";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = `${slug}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="i-resultview">
      <input
        className="i-title-input"
        value={entry.title || ""}
        placeholder="Untitled recording"
        onChange={(e) => onPatch(
          { title: e.target.value, titleIsAuto: false },
          { title: e.target.value, title_is_auto: false },
        )}
        aria-label="Recording title"
      />
      <div className="i-meta-row">
        <span>{new Set(entry.segments.map((s) => s.speaker)).size} speakers</span>
        <span>·</span>
        <span>{entry.segments.length ? fmtTime(Math.max(...entry.segments.map((s) => s.end))) : "0:00"}</span>
        <span>·</span>
        <span>{entry.lang}</span>
        <span>·</span>
        <span>{fmtDate(entry.date)}</span>
      </div>

      <div className="i-tabs">
        <div className="i-segctl" role="tablist">
          {(["transcript", "summary", "actions"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={activeTab === t}
              className={`i-tab${activeTab === t ? " on" : ""}`} onClick={() => onTabChange(t)}>
              {t === "transcript" ? "Transcript" : t === "summary" ? "Summary" : "Action items"}
              {t !== "transcript" && entry.aiResults[t] && <span className="i-tab-dot" />}
            </button>
          ))}

        </div>

        {/* Right utility group — Notion / .txt / .md / Copy on ONE row, 32px each */}
        <div className="i-toolbar-actions">
          {notionConnected && (
            <button
              type="button"
              className={`i-tbtn i-notion-btn${notionSending ? " sending" : ""}${notionSent ? " sent" : ""}`}
              onClick={() => void handleSendNotion()}
              disabled={notionSending}
              title={notionError || undefined}
            >
              <NotionIcon />
              {notionSent ? "Sent!" : notionSending ? "Sending…" : "Notion"}
            </button>
          )}
          <button type="button" className="i-tbtn" onClick={downloadMd}>.md</button>
          <button type="button" className="i-tbtn" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
        </div>
      </div>

      {/* ── Transcript ── */}
      {activeTab === "transcript" && (
        <div className="i-seglist">
          {entry.segments.map((s, k) => (
            <SegmentRow
              key={k}
              idx={k}
              speaker={s.speaker}
              name={names[s.speaker] || ""}
              displayName={spkDisplay(s.speaker, names)}
              color={spkColor(s.speaker)}
              time={fmtTime(s.start)}
              text={s.text}
              edited={s.edited}
              editingSpk={editingSpk === k}
              editingText={editingSegIdx === k}
              onStartEdit={onStartEdit}
              onRename={onRename}
              onCancelEdit={onCancelEdit}
              onStartTextEdit={onStartTextEdit}
              onSaveText={onSaveText}
              onCancelTextEdit={onCancelTextEdit}
            />
          ))}
        </div>
      )}

      {/* ── Summary / Actions ── */}
      {(activeTab === "summary" || activeTab === "actions") && (
        <div className="i-ai-panel">
          {isAiGated ? (
            <UpgradeCard
              title="AI analysis is a Pro feature"
              body="Summaries and action items need the Pro plan. Transcription stays free."
              onUpgrade={onUpgrade}
            />
          ) : (
            <>
              <div className="i-ai-controls">
                <div className="i-seg-detail">
                  {["short", "medium", "detailed"].map((d) => (
                    <button key={d} type="button" className={`i-pill${detail === d ? " on" : ""}`}
                      onClick={() => setDetail(d)}>{d}</button>
                  ))}
                </div>
                <input className="i-field" placeholder="Focus on… (optional)" value={focus}
                  onChange={(e) => setFocus(e.target.value)} style={{ flex: 1 }} />
                <button type="button" className="i-cook"
                  disabled={genBusy !== null || (activeTab === "summary" && autoSummaryPending)}
                  onClick={() => void runAI(activeTab as "summary" | "actions")}>
                  {genBusy === activeTab || (activeTab === "summary" && autoSummaryPending)
                    ? "Cooking…" : entry.aiResults[activeTab] ? "Regenerate" : "Generate"}
                </button>
                <button type="button" className="i-cook i-cook-ghost" disabled={genBusy !== null || autoSummaryPending}
                  title="Generate summary + action items"
                  onClick={() => void runBoth()}>
                  {genBusy && genBusy !== activeTab ? "Cooking…" : "Both ↓"}
                </button>
              </div>
              {genError && <p className="i-error">{genError}</p>}
              {entry.aiResults[activeTab]
                ? <div className="i-md">{renderMd(entry.aiResults[activeTab])}</div>
                : !genBusy && <p className="i-sub" style={{ margin: "14px 2px" }}>
                    {activeTab === "summary"
                      ? autoSummaryPending
                        ? "The summary is being written automatically — it will appear here in a minute."
                        : "A structured report of the conversation."
                      : "Tasks and recommendations extracted from the call."}
                  </p>}
            </>
          )}
        </div>
      )}

    </div>
  );
}
