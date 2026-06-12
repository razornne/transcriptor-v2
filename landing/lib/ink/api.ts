"use client";
import { API_BASE } from "./config";
import { sb } from "./supabase";
import type { Segment } from "./db";

// Тонкий клиент к Flask-бэку на Modal. Контракты 1-в-1 со старым /app:
//   POST /api/transcribe (FormData) -> {job_id}
//   GET  /api/jobs/<id>             -> {status, ...progress | segments | result}
//   POST /api/generate              -> {job_id}
//   POST /api/title                 -> {title}
//   GET  /api/profile               -> план/лимиты/usage

export class UpgradeRequiredError extends Error {
  constructor(msg: string) { super(msg); this.name = "UpgradeRequiredError"; }
}

async function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const { data } = await sb.auth.getSession();
  const headers = new Headers(opts.headers || {});
  if (data.session?.access_token) {
    headers.set("Authorization", "Bearer " + data.session.access_token);
  }
  return fetch(url, { ...opts, headers });
}

async function submitJob(url: string, body: FormData | object): Promise<string> {
  const isForm = body instanceof FormData;
  const res = await authFetch(url, {
    method: "POST",
    headers: isForm ? {} : { "Content-Type": "application/json" },
    body: isForm ? body : JSON.stringify(body),
  });
  // 402 проверяем ДО парсинга тела (паттерн из старого app: нестандартное
  // тело от прокси роняло json() и upgrade-промпт терялся)
  if (res.status === 402) throw new UpgradeRequiredError("upgrade required");
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.job_id) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data.job_id as string;
}

export type JobProgress = {
  stage?: string;
  chunks_total?: number;
  chunks_done?: number;
  chunks_failed?: number;
};

export async function pollJob(
  jobId: string,
  onProgress?: (p: JobProgress) => void,
  maxWaitMs = 22 * 60 * 1000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const res = await authFetch(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}`);
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !data) throw new Error((data as { error?: string })?.error || `HTTP ${res.status}`);
    if (data.status === "done") return data;
    if (data.status === "error") throw new Error((data.error as string) || "processing failed");
    onProgress?.(data as JobProgress);
    if (Date.now() > deadline) throw new Error("timeout while processing");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function transcribe(
  blob: Blob,
  o: { language: string; numSpeakers: string; durationSec: number; quality?: "best" },
  onProgress?: (p: JobProgress) => void,
): Promise<Segment[]> {
  const fd = new FormData();
  fd.append("audio", blob, "recording.webm");
  if (o.language) fd.append("language", o.language);
  if (o.numSpeakers) fd.append("num_speakers", o.numSpeakers);
  if (o.durationSec) fd.append("duration_sec", String(Math.round(o.durationSec)));
  if (o.quality === "best") fd.append("quality", "best");
  const jobId = await submitJob(`${API_BASE}/api/transcribe`, fd);
  const maxWait = o.durationSec > 1800 ? 120 * 60 * 1000 : 22 * 60 * 1000;
  const result = await pollJob(jobId, onProgress, maxWait);
  return (result.segments as Segment[]) || [];
}

export async function generate(
  segments: Segment[],
  speakerNames: Record<string, string>,
  template: "summary" | "actions",
  language: string,
  detail?: string,
  focus?: string,
): Promise<string> {
  const jobId = await submitJob(`${API_BASE}/api/generate`, {
    segments, speakerNames, template,
    language: language || null,
    detail: detail || "medium",
    focus: focus || "",
  });
  const result = await pollJob(jobId);
  return ((result.result as string) || "").trim();
}

export async function generateTitle(text: string, language: string): Promise<string | null> {
  try {
    const res = await authFetch(`${API_BASE}/api/title`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 12000), language: language || null }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.title as string) || null;
  } catch {
    return null;
  }
}

export type Profile = {
  plan: string;
  minutes_used: number;
  minutes_limit: number;
  is_admin?: boolean;
};

export async function fetchProfile(): Promise<Profile | null> {
  try {
    const res = await authFetch(`${API_BASE}/api/profile`);
    if (!res.ok) return null;
    return (await res.json()) as Profile;
  } catch {
    return null;
  }
}
