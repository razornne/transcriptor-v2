"use client";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { SUPPORTED_LANGUAGES } from "@/lib/ink/config";
import type { PipelineSteps } from "@/lib/ink/api";

function formatDuration(s: number): string {
  const sec = Math.floor(s);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const ss = sec % 60;
    return `${m}:${String(ss).padStart(2, "0")}`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// Honest pipeline stages — fixed order + human labels for the timeline.
const STEP_ORDER = ["container", "audio_split", "transcription", "diarization", "ai_formatting"] as const;
const STEP_LABELS: Record<string, string> = {
  container: "Container",
  audio_split: "Audio split",
  transcription: "Transcription",
  diarization: "Diarization",
  ai_formatting: "AI formatting",
};

// ── Processing timeline ─────────────────────────────────────────────────────
// Ultra-minimal vertical stage list. Running step pulses in cinnabar and ticks a
// live seconds counter (server elapsed re-synced each poll, interpolated on the
// client via rAF). Completed steps show their honest measured duration.
// chunkProgress is optional — only passed for long recordings (chunked pipeline).
function StepTimeline({ pipeline, chunkProgress }: {
  pipeline: PipelineSteps;
  chunkProgress?: { done: number; total: number } | null;
}) {
  const [, force] = useState(0);
  const syncRef = useRef<{ step: string; base: number; at: number } | null>(null);

  const running = STEP_ORDER.find((k) => pipeline[k]?.status === "running") || null;

  // Re-sync the live counter to the server's elapsed_sec on every poll.
  useEffect(() => {
    if (running) {
      const server = pipeline[running]?.elapsed_sec ?? 0;
      syncRef.current = { step: running, base: server, at: performance.now() };
    } else {
      syncRef.current = null;
    }
  }, [pipeline, running]);

  // rAF tick while a step runs — throttled to ~5fps (a seconds counter needs no more).
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last > 180) { last = t; force((n) => (n + 1) % 1_000_000); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  const liveElapsed = (step: string): number => {
    const s = syncRef.current;
    if (s && s.step === step) return Math.max(0, s.base + (performance.now() - s.at) / 1000);
    return pipeline[step]?.elapsed_sec ?? 0;
  };

  return (
    <ol className="i-timeline" aria-label="Processing pipeline">
      {STEP_ORDER.map((key) => {
        const st = pipeline[key];
        if (!st) return null;
        const status = st.status;
        return (
          <li key={key} className={`i-tl-step ${status}`}>
            <span className="i-tl-marker" aria-hidden="true" />
            <span className="i-tl-label">{STEP_LABELS[key] || key}</span>
            <span className="i-tl-time">
              {status === "running"
                ? <>
                    {formatDuration(liveElapsed(key))}
                    {key === "transcription" && chunkProgress
                      ? <span className="i-tl-chunk"> · {chunkProgress.done}/{chunkProgress.total}</span>
                      : null}
                  </>
                : status === "completed"
                  ? formatDuration(Math.round(st.duration_sec ?? 0))
                  : status === "failed"
                    ? "failed"
                    : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// Live capture levels. Reads a ref and writes bar widths directly each frame —
// no React state, so an hour-long call doesn't re-render the page 10×/sec.
function LevelMeters({ levelsRef }: { levelsRef: MutableRefObject<{ mic: number; sys: number }> }) {
  const micRef = useRef<HTMLDivElement>(null);
  const sysRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const { mic, sys } = levelsRef.current;
      if (micRef.current) micRef.current.style.width = `${Math.min(100, mic * 220)}%`;
      if (sysRef.current) sysRef.current.style.width = `${Math.min(100, sys * 220)}%`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [levelsRef]);
  return (
    <div className="i-levels" aria-hidden="true">
      <div className="i-level-row">
        <span className="i-level-label">Mic</span>
        <div className="i-level-bar"><div ref={micRef} className="i-level-fill mic" /></div>
      </div>
      <div className="i-level-row">
        <span className="i-level-label">Tab</span>
        <div className="i-level-bar"><div ref={sysRef} className="i-level-fill sys" /></div>
      </div>
    </div>
  );
}

export function InputCard({
  cooking, pipeline, chunkProgress, recording, recSeconds, levelsRef,
  language, onLanguage,
  speakers, onSpeakers,
  context, onContext,
  onFile, onRecToggle,
  inWorkspace, visibility, onVisibility,
}: {
  cooking: boolean;
  pipeline?: PipelineSteps | null;
  chunkProgress?: { done: number; total: number } | null;
  recording: boolean;
  recSeconds: number;
  levelsRef?: MutableRefObject<{ mic: number; sys: number }>;
  language: string;
  onLanguage: (v: string) => void;
  speakers: string;
  onSpeakers: (v: string) => void;
  context: string;
  onContext: (v: string) => void;
  onFile: (f: File) => void;
  onRecToggle: () => void;
  inWorkspace?: boolean;
  visibility?: "private" | "workspace";
  onVisibility?: (v: "private" | "workspace") => void;
}) {
  const [drag, setDrag] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ctxRef = useRef<HTMLInputElement>(null);
  const hasContext = context.trim().length > 0;
  const hasPipeline = !!pipeline && Object.keys(pipeline).length > 0;

  useEffect(() => { if (contextOpen) ctxRef.current?.focus(); }, [contextOpen]);

  return (
    <div
      className={`i-card${drag ? " drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault(); setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f && !cooking && !recording) onFile(f);
      }}
    >
      {/* ── Dropzone body ── */}
      <div className={`i-dropzone${recording ? " live" : ""}${cooking ? " cooking" : ""}${drag ? " dragging" : ""}`}>
        {recording ? (
          <div className="i-dropzone-rec">
            <span className="i-rec-dot-lg" />
            <span className="i-dropzone-timer">{formatDuration(recSeconds)}</span>
            {levelsRef && <LevelMeters levelsRef={levelsRef} />}
            <span className="i-dropzone-hint-sub">Recording in progress — click Stop when done</span>
          </div>
        ) : cooking ? (
          hasPipeline ? (
            <StepTimeline pipeline={pipeline!} chunkProgress={chunkProgress} />
          ) : (
            <div className="i-dropzone-rec">
              <span className="i-dropzone-hint-sub">Processing…</span>
            </div>
          )
        ) : (
          <div className="i-dropzone-idle">
            <svg
              className="i-dropzone-icon"
              width="26" height="26" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
            <span className="i-dropzone-hint">{drag ? "Release to upload" : "Drop audio or video here"}</span>
            <span className="i-dropzone-hint-sub">or click Record below</span>
          </div>
        )}
      </div>

      {/* ── Control row ── */}
      <div className="i-ctrl-row">
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,video/*"
          hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }}
        />

        {/* Hero Record button */}
        <button
          type="button"
          className={`i-rec-hero${recording ? " live" : ""}`}
          disabled={cooking}
          onClick={() => onRecToggle()}
          aria-label={recording ? "Stop recording" : "Start recording"}
        >
          <span className="i-rec-dot" />
          {recording
            ? <><span>Stop</span> · <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatDuration(recSeconds)}</span></>
            : "Record"
          }
        </button>

        {!recording && (
          <button
            type="button"
            className="i-upload-btn"
            disabled={cooking}
            onClick={() => fileRef.current?.click()}
            aria-label="Upload audio or video file"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
            </svg>
            Upload
          </button>
        )}

        <select
          className="i-mini"
          aria-label="Language"
          value={language}
          onChange={(e) => onLanguage(e.target.value)}
          disabled={recording || cooking}
        >
          {SUPPORTED_LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>

        <select
          className="i-mini"
          aria-label="Speakers"
          value={speakers}
          onChange={(e) => onSpeakers(e.target.value)}
          disabled={recording || cooking}
        >
          <option value="">Spk: auto</option>
          {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>Spk: {n}</option>)}
        </select>

        <button
          type="button"
          className={`i-ctx-btn${contextOpen || hasContext ? " on" : ""}`}
          aria-expanded={contextOpen}
          disabled={recording || cooking}
          onClick={() => setContextOpen((v) => !v)}
        >
          {hasContext ? "Context ·" : "+ Context"}
        </button>
      </div>

      {/* ── Context expand row ── */}
      {contextOpen && (
        <div className="i-ctx-row">
          <input
            ref={ctxRef}
            className="i-field"
            value={context}
            placeholder="Topic, names, terms — helps Whisper"
            disabled={recording || cooking}
            onChange={(e) => onContext(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setContextOpen(false);
              if (e.key === "Enter") { e.preventDefault(); setContextOpen(false); }
            }}
            onBlur={() => { if (!context.trim()) setContextOpen(false); }}
          />
        </div>
      )}

      {/* ── Visibility selector — ONLY when user has a real workspace ── */}
      {inWorkspace && onVisibility && visibility && (
        <div className="i-vis-row">
          <span className="i-vis-label">Save as</span>
          <div className="i-vis-seg">
            <button
              type="button"
              className={`i-vis-btn${visibility === "private" ? " on" : ""}`}
              onClick={() => onVisibility("private")}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              Private
            </button>
            <button
              type="button"
              className={`i-vis-btn${visibility === "workspace" ? " on" : ""}`}
              onClick={() => onVisibility("workspace")}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              Workspace
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
