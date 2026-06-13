"use client";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { HistoryEntry, Segment } from "@/lib/ink/db";
import { generate, generateCustom, UpgradeRequiredError, type Preset } from "@/lib/ink/api";
import { UpgradeCard } from "./UpgradeCard";

// Результат (OUTPUT): заголовок + segmented control Transcript/Summary/Action items/✦ Custom.
// Спринт 3: вкладка «✦ Custom ▾» — дропдаун пресетів юзера + модалка нового пресету.
// Спикеры переименовываются кликом по имени.

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

type Tab = "transcript" | "summary" | "actions" | "custom";

// ── мемоизированная строка сегмента ─────────────────────────────
const SegmentRow = memo(function SegmentRow({
  speaker, name, displayName, color, time, text, editing,
  onStartEdit, onRename, onCancelEdit,
}: {
  speaker: string; name: string; displayName: string; color: string;
  time: string; text: string; editing: boolean;
  onStartEdit: (label: string) => void;
  onRename: (label: string, value: string) => void;
  onCancelEdit: () => void;
}) {
  return (
    <div className="i-seg">
      <div className="i-seg-head">
        {editing ? (
          <input
            className="i-spk-edit" autoFocus
            defaultValue={name} placeholder={displayName}
            onBlur={(e) => onRename(speaker, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") onCancelEdit();
            }}
          />
        ) : (
          <button type="button" className="i-spk" style={{ color }}
            title="Rename speaker" onClick={() => onStartEdit(speaker)}>
            {displayName}
          </button>
        )}
        <span className="i-seg-time">{time}</span>
      </div>
      <p className="i-seg-text">{text}</p>
    </div>
  );
});

// ── модалка нового/редактирования пресету ────────────────────────
function PresetModal({
  preset, isTeamAvailable, onSave, onCancel,
}: {
  preset?: Preset;
  isTeamAvailable: boolean;
  onSave: (p: Preset) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(preset?.name || "");
  const [prompt, setPrompt] = useState(preset?.prompt || "");
  const [scope, setScope] = useState<"personal" | "team">(preset?.scope || "personal");
  const [err, setErr] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onCancel]);

  const submit = () => {
    const n = name.trim();
    const p = prompt.trim();
    if (!n) { setErr("Name is required."); return; }
    if (!p) { setErr("Prompt is required."); return; }
    if (p.length > 2000) { setErr("Prompt must be ≤ 2000 characters."); return; }
    onSave({
      id: preset?.id || crypto.randomUUID(),
      name: n,
      prompt: p,
      scope,
      created_by: preset?.created_by,
      updated_at: new Date().toISOString(),
    });
  };

  return (
    <div className="i-modal-back" onClick={(e) => { if ((e.target as HTMLElement).classList.contains("i-modal-back")) onCancel(); }}>
      <div className="i-pmodal" role="dialog" aria-modal="true" aria-label="New preset">
        <div className="i-pmodal-title">{preset ? "Edit preset" : "New preset"}</div>

        <div>
          <div className="i-pmodal-label">Name</div>
          <input
            ref={nameRef}
            className="i-field"
            value={name}
            maxLength={100}
            placeholder="e.g. Sales call debrief"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          />
        </div>

        <div>
          <div className="i-pmodal-label">
            Prompt
            <span style={{ marginLeft: 6, fontFamily: "var(--i-mono)", fontSize: 10, color: "var(--i-graphite)" }}>
              hint: use <code style={{ background: "var(--i-paper)", padding: "1px 4px", borderRadius: 3 }}>{"<<TRANSCRIPT_TEXT>>"}</code> to place transcript
            </span>
          </div>
          <textarea
            className="i-pmodal-textarea"
            value={prompt}
            maxLength={2000}
            placeholder={"Analyze the customer objections.\n\n<<TRANSCRIPT_TEXT>>"}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="i-pmodal-count">{prompt.length} / 2000</div>
        </div>

        {isTeamAvailable && (
          <div>
            <div className="i-pmodal-label">Scope</div>
            <div className="i-pmodal-scope">
              {(["personal", "team"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`i-pill${scope === s ? " on" : ""}`}
                  onClick={() => setScope(s)}
                >
                  {s === "personal" ? "Personal" : "Team"}
                </button>
              ))}
            </div>
          </div>
        )}

        {err && <div className="i-error">{err}</div>}

        <div className="i-pmodal-footer">
          <button type="button" className="i-pill" onClick={onCancel}>Cancel</button>
          <button type="button" className="i-cook" onClick={submit}>Save preset</button>
        </div>
      </div>
    </div>
  );
}

