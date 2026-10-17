"use client";
// Кэш для мгновенного первого кадра. История и профиль приходят с сервера за
// секунду-две (история — с полными текстами), и пока они грузятся, сайдбар был бы
// пустым, а минуты/план — «…». Поэтому последнее известное состояние лежит в
// localStorage (по пользователю): страница рисует его сразу, а свежие данные тихо
// подменяют кэш. Хранится только лёгкий слепок списка (без текстов транскриптов).
import type { HistoryEntry } from "./db";
import type { Profile } from "./api";

const key = (uid: string) => `skriptly_cache_v1:${uid}`;

type Cached = { profile?: Profile | null; entries?: HistoryEntry[] };

function read(uid: string): Cached {
  try { return JSON.parse(localStorage.getItem(key(uid)) || "{}") as Cached; }
  catch { return {}; }
}

function write(uid: string, patch: Cached) {
  try { localStorage.setItem(key(uid), JSON.stringify({ ...read(uid), ...patch })); }
  catch { /* квота/приватный режим — кэш необязателен */ }
}

/** Слепок записи без текста: хватает для сайдбара; полный текст придёт с сервера. */
export function toStub(e: HistoryEntry): HistoryEntry {
  const durationSec = e.durationSec ?? (e.segments.length ? Math.max(...e.segments.map((s) => s.end)) : 0);
  return { ...e, segments: [], notes: "", aiResults: {}, speakerNames: {}, stub: true, durationSec };
}

export function loadCache(uid: string): { profile: Profile | null; entries: HistoryEntry[] } {
  const c = read(uid);
  return { profile: c.profile ?? null, entries: (c.entries ?? []).map((e) => ({ ...e, stub: true })) };
}

export function saveProfileCache(uid: string, profile: Profile | null) {
  if (profile) write(uid, { profile });
}

export function saveEntriesCache(uid: string, entries: HistoryEntry[]) {
  write(uid, { entries: entries.filter((e) => e.id !== "demo").slice(0, 200).map(toStub) });
}

export function clearCache(uid: string) {
  try { localStorage.removeItem(key(uid)); } catch { /* ignore */ }
}
