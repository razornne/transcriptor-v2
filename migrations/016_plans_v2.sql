-- ============================================================
-- Migration 016: plans v2 — dictation quota, Team minutes pool, Max removed
-- Run in Supabase SQL Editor (project: bmonakhktbaliwgobrxv)
-- ============================================================
-- 1. Dictation gets its own monthly quota in seconds of speech (Free 1 h,
--    Pro/Team 10 h) instead of flowing into minutes_used (migration 015).
--    dictation_month marks which calendar month (UTC) the counter belongs
--    to; the RPC starts it from zero when a new month begins, and Flask
--    treats a counter from an older month as 0.
-- 2. Team minutes are a shared pool per workspace: 600 × seats a month.
--    Same month-stamp scheme as dictation.
-- 3. The Max plan is gone: existing Max profiles become Pro.
-- Flask needs this migration before the plans-v2 deploy: until then
-- dictation and Team usage are not recorded (logged, nothing breaks).
-- Safe to re-run.
-- ============================================================

-- ── 1. Dictation quota ──────────────────────────────────────────────────
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS dictation_seconds_month NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dictation_month         DATE;

-- Replaces the 015 version: seconds no longer move into minutes_used.
-- In an UPDATE every SET expression reads the OLD row, so this is atomic.
CREATE OR REPLACE FUNCTION public.add_dictation_seconds(p_user_id uuid, p_secs numeric)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.user_profiles SET
    dictation_seconds_month = CASE
        WHEN dictation_month = date_trunc('month', now() AT TIME ZONE 'utc')::date
        THEN dictation_seconds_month ELSE 0 END + p_secs,
    dictation_month         = date_trunc('month', now() AT TIME ZONE 'utc')::date,
    dictation_seconds_total = dictation_seconds_total + p_secs
  WHERE id = p_user_id;
$$;

REVOKE ALL ON FUNCTION public.add_dictation_seconds(uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_dictation_seconds(uuid, numeric) TO service_role;

-- ── 2. Team minutes pool ────────────────────────────────────────────────
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS minutes_used  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS minutes_month DATE;

CREATE OR REPLACE FUNCTION public.add_workspace_minutes(p_workspace_id uuid, p_mins integer)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.workspaces SET
    minutes_used  = CASE
        WHEN minutes_month = date_trunc('month', now() AT TIME ZONE 'utc')::date
        THEN minutes_used ELSE 0 END + p_mins,
    minutes_month = date_trunc('month', now() AT TIME ZONE 'utc')::date
  WHERE id = p_workspace_id;
$$;

REVOKE ALL ON FUNCTION public.add_workspace_minutes(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_workspace_minutes(uuid, integer) TO service_role;

-- ── 3. Max → Pro ────────────────────────────────────────────────────────
UPDATE public.user_profiles SET plan = 'pro' WHERE plan = 'max';
