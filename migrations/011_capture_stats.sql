-- ============================================================
-- Migration 011: Capture telemetry
-- Run in Supabase SQL Editor (project: bmonakhktbaliwgobrxv)
-- ============================================================
-- Per-recording capture diagnostics — enough to answer "was there a second
-- channel, did it go silent, did the mic drop or switch" for any complaint.
-- Written client-side from landing/lib/ink/audio.ts right after a recording
-- stops (insertCaptureStats in lib/ink/db.ts). recording_id links the row to
-- the stored audio of the same call.
-- events: [{t, type: mic_switch|mic_lost|system_audio_ended|system_audio_silent, ...}]
-- ============================================================

CREATE TABLE IF NOT EXISTS public.capture_stats (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recording_id          UUID,
  session_id            TEXT,
  has_system_audio      BOOLEAN NOT NULL DEFAULT false,
  mic_device_label      TEXT,
  rms_mic_avg           NUMERIC,
  rms_system_avg        NUMERIC,
  silent_seconds_mic    NUMERIC,
  silent_seconds_system NUMERIC,
  track_ended_events    INTEGER NOT NULL DEFAULT 0,
  duration_sec          NUMERIC,
  browser               TEXT,
  os                    TEXT,
  display_surface       TEXT,
  events                JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_stats_recording
  ON public.capture_stats(recording_id) WHERE recording_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_capture_stats_user
  ON public.capture_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_capture_stats_created
  ON public.capture_stats(created_at);

ALTER TABLE public.capture_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "capture_stats_owner_select" ON public.capture_stats;
CREATE POLICY "capture_stats_owner_select" ON public.capture_stats
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "capture_stats_owner_insert" ON public.capture_stats;
CREATE POLICY "capture_stats_owner_insert" ON public.capture_stats
  FOR INSERT WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.capture_stats IS
  'Per-recording capture diagnostics (levels, silence, dropped/switched devices, whether call audio was present). Linked to stored audio by recording_id.';
