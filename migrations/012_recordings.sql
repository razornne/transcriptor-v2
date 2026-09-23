-- ============================================================
-- Migration 012: Recording archive index
-- Run in Supabase SQL Editor (project: bmonakhktbaliwgobrxv)
-- ============================================================
-- One row per transcribed recording/upload whose audio was copied to
-- Cloudflare R2 (bucket from R2_BUCKET) for error analysis. id = the
-- client's recording_id, same key as capture_stats.recording_id.
-- segments = RAW pipeline output (before any user edits), written by Flask
-- when the job finishes. Written/read only by the backend (service role):
-- RLS on, no policies.
-- Retention: R2 lifecycle rule deletes the audio after 90 days; expires_at
-- mirrors it so the admin list hides dead rows.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.recordings (
  id               UUID PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_email       TEXT,
  storage_key      TEXT NOT NULL,
  size_bytes       BIGINT,
  content_type     TEXT,
  source           TEXT CHECK (source IN ('record', 'upload')),
  duration_sec     NUMERIC,
  language         TEXT,
  num_speakers     INTEGER,
  quality          TEXT,
  job_id           TEXT,
  segments         JSONB,
  vocab_additions  JSONB,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT now() + interval '90 days'
);

CREATE INDEX IF NOT EXISTS idx_recordings_created ON public.recordings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recordings_job ON public.recordings(job_id);
CREATE INDEX IF NOT EXISTS idx_recordings_user ON public.recordings(user_id);

ALTER TABLE public.recordings ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.recordings IS
  'Archive index: audio in Cloudflare R2 (storage_key) + raw pipeline output, linked to capture_stats by id = recording_id. Backend-only (service role).';
