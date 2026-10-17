// Хелперы транскрипта: цвета и имена спикеров, группировка реплик в «ходы»,
// доли времени и подсказки имён (их присылает сервер, см. app.py /api/speaker-names).
import type { Segment } from "./db";

const COLORS = ["var(--i-spk-1)", "var(--i-spk-2)", "var(--i-spk-3)", "var(--i-spk-4)"];
const SOFT = ["var(--i-spk-1-soft)", "var(--i-spk-2-soft)", "var(--i-spk-3-soft)", "var(--i-spk-4-soft)"];
const BARS = ["var(--i-spk-1-bar)", "var(--i-spk-2-bar)", "var(--i-spk-3-bar)", "var(--i-spk-4-bar)"];

function spkIndex(label: string): number {
  const m = label.match(/(\d+)/);
  return (m ? parseInt(m[1], 10) : 0) % COLORS.length;
}
export const spkColor = (label: string) => COLORS[spkIndex(label)];
export const spkSoft = (label: string) => SOFT[spkIndex(label)];
export const spkBar = (label: string) => BARS[spkIndex(label)];

export function spkDisplay(label: string, names: Record<string, string>): string {
  if (names[label]) return names[label];
  const m = label.match(/(\d+)/);
  return m ? `Speaker ${parseInt(m[1], 10) + 1}` : label;
}

/** Буква в кружке: «N» для Nikita, «2» для безымянного «Speaker 2». */
export function spkInitial(display: string): string {
  const num = /^Speaker (\d+)$/.exec(display);
  if (num) return num[1];
  return (display.trim()[0] || "?").toUpperCase();
}

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, "0")}`;
}

export function stripDash(text: string): string {
  return text.replace(/^—\s*/, "").trim();
}

export type Turn = { speaker: string; items: { idx: number; seg: Segment }[] };

/** Подряд идущие реплики одного спикера — один «ход» с одним заголовком. */
export function groupTurns(segments: Segment[]): Turn[] {
  const turns: Turn[] = [];
  segments.forEach((seg, idx) => {
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker) last.items.push({ idx, seg });
    else turns.push({ speaker: seg.speaker, items: [{ idx, seg }] });
  });
  return turns;
}

export type SpeakerStat = { label: string; seconds: number; share: number; firstIdx: number };

/** Кто сколько говорил; порядок — по первому появлению. */
export function speakerStats(segments: Segment[]): SpeakerStat[] {
  const map = new Map<string, SpeakerStat>();
  segments.forEach((s, idx) => {
    const st = map.get(s.speaker) ?? { label: s.speaker, seconds: 0, share: 0, firstIdx: idx };
    st.seconds += Math.max(0, s.end - s.start);
    map.set(s.speaker, st);
  });
  const list = [...map.values()];
  const total = list.reduce((a, b) => a + b.seconds, 0) || 1;
  list.forEach((s) => { s.share = s.seconds / total; });
  return list;
}

// ── Подсказки имён ───────────────────────────────────────────────────────
// Хранятся в ai_results (JSONB) под служебным ключом — отдельная колонка не нужна.
export type NameSuggestion = { speaker: string; name: string; evidence: string; at: number };
export const SUGGESTIONS_KEY = "_speaker_suggestions";

export function readSuggestions(aiResults: Record<string, string>, names: Record<string, string>): NameSuggestion[] {
  try {
    const list = JSON.parse(aiResults[SUGGESTIONS_KEY] || "[]") as NameSuggestion[];
    return list.filter((s) => s && s.speaker && s.name && !names[s.speaker]);
  } catch { return []; }
}

export const writeSuggestions = (list: NameSuggestion[]) => JSON.stringify(list);
