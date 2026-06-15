"use client";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { HistoryEntry, Segment } from "@/lib/ink/db";
import { generate, generateCustom, sendToNotion, UpgradeRequiredError, type Preset } from "@/lib/ink/api";
import { UpgradeCard } from "./UpgradeCard";

// Результат (OUTPUT): заголовок + segmented control Transcript/Summary/Actions/Notes/✦ Custom.
// Спринт 3: вкладка «✦ Custom ▾» — дропдаун пресетів + модалка нового пресету.
// Спринт 4: Notes (4th tab, дебаунс 600ms), інлайн-редагування тексту сегмента,
//           Notion export, .txt download, tab state lifted (activeTab/onTabChange від page.tsx).

export type Tab = "transcript" | "summary" | "actions" | "notes" | "custom";

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

export function transcriptText(segments: Segment[], names: Record<string, string>): string {
  return segments.map((s) => `[${spkDisplay(s.speaker, names)}]: ${s.text}`).join("\n\n");
}

function txtText(segments: Segment[], names: Record<string, string>): string {
  return segments.map((s) => `${spkDisplay(s.speaker, names)}: ${s.text}`).join("\n\n");
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
  onStartEdit: (label: string) => void;
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
            title="Rename speaker"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();   // изолирует клик от родительского контейнера фразы
              e.preventDefault();    // отменяет дефолтное поведение
              onStartEdit(speaker);
            }}
          >
            {displayName}
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
          <p className="i-seg-text">{text}</p>
          <button
            type="button" className="i-seg-pencil"
            aria-label="Edit text" onClick={() => onStartTextEdit(idx)}
          >✎</button>
        </div>
      )}
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
      name: n, prompt: p, scope,
      created_by: preset?.created_by,
      updated_at: new Date().toISOString(),
    });
  };

  return (
    <div className="i-modal-back" onClick={(e) => { if ((e.target as HTMLElement).classList.contains("i-modal-back")) onCancel(); }}>
      <div className="i-pmodal" role="dialog" aria-modal="true" aria-label="New preset">
        <div className="i-pmodal-title">{preset ? "Edit preset" : "New preset"}</div>
        <div className="i-pmodal-body">
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
                  <button key={s} type="button" className={`i-pill${scope === s ? " on" : ""}`} onClick={() => setScope(s)}>
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
    </div>
  );
}

// ── дропдаун пресетів ─────────────────────────────────────────────
function PresetDropdown({
  presets, teamPresets, runningPresetId, canCreate,
  onRun, onNewPreset, onClose,
}: {
  presets: Preset[];
  teamPresets: Preset[];
  runningPresetId: string | null;
  canCreate: boolean;
  onRun: (p: Preset) => void;
  onNewPreset: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

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
        <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
        {canCreate ? "New preset" : "New preset (Pro)"}
      </button>
    </div>
  );
}

