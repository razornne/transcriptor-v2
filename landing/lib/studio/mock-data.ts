// Mock-данные для Phase 1 каркаса. На Phase 2-4 заменяются реальными
// из Supabase / API. Структура зеркалит то что приходит с бэка.

export type Segment = {
  start: number;       // секунды от начала записи
  end: number;
  speaker: string;     // "SPEAKER_00", "SPEAKER_01", ...
  text: string;
  edited?: boolean;
};

export type HistoryEntry = {
  id: string;          // uuid из Supabase
  title: string;
  group: string;       // "Today" / "Yesterday" / "This week" / "Earlier"
  duration: string;    // "24:31" / "1:12:04"
  speakers: number;
  waveSeed: number;    // seed для mini-thumbnail waveform
};

export const MOCK_TRANSCRIPT: Segment[] = [
  { start: 4,   end: 11,  speaker: "SPEAKER_00", text: "Okay — can everyone hear me? Let me share my screen real quick." },
  { start: 11,  end: 14,  speaker: "SPEAKER_01", text: "Yeah, you're coming through clean. Go ahead." },
  { start: 14,  end: 28,  speaker: "SPEAKER_00", text: "Alright. The main thing I want to walk through today is the onboarding redesign — specifically the empty state and the first-run prompt." },
  { start: 28,  end: 32,  speaker: "SPEAKER_01", text: "Right. So we landed on the three-step version, didn't we?" },
  { start: 32,  end: 41,  speaker: "SPEAKER_00", text: "For now, yes. But I want to come back to it after we see retention next week." },
  { start: 41,  end: 44,  speaker: "SPEAKER_02", text: "Sorry — just joined. Did we already cover the analytics piece?" },
  { start: 44,  end: 51,  speaker: "SPEAKER_00", text: "Not yet — analytics is item three. We're on the empty state first." },
  { start: 51,  end: 54,  speaker: "SPEAKER_02", text: "Got it. I'll hold my questions." },
];

export const MOCK_HISTORY: HistoryEntry[] = [
  { id: "h7", title: "Standup",            group: "Today",     duration: "24:31",   speakers: 4, waveSeed: 13 },
  { id: "h6", title: "Design crit",        group: "Yesterday", duration: "51:08",   speakers: 3, waveSeed: 27 },
  { id: "h5", title: "1:1 w/ Sasha",       group: "Yesterday", duration: "32:47",   speakers: 2, waveSeed: 41 },
  { id: "h4", title: "Eng review",         group: "This week", duration: "1:12:04", speakers: 6, waveSeed: 55 },
  { id: "h3", title: "Product sync",       group: "This week", duration: "47:22",   speakers: 5, waveSeed: 69 },
  { id: "h2", title: "User research call", group: "This week", duration: "38:11",   speakers: 2, waveSeed: 83 },
  { id: "h1", title: "Kickoff",            group: "This week", duration: "1:04:18", speakers: 7, waveSeed: 97 },
];

export const MOCK_SPEAKER_NAMES: Record<string, string> = {
  SPEAKER_00: "Eli",
  SPEAKER_01: "Sasha",
  SPEAKER_02: "Niko",
};

export const MOCK_USER = {
  email: "nikitabulatnikov07@gmail.com",
  // Имя для отображения в user-pill (берётся из email если нет real name)
  displayName: "nikitabulatnikov07",
  initials: "NB",
  plan: "Free",
  // Hours для usage indicator. Free план — 60 мин = 1 час лимит.
  hoursUsed: 0.4,
  hoursLimit: 1,
};

export const SUPPORTED_LANGUAGES = [
  { code: "",   label: "Auto-detect", short: "AUTO" },
  { code: "en", label: "English",     short: "EN" },
  { code: "ru", label: "Русский",     short: "RU" },
  { code: "uk", label: "Українська",  short: "UK" },
];

// Псевдослучайные бары для waveform. Seeded — одинаково между renderами.
export function waveBars(n: number, seed = 1): number[] {
  const out: number[] = [];
  let x = seed * 9301 + 49297;
  for (let i = 0; i < n; i++) {
    x = (x * 9301 + 49297) % 233280;
    const r = x / 233280;
    const env = Math.sin((i / n) * Math.PI) * 0.7 + 0.3;
    out.push(Math.max(0.08, Math.min(1, env * (0.4 + r * 0.9))));
  }
  return out;
}
