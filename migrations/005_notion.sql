-- Run in Supabase SQL Editor
-- Adds Notion integration tokens to user_profiles.
--
-- Notion OAuth gives us:
--   access_token         — bearer token for Notion API (long-lived, until user revokes)
--   bot_id               — Notion's internal id for "this user's grant of our integration"
--   workspace_id         — Notion workspace this token is scoped to
--   workspace_name       — display name shown in UI ("Mykyta's Notion")
--   workspace_icon       — emoji or image URL (optional, for nicer UI)
--   default_parent_id    — page id user picked as default destination
--                          (set lazily on first 'Send to Notion' if multiple pages granted)
--
-- Token is stored as-is. user_profiles already has RLS (only service role
-- reads via _sb_admin), so anon clients cannot read these fields.

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS notion_access_token      TEXT,
  ADD COLUMN IF NOT EXISTS notion_bot_id            TEXT,
  ADD COLUMN IF NOT EXISTS notion_workspace_id      TEXT,
  ADD COLUMN IF NOT EXISTS notion_workspace_name    TEXT,
  ADD COLUMN IF NOT EXISTS notion_workspace_icon    TEXT,
  ADD COLUMN IF NOT EXISTS notion_default_parent_id TEXT,
  ADD COLUMN IF NOT EXISTS notion_connected_at      TIMESTAMPTZ;
