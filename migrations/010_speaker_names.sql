-- ============================================================
-- Migration 010: Add speaker_names to transcripts
-- Run in Supabase SQL Editor (project: bmonakhktbaliwgobrxv)
-- ============================================================
-- speaker_names stores a map of raw diarization label → display name,
-- e.g. {"SPEAKER_00": "Alice", "SPEAKER_01": "Bob"}.
-- Empty map = use default "Speaker N" labels.
-- The rename_speaker endpoint in app.py reads and writes this column.
-- Defaults to empty JSONB object so existing rows are unaffected.
-- ============================================================

ALTER TABLE public.transcripts
  ADD COLUMN IF NOT EXISTS speaker_names JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.transcripts.speaker_names IS
  'Map of raw diarization label to user-assigned display name. e.g. {"SPEAKER_00": "Alice"}. Empty map = use default "Speaker N" labels.';
