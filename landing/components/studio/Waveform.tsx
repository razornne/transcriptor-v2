"use client";
import { waveBars } from "@/lib/studio/mock-data";

// Phase 1: статичная wave из псевдослучайных баров.
// Phase 2: заменим на live AnalyserNode подключённый к AudioContext.
export function Waveform({ playPct = 0.58, active = false }: { playPct?: number; active?: boolean }) {
  const bars1 = waveBars(72, 13);
  const bars2 = waveBars(72, 27);

  return (
    <div className="s-wave">
      {[bars1, bars2].map((bars, row) => (
        <div className="s-wave-row" key={row}>
          {bars.map((v, i) => {
            const past = i / bars.length < playPct;
            const h = v * 100 * (row === 0 ? 1 : 0.7);
            return (
              <span
                key={i}
                className={"s-wave-bar" + (past && active ? " played" : "")}
                style={{ height: `${Math.max(8, h)}%` }}
              />
            );
          })}
        </div>
      ))}
      {active && (
        <div
          className="s-wave-playhead"
          style={{ left: `calc(4px + (100% - 8px) * ${playPct})` }}
        />
      )}
    </div>
  );
}
