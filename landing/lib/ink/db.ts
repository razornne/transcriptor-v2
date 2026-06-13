"use client";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";
import { sb } from "./supabase";

// История транскриптов — Supabase Postgres через RAW REST (НЕ PostgrestClient,
// он зависает — см. CLAUDE.md). Контракт колонок 1-в-1 со старым /app.

export type Segment = { speaker: string; start: number; end: number; text: string; edited?: boolean };

export type HistoryEntry = {
  id: string;
  userId: string;
  date: string;
  lang: string;
  segments: Segment[];
  speakerNames: Record<string, string>;
  title: string | null;
  titleIsAuto: boolean;
  notes: string;
  aiResults: Record<string, string>;
  workspaceId: string | null;
  visibility: string;
};

function rowToEntry(row: Record<string, unknown>): HistoryEntry {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    date: row.created_at as string,
    lang: (row.language as string) || "auto",
    segments: (row.segments as Segment[]) || [],
    speakerNames: (row.speaker_names as Record<string, string>) || {},
    title: (row.title as string) ?? null,
    titleIsAuto: Boolean(row.title_is_auto),
    notes: (row.notes as string) || "",
    aiResults: (row.ai_results as Record<string, string>) || {},
    workspaceId: (row.workspace_id as string) || null,
    visibility: (row.visibility as string) || "private",
  };
}

async function sbFetch(path: string, opts: RequestInit = {}): Promise<unknown> {
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token || SUPABASE_ANON_KEY;
  const headers = new Headers(opts.headers || {});
  headers.set("apikey", SUPABASE_ANON_KEY);
  headers.set("Authorization", "Bearer " + token);
  if (opts.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if ((opts.method === "POST" || opts.method === "PATCH") && !headers.has("Prefer")) {
    headers.set("Prefer", "return=representation");
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { ...opts, headers });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const p = parsed as { message?: string; error?: string } | null;
    throw new Error(`${opts.method || "GET"} ${path} -> ${res.status}: ${p?.message || p?.error || text}`);
  }
  return parsed;
}

export async function fetchHistory(): Promise<HistoryEntry[]> {
  const data = (await sbFetch("/transcripts?select=*&order=created_at.desc&limit=200")) as
    | Record<string, unknown>[]
    | null;
  return (data || []).map(rowToEntry);
}

export async function insertEntry(payload: {
  user_id: string;
  title: string | null;
  title_is_auto: boolean;
  language: string | null;
  segments: Segment[];
  speaker_names: Record<string, string>;
  notes: string;
  ai_results: Record<string, string>;
}): Promise<HistoryEntry | null> {
  const data = await sbFetch("/transcripts", { method: "POST", body: JSON.stringify(payload) });
  const row = Array.isArray(data) ? data[0] : data;
  return row && (row as { id?: string }).id ? rowToEntry(row as Record<string, unknown>) : null;
}

export async function patchEntry(id: string, fields: Record<string, unknown>): Promise<void> {
  await sbFetch(`/transcripts?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
}

export async function deleteEntry(id: string): Promise<void> {
  await sbFetch(`/transcripts?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}
