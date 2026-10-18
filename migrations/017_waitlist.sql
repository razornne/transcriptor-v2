-- ============================================================
-- Migration 017: waiting list (Mac app, later other platforms)
-- Run in Supabase SQL Editor (project: bmonakhktbaliwgobrxv)
-- ============================================================
-- One row per (email, platform). Written only by the backend with the
-- service role (POST /api/waitlist is public, so the server validates and
-- rate-limits it): RLS is on and there are no policies. Every signup is
-- also sent to the admin Telegram chat, so nothing is lost before this
-- migration is applied.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.waitlist (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  platform    TEXT NOT NULL DEFAULT 'macos',
  lang        TEXT,
  source      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email, platform)
);

ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.waitlist IS 'Waiting list signups (landing form). Service role only.';
