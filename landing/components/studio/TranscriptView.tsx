"use client";
import type { Segment } from "@/lib/studio/mock-data";

const SPEAKER_COLORS = ["var(--s-spk-1)", "var(--s-spk-2)", "var(--s-spk-3)", "var(--s-spk-4)"];

// Чат-стиль транскрипта со speaker chips слева

export function TranscriptView({
  segments,
  speakerNames,
}: {
  segments: Segment[];
  speakerNames: Record<string, string>;
}) {
  // Уникальные raw-метки → индекс цвета (стабильный по очерёдности)
  const uniqueRaw = Array.from(new Set(segments.map((s) => s.speaker)));
  const colorIdx = (raw: string) => uniqueRaw.indexOf(raw);

  return (
    <div className="s-transcript">
      {segments.map((seg, i) => {
        const display = speakerNames[seg.speaker] ?? defaultSpeakerLabel(seg.speaker);
        const idx = colorIdx(seg.speaker);
        const color = SPEAKER_COLORS[idx % SPEAKER_COLORS.length];

        // Zero-padded "01", "02", "03"
        const num = String(idx + 1).padStart(2, "0");
        return (
          <div className="s-tx-line" key={i}>
            <span className="s-tx-avatar" style={{ background: color }}>
              {num}
            </span>
            <div className="s-tx-content">
              <div className="s-tx-meta">
                <b style={{ color }}>{display}</b>
                <span className="time">{formatTime(seg.start)}</span>
                {seg.edited && <span className="edited">edited</span>}
              </div>
              <div className="s-tx-text">{seg.text}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function defaultSpeakerLabel(raw: string): string {
  const m = raw.match(/(\d+)/);
  if (!m) return raw;
  return `Speaker ${parseInt(m[1], 10) + 1}`;
}

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `00:${mm}:${ss}`;
}
