"use client";
import { API_BASE } from "./config";
import { sb } from "./supabase";
import type { Segment } from "./db";

// Тонкий клиент к Flask-бэку на Modal.
// Спринт 3: Preset / Profile.privacy_mode / setPrivacyMode / savePresets / generateCustom.

export class UpgradeRequiredError extends Error {
  constructor(msg: string) { super(msg); this.name = "UpgradeRequiredError"; }
}

export class CancelledError extends Error {
  constructor() { super("cancelled by user"); this.name = "CancelledError"; }
}

export type CancelToken = { cancelled: boolean; jobId: string | null };

export type Preset = {
  id: string;
  name: string;
  prompt: string;
  scope: "personal" | "team";
  created_by?: string;
  updated_at?: string;
};

export type Profile = {
  plan: string;
  minutes_used: number;
  minutes_limit: number;
  minutes_limit_base?: number;
  bonus_minutes?: number;
  referral_code?: string;
  privacy_mode?: boolean;
  privacy_mode_available?: boolean;
  is_admin?: boolean;
  notion_connected?: boolean;
  presets?: Preset[];
  team_presets?: Preset[];
};

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
  // 402 ДО json() — нестандартное тело от прокси роняет json() и upgrade-промпт теряется
  if (res.status === 402) throw new UpgradeRequiredError("upgrade required");
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.job_id) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data.job_id as string;
}

export async function cancelJob(jobId: string): Promise<void> {
  try {
    await authFetch(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
  } catch { /* best-effort */ }
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
  cancel?: CancelToken,
): Promise<Record<string, unknown>> {
  if (cancel) cancel.jobId = jobId;
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    if (cancel?.cancelled) throw new CancelledError();
    const res = await authFetch(`${API_BASE}/api/jobs/${encodeURIComponent(jobId)}`);
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !data) throw new Error((data as { error?: string })?.error || `HTTP ${res.status}`);
    if (data.status === "done") return data;
    if (data.status === "cancelled") throw new CancelledError();
    if (data.status === "error") throw new Error((data.error as string) || "processing failed");
    onProgress?.(data as JobProgress);
    if (Date.now() > deadline) throw new Error("timeout while processing");
    // прерываемое ожидание 2с — Cancel реагирует мгновенно
    for (let i = 0; i < 20; i++) {
      if (cancel?.cancelled) throw new CancelledError();
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

export async function transcribe(
  blob: Blob,
  o: { language: string; numSpeakers: string; durationSec: number; prompt?: string; quality?: "best" },
  onProgress?: (p: JobProgress) => void,
  cancel?: CancelToken,
): Promise<Segment[]> {
  const fd = new FormData();
  fd.append("audio", blob, "recording.webm");
  if (o.language) fd.append("language", o.language);
  if (o.numSpeakers) fd.append("num_speakers", o.numSpeakers);
  if (o.durationSec) fd.append("duration_sec", String(Math.round(o.durationSec)));
  if (o.prompt && o.prompt.trim()) fd.append("prompt", o.prompt.trim());
  if (o.quality === "best") fd.append("quality", "best");
  const jobId = await submitJob(`${API_BASE}/api/transcribe`, fd);
  const maxWait = o.durationSec > 1800 ? 120 * 60 * 1000 : 22 * 60 * 1000;
  const result = await pollJob(jobId, onProgress, maxWait, cancel);
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

export async function generateCustom(
  segments: Segment[],
  speakerNames: Record<string, string>,
  presetId: string,
  language: string,
): Promise<string> {
  const jobId = await submitJob(`${API_BASE}/api/generate`, {
    segments, speakerNames,
    template: "custom",
    preset_id: presetId,
    language: language || null,
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

export async function fetchProfile(): Promise<Profile | null> {
  try {
    const res = await authFetch(`${API_BASE}/api/profile`);
    if (!res.ok) return null;
    return (await res.json()) as Profile;
  } catch {
    return null;
  }
}

// Optimistic toggle — бэк гейтит по плану (402 для Free/Pro)
export async function setPrivacyMode(enabled: boolean): Promise<void> {
  const res = await authFetch(`${API_BASE}/api/profile/privacy-mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const data = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) {
    if (res.status === 402) throw new UpgradeRequiredError("upgrade required");
    throw new Error(data.error || `HTTP ${res.status}`);
  }
}

// Замена всего массива личных пресетов (mirror /api/vocabulary pattern)
export async function savePresets(presets: Preset[]): Promise<Preset[]> {
  const res = await authFetch(`${API_BASE}/api/presets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ presets }),
  });
  const data = await res.json().catch(() => null) as { presets?: Preset[]; error?: string } | null;
  if (!res.ok || !data) throw new Error(data?.error || `HTTP ${res.status}`);
  return data.presets || [];
}

export async function sendToNotion(
  title: string,
  transcriptText: string,
  summary?: string,
  actions?: string,
): Promise<void> {
  const res = await authFetch(`${API_BASE}/api/notion/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, transcript_text: transcriptText, summary, actions }),
  });
  const data = await res.json().catch(() => null) as { error?: string } | null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
}

// Замена всего массива командных пресетов (только для owner)
export async function saveTeamPresets(presets: Preset[]): Promise<Preset[]> {
  const res = await authFetch(`${API_BASE}/api/workspace/presets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ presets }),
  });
  const data = await res.json().catch(() => null) as { presets?: Preset[]; error?: string } | null;
  if (!res.ok || !data) throw new Error(data?.error || `HTTP ${res.status}`);
  return data.presets || [];
}
