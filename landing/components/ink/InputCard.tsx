"use client";
import { forwardRef, useEffect, useRef, useState } from "react";
import { SUPPORTED_LANGUAGES } from "@/lib/ink/config";

// InputCard — герой-объект. Принимает: текст, drag-and-drop / attach файла,
// запись (mic + tab-audio mix). Пресет определяет, что авто-генерится после
// транскрипции. Стоп записи = сразу Cook (zero-friction).

export type PresetKey = "transcript" | "summary" | "actions";

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "transcript", label: "Transcript" },
  { key: "summary", label: "Summary" },
  { key: "actions", label: "Action items" },
];

export const InputCard = forwardRef<HTMLDivElement, {
  cooking: boolean;
  recording: boolean;
  recSeconds: number;
  preset: PresetKey;
  onPreset: (p: PresetKey) => void;
  language: string;
  onLanguage: (v: string) => void;
  speakers: string;
  onSpeakers: (v: string) => void;
  onCookText: (text: string) => void;
  onFile: (f: File) => void;
  onRecToggle: () => void;
}>(function InputCard(p, ref) {
  const [text, setText] = useState("");
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (p.cooking) setText(""); }, [p.cooking]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  return (
    <div
      ref={ref}
      className={`i-card${drag ? " drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault(); setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f && !p.cooking && !p.recording) p.onFile(f);
      }}
    >
      <textarea
        className="i-input"
        rows={3}
        placeholder={p.recording
          ? "Recording… stop to cook it into shape."
          : "Drop audio or video, paste text, or just start typing…"}
        value={text}
        disabled={p.recording}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!p.cooking && text.trim()) p.onCookText(text.trim());
          }
        }}
      />

      <div className="i-pills">
        {PRESETS.map((pr) => (
          <button key={pr.key} type="button"
            className={`i-pill${p.preset === pr.key ? " on" : ""}`}
            onClick={() => p.onPreset(pr.key)}>
            {pr.label}
          </button>
        ))}
        <span className="i-pill off" title="Custom prompts — Phase 2">Custom ▾</span>
      </div>

      <div className="i-cardfoot">
        <input ref={fileRef} type="file" accept="audio/*,video/*" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onFile(f); e.target.value = ""; }} />
        <button type="button" className="i-iconbtn" aria-label="Attach audio or video"
          style={{ width: 30, height: 30 }} disabled={p.cooking || p.recording}
          onClick={() => fileRef.current?.click()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.65 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48" />
          </svg>
        </button>

        <button type="button" className={`i-rec${p.recording ? " live" : ""}`}
          onClick={() => { if (!p.cooking) p.onRecToggle(); }}>
          <span className="i-rec-dot" />
          {p.recording ? <>stop · <span className="i-rec-timer">{fmt(p.recSeconds)}</span></> : "rec"}
        </button>

        <select className="i-mini" aria-label="Language" value={p.language}
          onChange={(e) => p.onLanguage(e.target.value)} disabled={p.recording}>
          {SUPPORTED_LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>
        <select className="i-mini" aria-label="Speakers" value={p.speakers}
          onChange={(e) => p.onSpeakers(e.target.value)} disabled={p.recording}>
          <option value="">Spk: auto</option>
          {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>Spk: {n}</option>)}
        </select>

        <span className="i-spacer" />
        <span className="i-kbd">⏎ cook</span>
        <button type="button" className="i-cook"
          disabled={p.cooking || p.recording || !text.trim()}
          onClick={() => p.onCookText(text.trim())}>
          {p.cooking ? "Cooking…" : "Cook"}
        </button>
      </div>
    </div>
  );
});
