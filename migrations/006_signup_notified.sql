-- Run in Supabase SQL Editor
-- Flag to make Telegram signup notification fire-once per user.
-- user_profiles can be created by a Supabase trigger or by our backend's
-- first INSERT — we don't know which. This timestamp tracks whether
-- we've already pinged admin so we never double-notify.

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS signup_notified_at TIMESTAMPTZ;