// ── ResultView ────────────────────────────────────────────────────
export function ResultView({
  entry, plan, presets, teamPresets, notionConnected,
  activeTab, onTabChange,
  onPatch, onRenameSpeaker, onPresetsChange, onTeamPresetsChange,
  onUpgrade,
}: {
  entry: HistoryEntry;
  plan: string;
  presets: Preset[];
  teamPresets: Preset[];
  notionConnected?: boolean;
  activeTab: Tab;
  onTabChange: (t: Tab) => void;
  onPatch: (fields: Partial<HistoryEntry>, db: Record<string, unknown>) => void;
  onRenameSpeaker: (rawLabel: string, newName: string) => void;
  onPresetsChange: (updated: Preset[]) => void;
  onTeamPresetsChange: (updated: Preset[]) => void;
  onUpgrade?: () => void;
}) {
  const [genBusy, setGenBusy] = useState<Tab | null>(null);
  const [genError, setGenError] = useState("");
  const [gated, setGated] = useState(false);
  const [detail, setDetail] = useState("medium");
  const [focus, setFocus] = useState("");

  // Speaker rename
  const [editingSpk, setEditingSpk] = useState<string | null>(null);

  // Inline segment text editing
  const [editingSegIdx, setEditingSegIdx] = useState<number | null>(null);

  // Notes: local state + debounced save
  const [localNotes, setLocalNotes] = useState(entry.notes || "");
  const notesTimerRef = useRef<number>(0);
  useEffect(() => { setLocalNotes(entry.notes || ""); }, [entry.id]);
  useEffect(() => () => window.clearTimeout(notesTimerRef.current), []);

  // Notion send state
  const [notionSending, setNotionSending] = useState(false);
  const [notionSent, setNotionSent] = useState(false);
  const [notionError, setNotionError] = useState("");

  // Custom tab state
  const [customDropOpen, setCustomDropOpen] = useState(false);
  const [runningPresetId, setRunningPresetId] = useState<string | null>(null);
  const [presetModalOpen, setPresetModalOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState<Preset | undefined>(undefined);

  const [copied, setCopied] = useState(false);

  const isTeamAvailable = plan === "team";
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

  const runCustom = async (preset: Preset) => {
    if (runningPresetId) return;
    setRunningPresetId(preset.id);
    setGenError("");
    onTabChange("custom");
    try {
      const text = await generateCustom(
        entry.segments, names, preset.id,
        entry.lang === "auto" ? "" : entry.lang,
      );
      const ai = { ...entry.aiResults, custom: text, custom_label: preset.name };
      onPatch({ aiResults: ai }, { ai_results: ai });
    } catch (e) {
      if (e instanceof UpgradeRequiredError) setGated(true);
      else setGenError(`custom generation failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setRunningPresetId(null);
    }
  };

  const handleSavePreset = (preset: Preset) => {
    setPresetModalOpen(false);
    const isTeam = preset.scope === "team";
    const list = isTeam ? [...teamPresets] : [...presets];
    const idx = list.findIndex((p) => p.id === preset.id);
    if (idx >= 0) list[idx] = preset; else list.unshift(preset);
    if (isTeam) onTeamPresetsChange(list); else onPresetsChange(list);
  };

  const handleNewPreset = () => {
    if (isAiGated) {
      // Show UpgradeCard in panel body — just close dropdown, panel handles it
      return;
    }
    setEditingPreset(undefined);
    setPresetModalOpen(true);
  };

  // Speaker rename handlers
  const onStartEdit = useCallback((label: string) => {
    setEditingSegIdx(null);
    setEditingSpk(label);
  }, []);
  const onCancelEdit = useCallback(() => setEditingSpk(null), []);
  const onRename = useCallback((label: string, value: string) => {
    setEditingSpk(null);
    // Optimistic local update + persist via /api/entries/<id>/rename-speaker.
    // Applies to every block of this speaker (display derives from the map).
    onRenameSpeaker(label, value.trim());
  }, [onRenameSpeaker]);

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

  // Notes debounced change
  const onNotesChange = (text: string) => {
    setLocalNotes(text);
    window.clearTimeout(notesTimerRef.current);
    notesTimerRef.current = window.setTimeout(() => {
      onPatch({ notes: text }, { notes: text });
    }, 600);
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
    : activeTab === "notes"
    ? localNotes
    : activeTab === "custom"
    ? (entry.aiResults.custom || "")
    : (entry.aiResults[activeTab] || "");

  const copy = async () => {
    try { await navigator.clipboard.writeText(exportText); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch {}
  };

  const downloadMd = () => {
    const md = `# ${entry.title || "Transcript"}\n\n${transcriptText(entry.segments, names)}\n` +
      (localNotes ? `\n---\n\n## Notes\n\n${localNotes}\n` : "") +
      (entry.aiResults.summary ? `\n---\n\n## Summary\n\n${entry.aiResults.summary}\n` : "") +
      (entry.aiResults.actions ? `\n---\n\n## Action items\n\n${entry.aiResults.actions}\n` : "") +
      (entry.aiResults.custom ? `\n---\n\n## ${entry.aiResults.custom_label || "Custom"}\n\n${entry.aiResults.custom}\n` : "");
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
      </div>

      <div className="i-tabs">
        <div className="i-segctl" role="tablist">
          {(["transcript", "summary", "actions", "notes"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={activeTab === t}
              className={`i-tab${activeTab === t ? " on" : ""}`} onClick={() => onTabChange(t)}>
              {t === "transcript" ? "Transcript" : t === "summary" ? "Summary" : t === "actions" ? "Action items" : "Notes"}
              {t !== "transcript" && t !== "notes" && entry.aiResults[t] && <span className="i-tab-dot" />}
              {t === "notes" && localNotes && <span className="i-tab-dot" />}
            </button>
          ))}

          {/* ── Custom ▾ — always visible ── */}
          <div className="i-custom-wrap">
            <button
              type="button" role="tab" aria-selected={activeTab === "custom"}
              aria-haspopup="listbox"
              className={`i-tab i-tab-custom${activeTab === "custom" ? " on" : ""}${!!runningPresetId ? " busy" : ""}`}
              onClick={() => { setCustomDropOpen((v) => !v); if (activeTab !== "custom") onTabChange("custom"); }}
            >
              <span className="i-custom-star">✦</span>
              Custom
              {entry.aiResults.custom && activeTab !== "custom" && <span className="i-tab-dot" />}
              <span className={`i-custom-arrow${customDropOpen ? " up" : ""}`}>▾</span>
            </button>
            {customDropOpen && (
              <PresetDropdown
                presets={presets}
                teamPresets={teamPresets}
                runningPresetId={runningPresetId}
                canCreate={!isAiGated}
                onRun={runCustom}
                onNewPreset={handleNewPreset}
                onClose={() => setCustomDropOpen(false)}
              />
            )}
          </div>
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
              editingSpk={editingSpk === s.speaker}
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
                <button type="button" className="i-cook" disabled={genBusy !== null}
                  onClick={() => void runAI(activeTab as "summary" | "actions")}>
                  {genBusy === activeTab ? "Cooking…" : entry.aiResults[activeTab] ? "Regenerate" : "Generate"}
                </button>
              </div>
              {genError && <p className="i-error">{genError}</p>}
              {entry.aiResults[activeTab]
                ? <div className="i-md">{entry.aiResults[activeTab]}</div>
                : !genBusy && <p className="i-sub" style={{ margin: "14px 2px" }}>
                    {activeTab === "summary"
                      ? "A structured report of the conversation."
                      : "Tasks and recommendations extracted from the call."}
                  </p>}
            </>
          )}
        </div>
      )}

      {/* ── Notes ── */}
      {activeTab === "notes" && (
        <div className="i-ai-panel">
          <textarea
            className="i-notes-area"
            value={localNotes}
            onChange={(e) => onNotesChange(e.target.value)}
            placeholder="Add notes, timestamps, follow-ups… auto-saved."
          />
        </div>
      )}

      {/* ── Custom ── */}
      {activeTab === "custom" && (
        <div className="i-ai-panel">
          {isAiGated ? (
            <UpgradeCard
              title="Custom presets are a Pro feature"
              body="Create your own analysis templates with the Pro plan."
              onUpgrade={onUpgrade}
            />
          ) : runningPresetId ? (
            <p className="i-status" style={{ marginTop: 14 }}>
              Running preset<span style={{ fontFamily: "var(--i-mono)" }}>…</span>
            </p>
          ) : entry.aiResults.custom ? (
            <>
              {entry.aiResults.custom_label && (
                <p className="i-custom-label">{entry.aiResults.custom_label}</p>
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