// ── дропдаун пресетів ─────────────────────────────────────────────
function PresetDropdown({
  presets, teamPresets, runningPresetId,
  onRun, onNewPreset, onClose,
}: {
  presets: Preset[];
  teamPresets: Preset[];
  runningPresetId: string | null;
  onRun: (p: Preset) => void;
  onNewPreset: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Клік за межами → закрити
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const tid = setTimeout(() => document.addEventListener("mousedown", h), 0);
    return () => { clearTimeout(tid); document.removeEventListener("mousedown", h); };
  }, [onClose]);

  const hasPersonal = presets.length > 0;
  const hasTeam = teamPresets.length > 0;
  const isEmpty = !hasPersonal && !hasTeam;

  return (
    <div ref={ref} className="i-pdrop">
      {hasPersonal && (
        <>
          <div className="i-pdrop-sect">Mine</div>
          {presets.map((p) => (
            <button key={p.id} type="button"
              className={`i-pdrop-item${runningPresetId === p.id ? " busy" : ""}`}
              disabled={!!runningPresetId}
              onClick={() => { onRun(p); onClose(); }}>
              {p.name}
              {runningPresetId === p.id && <span style={{ marginLeft: "auto", fontFamily: "var(--i-mono)", fontSize: 10, color: "var(--i-graphite)" }}>…</span>}
            </button>
          ))}
        </>
      )}
      {hasTeam && (
        <>
          {hasPersonal && <div className="i-pdrop-sep" />}
          <div className="i-pdrop-sect">Team</div>
          {teamPresets.map((p) => (
            <button key={p.id} type="button"
              className={`i-pdrop-item${runningPresetId === p.id ? " busy" : ""}`}
              disabled={!!runningPresetId}
              onClick={() => { onRun(p); onClose(); }}>
              {p.name}
              <span className="scope">team</span>
            </button>
          ))}
        </>
      )}
      {isEmpty && <div className="i-pdrop-empty">No presets yet</div>}
      <div className="i-pdrop-sep" />
      <button type="button" className="i-pdrop-new" onClick={() => { onNewPreset(); onClose(); }}>
        <span style={{ fontSize: 14, lineHeight: 1 }}>+</span> New preset
      </button>
    </div>
  );
}

