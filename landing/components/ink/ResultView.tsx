"use client";
import { useState } from "react";
import type { HistoryEntry, Segment } from "@/lib/ink/db";
import { generate, UpgradeRequiredError } from "@/lib/ink/api";

// Результат: заголовок (inline-rename) + табы Transcript / Summary / Actions
// + AI-генерация (detail/focus) + экспорт. Спикеры переименовываются кликом.

const SPK_COLORS = ["var(--i-accent)", "#C77D2E", "#7E6BC4", "#3E8E6E"];

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

export function transcriptText(segments: Segment[], names: Record<string, string>): string {
  return segments.map((s) => `[${spkDisplay(s.speaker, names)}]: ${s.text}`).join("\n\n");
}

type Tab = "transcript" | "summary" | "actions";

export function ResultView({
  entry,
  onPatch,
  initialTab = "transcript",
}: {
  entry: HistoryEntry;
  onPatch: (fields: Partial<HistoryEntry>, db: Record<string, unknown>) => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [genBusy, setGenBusy] = useState<Tab | null>(null);
  const [genError, setGenError] = useState("");
  const [detail, setDetail] = useState("medium");
  const [focus, setFocus] = useState("");
  const [editingSpk, setEditingSpk] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const names = entry.speakerNames;

  const runAI = async (template: "summary" | "actions") => {
    if (genBusy) return;
    setGenBusy(template);
    setGenError("");
    try {
      const text = await generate(entry.segments, names, template, entry.lang === "auto" ? "" : entry.lang, detail, focus);
      const ai = { ...entry.aiResults, [template]: text };
      onPatch({ aiResults: ai }, { ai_results: ai });
    } catch (e) {
      setGenError(e instanceof UpgradeRequiredError
        ? "AI analysis requires the Pro plan — upgrade in the old app settings for now."
        : `generation failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setGenBusy(null);
    }
  };

  const renameSpeaker = (label: string, name: string) => {
    const next = { ...names };
    if (name.trim()) next[label] = name.trim(); else delete next[label];
    onPatch({ speakerNames: next }, { speaker_names: next });
    setEditingSpk(null);
  };

  const exportText = tab === "transcript" ? transcriptText(entry.segments, names) : entry.aiResults[tab] || "";

  const copy = async () => {
    try { await navigator.clipboard.writeText(exportText); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch {}
  };

  const downloadMd = () => {
    const md = `# ${entry.title || "Transcript"}\n\n${transcriptText(entry.segments, names)}\n` +
      (entry.aiResults.summary ? `\n---\n\n## Summary\n\n${entry.aiResults.summary}\n` : "") +
      (entry.aiResults.actions ? `\n---\n\n## Action items\n\n${entry.aiResults.actions}\n` : "");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    a.download = `${(entry.title || "transcript").replace(/[^\wЀ-ӿ -]+/g, "").slice(0, 60) || "transcript"}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="i-resultview">
      <input
        className="i-title-input"
        value={entry.title || ""}
        placeholder="Untitled recording"
        onChange={(e) => onPatch({ title: e.target.value, titleIsAuto: false }, { title: e.target.value, title_is_auto: false })}
        aria-label="Recording title"
      />
      <div className="i-meta-row">
        <span>{new Set(entry.segments.map((s) => s.speaker)).size} speakers</span>
        <span>·</span>
        <span>{entry.segments.length ? fmtTime(Math.max(...entry.segments.map((s) => s.end))) : "0:00"}</span>
        <span>·</span>
        <span>{entry.lang}</span>
      </div>

      <div className="i-tabs" role="tablist">
        {(["transcript", "summary", "actions"] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t}
            className={`i-tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
            {t === "transcript" ? "Transcript" : t === "summary" ? "Summary" : "Actions"}
            {t !== "transcript" && entry.aiResults[t] && <span className="i-tab-dot" />}
          </button>
        ))}
        <span className="i-spacer" />
        <button type="button" className="i-pill" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
        <button type="button" className="i-pill" onClick={downloadMd}>.md</button>
      </div>

      {tab === "transcript" && (
        <div className="i-seglist">
          {entry.segments.map((s, k) => (
            <div className="i-seg" key={k}>
              <div className="i-seg-head">
                {editingSpk === s.speaker ? (
                  <input
                    className="i-spk-edit"
                    autoFocus
                    defaultValue={names[s.speaker] || ""}
                    placeholder={spkDisplay(s.speaker, {})}
                    onBlur={(e) => renameSpeaker(s.speaker, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setEditingSpk(null);
                    }}
                  />
                ) : (
                  <button type="button" className="i-spk" style={{ color: spkColor(s.speaker) }}
                    title="Rename speaker" onClick={() => setEditingSpk(s.speaker)}>
                    {spkDisplay(s.speaker, names)}
                  </button>
                )}
                <span className="i-seg-time">{fmtTime(s.start)}</span>
              </div>
              <p className="i-seg-text">{s.text}</p>
            </div>
          ))}
        </div>
      )}

      {tab !== "transcript" && (
        <div className="i-ai-panel">
          <div className="i-ai-controls">
            <div className="i-seg-detail">
              {["short", "medium", "detailed"].map((d) => (
                <button key={d} type="button" className={`i-pill${detail === d ? " on" : ""}`} onClick={() => setDetail(d)}>
                  {d}
                </button>
              ))}
            </div>
            <input className="i-field" placeholder="Focus on… (optional)" value={focus}
              onChange={(e) => setFocus(e.target.value)} style={{ flex: 1 }} />
            <button type="button" className="i-cook" disabled={genBusy !== null}
              onClick={() => void runAI(tab as "summary" | "actions")}>
              {genBusy === tab ? "Cooking…" : entry.aiResults[tab] ? "Regenerate" : "Generate"}
            </button>
          </div>
          {genError && <p className="i-error">{genError}</p>}
          {entry.aiResults[tab]
            ? <div className="i-md">{entry.aiResults[tab]}</div>
            : !genBusy && <p className="i-sub" style={{ margin: "14px 2px" }}>
                {tab === "summary" ? "A structured report of the conversation." : "Tasks and recommendations extracted from the call."}
              </p>}
        </div>
      )}
    </div>
  );
}
