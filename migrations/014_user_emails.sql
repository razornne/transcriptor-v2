-- ============================================================
-- Migration 014: email column next to user ids (for reading tables in the dashboard)
-- Run in Supabase SQL Editor (project: bmonakhktbaliwgobrxv)
-- ============================================================
-- Admin convenience only — the app never reads these columns.
--   user_profiles.user_email   (by id)
--   transcripts.user_email     (by user_id)
--   capture_stats.user_email   (by user_id)
--   workspaces.owner_email     (by owner_id)
-- recordings.user_email already exists (written by Flask), workspace_members.email too.
--
-- Filled by a BEFORE INSERT/UPDATE trigger from auth.users (clients can't
-- spoof it: whatever they send is overwritten), kept in sync when a user
-- changes email, backfilled at the end. Postgres appends new columns at the
-- end of the table — it can't place them right after user_id.
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS user_email  TEXT;
ALTER TABLE public.transcripts   ADD COLUMN IF NOT EXISTS user_email  TEXT;
ALTER TABLE public.capture_stats ADD COLUMN IF NOT EXISTS user_email  TEXT;
ALTER TABLE public.workspaces    ADD COLUMN IF NOT EXISTS owner_email TEXT;

-- Generic trigger: TG_ARGV[0] = id column, TG_ARGV[1] = email column.
CREATE OR REPLACE FUNCTION public.fill_user_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER            -- reads auth.users, which clients can't
SET search_path = ''
AS $$
DECLARE
  uid   uuid;
  email text;
BEGIN
  uid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  IF uid IS NOT NULL THEN
    SELECT u.email INTO email FROM auth.users u WHERE u.id = uid;
  END IF;
  NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[1], email));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_profiles_email ON public.user_profiles;
CREATE TRIGGER trg_user_profiles_email BEFORE INSERT OR UPDATE OF id, user_email ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.fill_user_email('id', 'user_email');

DROP TRIGGER IF EXISTS trg_transcripts_email ON public.transcripts;
CREATE TRIGGER trg_transcripts_email BEFORE INSERT OR UPDATE OF user_id, user_email ON public.transcripts
  FOR EACH ROW EXECUTE FUNCTION public.fill_user_email('user_id', 'user_email');

DROP TRIGGER IF EXISTS trg_capture_stats_email ON public.capture_stats;
CREATE TRIGGER trg_capture_stats_email BEFORE INSERT OR UPDATE OF user_id, user_email ON public.capture_stats
  FOR EACH ROW EXECUTE FUNCTION public.fill_user_email('user_id', 'user_email');

DROP TRIGGER IF EXISTS trg_workspaces_email ON public.workspaces;
CREATE TRIGGER trg_workspaces_email BEFORE INSERT OR UPDATE OF owner_id, owner_email ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.fill_user_email('owner_id', 'owner_email');

-- User changed their email → refresh the copies.
CREATE OR REPLACE FUNCTION public.sync_user_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.user_profiles SET user_email  = NEW.email WHERE id       = NEW.id;
  UPDATE public.transcripts   SET user_email  = NEW.email WHERE user_id  = NEW.id;
  UPDATE public.capture_stats SET user_email  = NEW.email WHERE user_id  = NEW.id;
  UPDATE public.workspaces    SET owner_email = NEW.email WHERE owner_id = NEW.id;
  UPDATE public.recordings    SET user_email  = NEW.email WHERE user_id  = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_user_email ON auth.users;
CREATE TRIGGER trg_sync_user_email AFTER UPDATE OF email ON auth.users
  FOR EACH ROW WHEN (OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION public.sync_user_email();

-- Backfill (writing user_email also fires the BEFORE trigger, which sets the same value).
UPDATE public.user_profiles t SET user_email  = u.email FROM auth.users u WHERE u.id = t.id       AND t.user_email  IS NULL;
UPDATE public.transcripts   t SET user_email  = u.email FROM auth.users u WHERE u.id = t.user_id  AND t.user_email  IS NULL;
UPDATE public.capture_stats t SET user_email  = u.email FROM auth.users u WHERE u.id = t.user_id  AND t.user_email  IS NULL;
UPDATE public.workspaces    t SET owner_email = u.email FROM auth.users u WHERE u.id = t.owner_id AND t.owner_email IS NULL;
UPDATE public.recordings    t SET user_email  = u.email FROM auth.users u WHERE u.id = t.user_id  AND t.user_email  IS NULL;