// ── ResultView ────────────────────────────────────────────────────
export function ResultView({
  entry, plan, presets, teamPresets, onPatch, onPresetsChange, onTeamPresetsChange,
}: {
  entry: HistoryEntry;
  plan: string;
  presets: Preset[];
  teamPresets: Preset[];
  onPatch: (fields: Partial<HistoryEntry>, db: Record<string, unknown>) => void;
  onPresetsChange: (updated: Preset[]) => void;
  onTeamPresetsChange: (updated: Preset[]) => void;
}) {
  const [tab, setTab] = useState<Tab>("transcript");
  const [genBusy, setGenBusy] = useState<Tab | null>(null);
  const [genError, setGenError] = useState("");
  const [gated, setGated] = useState(false);
  const [detail, setDetail] = useState("medium");
  const [focus, setFocus] = useState("");
  const [editingSpk, setEditingSpk] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Custom tab state
  const [customDropOpen, setCustomDropOpen] = useState(false);
  const [runningPresetId, setRunningPresetId] = useState<string | null>(null);
  const [presetModalOpen, setPresetModalOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState<Preset | undefined>(undefined);

  const isTeamAvailable = plan === "team";
  const names = entry.speakerNames;
  const aiGated = plan === "free" || gated;

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

  const runCustom = async (preset: Preset) => {
    if (runningPresetId) return;
    setRunningPresetId(preset.id);
    setGenError("");
    setTab("custom");
    try {
      const text = await generateCustom(
        entry.segments, names, preset.id,
        entry.lang === "auto" ? "" : entry.lang,
      );
      const ai = {
        ...entry.aiResults,
        custom: text,
        custom_label: preset.name,
      };
      onPatch({ aiResults: ai }, { ai_results: ai });
    } catch (e) {
      if (e instanceof UpgradeRequiredError) setGated(true);
      else setGenError(`custom generation failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setRunningPresetId(null);
    }
  };

  const handleSavePreset = async (preset: Preset) => {
    setPresetModalOpen(false);
    const isTeam = preset.scope === "team";
    const list = isTeam ? [...teamPresets] : [...presets];
    const idx = list.findIndex((p) => p.id === preset.id);
    if (idx >= 0) list[idx] = preset; else list.unshift(preset);
    // Optimistic
    if (isTeam) onTeamPresetsChange(list); else onPresetsChange(list);
  };

  const onStartEdit = useCallback((label: string) => setEditingSpk(label), []);
  const onCancelEdit = useCallback(() => setEditingSpk(null), []);
  const onRename = useCallback((label: string, value: string) => {
    setEditingSpk(null);
    const next = { ...entry.speakerNames };
    if (value.trim()) next[label] = value.trim(); else delete next[label];
    onPatch({ speakerNames: next }, { speaker_names: next });
  }, [entry.speakerNames, onPatch]);

  const exportText = tab === "transcript"
    ? transcriptText(entry.segments, names)
    : tab === "custom"
    ? (entry.aiResults.custom || "")
    : (entry.aiResults[tab] || "");

  const copy = async () => {
    try { await navigator.clipboard.writeText(exportText); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch {}
  };

  const downloadMd = () => {
    const md = `# ${entry.title || "Transcript"}\n\n${transcriptText(entry.segments, names)}\n` +
      (entry.aiResults.summary ? `\n---\n\n## Summary\n\n${entry.aiResults.summary}\n` : "") +
      (entry.aiResults.actions ? `\n---\n\n## Action items\n\n${entry.aiResults.actions}\n` : "") +
      (entry.aiResults.custom ? `\n---\n\n## ${entry.aiResults.custom_label || "Custom"}\n\n${entry.aiResults.custom}\n` : "");
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
      </div>

      <div className="i-tabs">
        <div className="i-segctl" role="tablist">
          {(["transcript", "summary", "actions"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t}
              className={`i-tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
              {t === "transcript" ? "Transcript" : t === "summary" ? "Summary" : "Action items"}
              {t !== "transcript" && entry.aiResults[t] && <span className="i-tab-dot" />}
            </button>
          ))}

          {/* ── Custom ▾ ── */}
          <div className="i-custom-wrap">
            <button
              type="button" role="tab" aria-selected={tab === "custom"}
              aria-haspopup="listbox"
              className={`i-tab i-tab-custom${tab === "custom" ? " on" : ""}${!!runningPresetId ? " busy" : ""}`}
              onClick={() => { setCustomDropOpen((v) => !v); if (tab !== "custom") setTab("custom"); }}
            >
              <span className="i-custom-star">✦</span>
              Custom
              {entry.aiResults.custom && tab !== "custom" && <span className="i-tab-dot" />}
              <span className={`i-custom-arrow${customDropOpen ? " up" : ""}`}>▾</span>
            </button>
            {customDropOpen && (
              <PresetDropdown
                presets={presets}
                teamPresets={teamPresets}
                runningPresetId={runningPresetId}
                onRun={runCustom}
                onNewPreset={() => { setEditingPreset(undefined); setPresetModalOpen(true); }}
                onClose={() => setCustomDropOpen(false)}
              />
            )}
          </div>
        </div>

        <span className="i-spacer" />
        <button type="button" className="i-pill" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
        <button type="button" className="i-pill" onClick={downloadMd}>.md</button>
      </div>

      {/* ── Transcript ── */}
      {tab === "transcript" && (
        <div className="i-seglist">
          {entry.segments.map((s, k) => (
            <SegmentRow
              key={k}
              speaker={s.speaker}
              name={names[s.speaker] || ""}
              displayName={spkDisplay(s.speaker, names)}
              color={spkColor(s.speaker)}
              time={fmtTime(s.start)}
              text={s.text}
              editing={editingSpk === s.speaker}
              onStartEdit={onStartEdit}
              onRename={onRename}
              onCancelEdit={onCancelEdit}
            />
          ))}
        </div>
      )}

      {/* ── Summary / Actions ── */}
      {(tab === "summary" || tab === "actions") && (
        <div className="i-ai-panel">
          {aiGated ? (
            <UpgradeCard
              title="AI analysis is a Pro feature"
              body="Summaries and action items need the Pro plan. Transcription stays free."
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
                <button type="button" className="i-cook" disabled={genBusy !== null}
                  onClick={() => void runAI(tab as "summary" | "actions")}>
                  {genBusy === tab ? "Cooking…" : entry.aiResults[tab] ? "Regenerate" : "Generate"}
                </button>
              </div>
              {genError && <p className="i-error">{genError}</p>}
              {entry.aiResults[tab]
                ? <div className="i-md">{entry.aiResults[tab]}</div>
                : !genBusy && <p className="i-sub" style={{ margin: "14px 2px" }}>
                    {tab === "summary"
                      ? "A structured report of the conversation."
                      : "Tasks and recommendations extracted from the call."}
                  </p>}
            </>
          )}
        </div>
      )}

      {/* ── Custom ── */}
      {tab === "custom" && (
        <div className="i-ai-panel">
          {aiGated ? (
            <UpgradeCard
              title="Custom presets are a Pro feature"
              body="Create your own analysis templates with the Pro plan."
            />
          ) : runningPresetId ? (
            <p className="i-status" style={{ marginTop: 14 }}>
              Running preset<span style={{ fontFamily: "var(--i-mono)" }}>…</span>
            </p>
          ) : entry.aiResults.custom ? (
            <>
              {entry.aiResults.custom_label && (
                <p className="i-custom-label">
                  {entry.aiResults.custom_label}
                </p>
              )}
              <div className="i-md">{entry.aiResults.custom}</div>
            </>
          ) : (
            <p className="i-sub" style={{ margin: "14px 2px" }}>
              Select a preset from the ✦ Custom menu above, or create one with + New preset.
            </p>
          )}
          {genError && <p className="i-error" style={{ marginTop: 8 }}>{genError}</p>}
        </div>
      )}

      {/* ── Preset creation modal ── */}
      {presetModalOpen && (
        <PresetModal
          preset={editingPreset}
          isTeamAvailable={isTeamAvailable}
          onSave={handleSavePreset}
          onCancel={() => setPresetModalOpen(false)}
        />
      )}
    </div>
  );
}
