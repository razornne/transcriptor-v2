"use client";
import type { Segment } from "@/lib/studio/mock-data";

// Speakers row под StudioPanel — список уникальных спикеров с возможностью переименовать

const SPEAKER_COLORS = ["var(--s-spk-1)", "var(--s-spk-2)", "var(--s-spk-3)", "var(--s-spk-4)"];

export function SpeakerChips({
  segments,
  speakerNames,
  activeRaw,
  onRename,
}: {
  segments: Segment[];
  speakerNames: Record<string, string>;
  activeRaw?: string;          // raw label который сейчас "говорит" во время записи
  onRename?: (rawLabel: string) => void;
}) {
  // Уникальные raw-метки в порядке появления в транскрипте
  const uniqueRaw = Array.from(new Set(segments.map((s) => s.speaker)));

  if (uniqueRaw.length === 0) return null;

  return (
    <div className="s-speakers">
      <span className="s-speakers-label">Speakers</span>
      {uniqueRaw.map((raw, i) => {
        const display = speakerNames[raw] ?? defaultSpeakerLabel(raw);
        const color = SPEAKER_COLORS[i % SPEAKER_COLORS.length];
        const idx = i + 1;
        return (
          <button
            key={raw}
            type="button"
            className="s-spk-chip"
            onClick={() => onRename?.(raw)}
            style={
              raw === activeRaw
                ? {
                    background: `color-mix(in srgb, ${color} 16%, transparent)`,
                    borderColor: `color-mix(in srgb, ${color} 50%, transparent)`,
                    color: "var(--s-ink)",
                  }
                : undefined
            }
          >
            <span className="s-spk-chip-dot" style={{ background: color }}>
              {idx}
            </span>
            {display}
          </button>
        );
      })}
      <button type="button" className="s-spk-rename">+ Rename</button>
    </div>
  );
}

// "SPEAKER_00" → "Speaker 1" (1-indexed)
function defaultSpeakerLabel(raw: string): string {
  const m = raw.match(/(\d+)/);
  if (!m) return raw;
  return `Speaker ${parseInt(m[1], 10) + 1}`;
}
