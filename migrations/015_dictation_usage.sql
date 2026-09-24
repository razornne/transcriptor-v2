-- ============================================================
-- Migration 015: dictation usage (Windows app) in the shared minutes limit
-- Run in Supabase SQL Editor (project: bmonakhktbaliwgobrxv)
-- ============================================================
-- Dictations are seconds long; add_minutes rounds each call up to a whole
-- minute, which would bill a 10-second dictation as 1 minute. Seconds are
-- accumulated in dictation_seconds_pending and every full 60 s moves into
-- minutes_used (the same counter recordings use).
-- dictation_seconds_total — lifetime total, for usage/cost metrics.
-- Called by Flask POST /api/dictation/usage (service role only).
-- Until this migration is applied, dictation works but isn't billed.
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS dictation_seconds_pending NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dictation_seconds_total   NUMERIC NOT NULL DEFAULT 0;

-- In an UPDATE every SET expression reads the OLD row, so this is atomic.
CREATE OR REPLACE FUNCTION public.add_dictation_seconds(p_user_id uuid, p_secs numeric)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.user_profiles SET
    minutes_used              = coalesce(minutes_used, 0) + floor((dictation_seconds_pending + p_secs) / 60)::int,
    dictation_seconds_pending = mod(dictation_seconds_pending + p_secs, 60),
    dictation_seconds_total   = dictation_seconds_total + p_secs
  WHERE id = p_user_id;
$$;

REVOKE ALL ON FUNCTION public.add_dictation_seconds(uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_dictation_seconds(uuid, numeric) TO service_role;
