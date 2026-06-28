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

export type VocabTerm = {
  term: string;
  wrong?: string;
  freq: number;
  lang?: string;
  last_seen?: string;
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
  notion_workspace_name?: string | null;
  presets?: Preset[];
  team_presets?: Preset[];
  vocabulary?: VocabTerm[];
};

// ── Projects (client-side, localStorage) ─────────────────────
// No migration needed — stored purely on-device. Entry IDs reference
// Supabase transcript rows; membership is stored in the project's entryIds[].
export type Project = {
  id: string;
  name: string;
  entryIds: string[];
  createdAt: string;
};

const PROJECTS_LS_KEY = "skriptly_projects_v1";

export function loadProjects(): Project[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(PROJECTS_LS_KEY);
    return raw ? (JSON.parse(raw) as Project[]) : [];
  } catch { return []; }
}

export function saveProjects(projects: Project[]): void {
  try { localStorage.setItem(PROJECTS_LS_KEY, JSON.stringify(projects)); } catch {}
}

// Thrown when the Stripe Customer Portal can't open because the stored customer
// id is invalid for the active Stripe mode (e.g. a test cus_ under a live key).
// The backend has already wiped the bad id; the caller should restart Checkout.
export class StripeCustomerInvalidError extends Error {
  constructor(msg: string) { super(msg); this.name = "StripeCustomerInvalidError"; }
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

export type PipelineStepStatus = "pending" | "running" | "completed" | "failed";
export type PipelineStep = {
  status: PipelineStepStatus;
  duration_sec?: number;   // честное итоговое время (completed/failed)
  elapsed_sec?: number;    // серверный снимок живого времени (running)
  started_ts?: number;     // epoch начала шага (для клиентской интерполяции)
};
export type PipelineSteps = Record<string, PipelineStep>;

export type JobProgress = {
  stage?: string;
  chunks_total?: number;
  chunks_done?: number;
  chunks_failed?: number;
  pipeline_steps?: PipelineSteps;
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

// Files above this threshold are uploaded to Supabase Storage first so that
// the raw bytes never pass through Modal's ~250MB request body limit (ISS-11).
const LARGE_FILE_THRESHOLD = 200 * 1024 * 1024; // 200 MB

// Detect a reasonable file extension from a Blob's MIME type.
function _blobExt(blob: Blob): string {
  const type = blob.type || "";
  const map: Record<string, string> = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-msvideo": "avi",
    "video/x-matroska": "mkv",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
    "audio/aac": "aac",
  };
  for (const [mime, ext] of Object.entries(map)) {
    if (type.startsWith(mime)) return ext;
  }
  return "bin";
}

// Large-file path: upload to Supabase Storage, pass signed URL to backend.
// Requires bucket 'audio-uploads' in Supabase Storage (create in dashboard:
// Storage → New bucket, private).
async function transcribeLarge(
  blob: Blob,
  o: { language: string; numSpeakers: string; durationSec: number; prompt?: string; quality?: "best" },
  onProgress?: (p: JobProgress) => void,
  cancel?: CancelToken,
): Promise<Segment[]> {
  const { data: { user } } = await sb.auth.getUser();
  if (!user?.id) throw new Error("Not authenticated — cannot upload large file.");

  const ext = _blobExt(blob);
  const path = `${user.id}/${crypto.randomUUID()}.${ext}`;

  // 1. Upload to Supabase Storage
  const { error: uploadError } = await sb.storage
    .from("audio-uploads")
    .upload(path, blob, { contentType: blob.type || "application/octet-stream", upsert: false });
  if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

  let storagePath = path; // keep for cleanup in finally
  try {
    // 2. Create signed URL (1 hour — generous for any processing time)
    const { data: signedData, error: signError } = await sb.storage
      .from("audio-uploads")
      .createSignedUrl(path, 3600);
    if (signError || !signedData?.signedUrl) {
      throw new Error(`Failed to create signed URL: ${signError?.message ?? "unknown"}`);
    }

    // 3. Build FormData with storage_url instead of raw audio bytes
    const fd = new FormData();
    fd.append("storage_url", signedData.signedUrl);
    if (o.language) fd.append("language", o.language);
    if (o.numSpeakers) fd.append("num_speakers", o.numSpeakers);
    if (o.durationSec) fd.append("duration_sec", String(Math.round(o.durationSec)));
    if (o.prompt && o.prompt.trim()) fd.append("prompt", o.prompt.trim());
    if (o.quality === "best") fd.append("quality", "best");

    // 4. Submit job and poll as normal
    const jobId = await submitJob(`${API_BASE}/api/transcribe`, fd);
    const maxWait = o.durationSec > 1800 ? 120 * 60 * 1000 : 22 * 60 * 1000;
    const result = await pollJob(jobId, onProgress, maxWait, cancel);
    return (result.segments as Segment[]) || [];
  } finally {
    // 5. Always clean up the storage file (best-effort)
    try {
      await sb.storage.from("audio-uploads").remove([storagePath]);
    } catch { /* best-effort — file will expire naturally */ }
  }
}

export async function transcribe(
  blob: Blob,
  o: { language: string; numSpeakers: string; durationSec: number; prompt?: string; quality?: "best" },
  onProgress?: (p: JobProgress) => void,
  cancel?: CancelToken,
): Promise<Segment[]> {
  // Route large files through Supabase Storage to bypass Modal's body size limit
  if (blob.size > LARGE_FILE_THRESHOLD) {
    return transcribeLarge(blob, o, onProgress, cancel);
  }

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

export async function saveVocabulary(vocabulary: VocabTerm[]): Promise<void> {
  const res = await authFetch(`${API_BASE}/api/vocabulary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vocabulary }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
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

// ── Workspace API ─────────────────────────────────────────────

export type WorkspaceMember = {
  id: string;
  email: string;
  role: "owner" | "member";
  status: "active" | "invited";
};

export type WorkspaceInfo = {
  id: string;
  name: string;
  plan: string;
  seats: number;
  role: "owner" | "member";
  members: WorkspaceMember[];
};

export async function fetchWorkspace(): Promise<WorkspaceInfo | null> {
  try {
    const res = await authFetch(`${API_BASE}/api/workspace`);
    if (res.status === 404 || !res.ok) return null;
    return (await res.json()) as WorkspaceInfo;
  } catch {
    return null;
  }
}

export async function createWorkspace(name: string): Promise<WorkspaceInfo> {
  const res = await authFetch(`${API_BASE}/api/workspace`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => null) as { error?: string } | null;
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error || `HTTP ${res.status}`);
  return data as unknown as WorkspaceInfo;
}

export async function inviteMember(email: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/api/workspace/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const data = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
}

export async function removeMember(memberId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/api/workspace/members/${encodeURIComponent(memberId)}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
}

export async function leaveWorkspace(): Promise<void> {
  const res = await authFetch(`${API_BASE}/api/workspace/leave`, { method: "POST" });
  const data = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
}

// ── Billing ───────────────────────────────────────────────────

// Upgrade flow — creates a NEW subscription via Stripe Checkout.
// plan "team" is the engineered-upsell path: the user has no workspace yet, types
// a name, and we pass it as `pending_workspace_name`. Stripe's webhook reads it on
// checkout.session.completed and auto-creates the workspace right after payment.
export async function createStripeCheckout(
  plan: "pro" | "max" | "team",
  billing: "monthly" | "annual" = "monthly",
  pendingWorkspaceName?: string,
): Promise<string> {
  const body: Record<string, unknown> = { plan, billing };
  const wsName = (pendingWorkspaceName || "").trim();
  if (wsName) body.pending_workspace_name = wsName;
  const res = await authFetch(`${API_BASE}/api/stripe/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null) as { url?: string; error?: string } | null;
  if (!res.ok || !data?.url) throw new Error(data?.error || `HTTP ${res.status}`);
  return data.url;
}

// Downgrade / manage flow — opens the Stripe Customer Portal for the existing
// subscription. The customer id is resolved server-side from user_profiles, so we
// don't pass it from the client (avoids trusting a spoofable field). On any failure
// this throws a clean Error so the caller can surface a toast and reset its loader —
// never leaving the Settings UI stuck in a perpetual loading state.
export async function createStripePortal(): Promise<string> {
  let res: Response;
  try {
    res = await authFetch(`${API_BASE}/api/stripe/portal`, { method: "POST" });
  } catch {
    throw new Error("Network error — could not reach billing. Please try again.");
  }
  const data = await res.json().catch(() => null) as { url?: string; error?: string; message?: string } | null;
  // Stale/mismatched customer — backend wiped the bad id; signal the caller to
  // restart Checkout instead of dead-ending on the portal.
  if (res.status === 400 && data?.error === "invalid_customer") {
    throw new StripeCustomerInvalidError(data.message || "Stripe ID mismatched. Please clear checkout again.");
  }
  if (!res.ok || !data?.url) {
    throw new Error(data?.error || `Could not open billing portal (HTTP ${res.status})`);
  }
  return data.url;
}

export async function deleteAccount(): Promise<void> {
  const res = await authFetch(`${API_BASE}/api/profile`, { method: "DELETE" });
  const data = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
}

// ── Notion integration ────────────────────────────────────────
// Returns the Notion OAuth authorize URL; caller redirects the browser to it.
export async function notionOAuthStart(): Promise<string> {
  const res = await authFetch(`${API_BASE}/api/notion/oauth/start`);
  const data = await res.json().catch(() => null) as { url?: string; error?: string } | null;
  if (!res.ok || !data?.url) throw new Error(data?.error || `HTTP ${res.status}`);
  return data.url;
}

// Clears the stored Notion tokens for the current user.
export async function notionDisconnect(): Promise<void> {
  const res = await authFetch(`${API_BASE}/api/notion/disconnect`, { method: "POST" });
  const data = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
}

// ── Speaker rename ────────────────────────────────────────────
// Global, persisted rename of a speaker within one entry. `oldLabel` is the raw
// diarization key (e.g. "SPEAKER_01"); empty newName reverts to the default.
export async function renameSpeaker(entryId: string, oldLabel: string, newName: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/api/entries/${encodeURIComponent(entryId)}/rename-speaker`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ old_name: oldLabel, new_name: newName }),
  });
  const data = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
}
