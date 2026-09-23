-- ============================================================
-- Migration 013: correction diffs + channel mode in the recording archive
-- Run in Supabase SQL Editor (project: bmonakhktbaliwgobrxv)
-- ============================================================
-- corrections: every line the LLM correction pass changed —
--   [{start, speaker_before, speaker_after, before, after}, ...]
-- so wrong "fixes" (meaning changed) can be spotted on /app/review.
-- channel_mode: dual | left_only | right_only | mono (how the audio was processed).
-- Flask writes both when a transcription job finishes; until this migration
-- is applied it falls back to the 012 columns only.
-- ============================================================

ALTER TABLE public.recordings
  ADD COLUMN IF NOT EXISTS corrections  JSONB,
  ADD COLUMN IF NOT EXISTS channel_mode TEXT;
