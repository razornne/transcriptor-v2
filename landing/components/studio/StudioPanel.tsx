"use client";
import { Waveform } from "./Waveform";
import { LanguagePicker } from "./LanguagePicker";

export type RecState = "idle" | "recording" | "processing" | "transcript";

export function StudioPanel({
  state,
  timer = "00:00:00",
  detectedSpeakers,
  language,
  onLanguageChange,
  onToggleRecord,
}: {
  state: RecState;
  timer?: string;
  detectedSpeakers?: number;
  language: string;
  onLanguageChange?: (code: string) => void;
  onToggleRecord?: () => void;
}) {
  const recording = state === "recording";

  return (
    <div className="s-studio-panel">
      {recording && <div className="s-studio-glow" />}

      <div className="s-studio-header">
        <div className="s-studio-status">
          {recording && <span className="s-live-dot" />}
          <span
            className="s-live-label"
            style={{ color: recording ? "var(--s-accent)" : "var(--s-mute)" }}
          >
            {recording ? "LIVE" : "STANDBY"}
          </span>
          <span className="s-divider" />
          <span className="s-timer">{timer}</span>
        </div>
      </div>

      <Waveform active={recording} />

      <div className="s-studio-controls">
        <button
          type="button"
          className={"s-rec-btn" + (recording ? "" : " standby")}
          onClick={onToggleRecord}
        >
          <span className="s-rec-btn-icon" />
          {recording ? "Stop recording" : "Start recording"}
        </button>

        <LanguagePicker value={language} onChange={onLanguageChange} />

        {detectedSpeakers !== undefined && (
          <div className="s-pill">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="6" cy="4" r="2" />
              <path d="M2 11c0-2 2-3.5 4-3.5s4 1.5 4 3.5" />
            </svg>
            Speakers · <span className="accent">{detectedSpeakers} detected</span>
          </div>
        )}

        <span className="s-shortcut-hint">
          Press <kbd>?</kbd>
        </span>
      </div>
    </div>
  );
}
