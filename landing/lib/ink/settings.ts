"use client";

// Централізований localStorage-стор налаштувань /v2 (Ink & Halftone).
// Ключ: 'ink_settings'. Весь UI читає звідси; SettingsModal — тільки пише.

export type InkSettings = {
  quality:  "fast" | "best";
  language: string;             // "" = auto
  speakers: string;             // "" = auto
  aiDetail: "short" | "medium" | "detailed";
};

const KEY = "ink_settings";

const DEFAULTS: InkSettings = {
  quality:  "fast",
  language: "",
  speakers: "",
  aiDetail: "medium",
};

export function loadSettings(): InkSettings {
  try {
    if (typeof window === "undefined") return { ...DEFAULTS };
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<InkSettings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch: Partial<InkSettings>): InkSettings {
  const next = { ...loadSettings(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  return next;
}
