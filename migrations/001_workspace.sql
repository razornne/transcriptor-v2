-- ============================================================
-- Migration 001: Workspace collaboration
-- Run in Supabase SQL Editor (project: bmonakhktbaliwgobrxv)
-- ============================================================
-- Each user belongs to AT MOST ONE workspace (owner OR member).
-- No shared billing — each member has their own plan/limits.
-- Workspace is a collaboration layer: owner invites members,
-- transcripts can be shared workspace-wide per-item toggle.
-- ============================================================

-- 1. Workspaces -----------------------------------------------
CREATE TABLE IF NOT EXISTS public.workspaces (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  owner_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Workspace members ----------------------------------------
CREATE TABLE IF NOT EXISTS public.workspace_members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  status       TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active')),
  invited_by   UUID REFERENCES auth.users(id),
  invited_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  joined_at    TIMESTAMPTZ
);

-- 3. Extend transcripts ---------------------------------------
ALTER TABLE public.transcripts
  ADD COLUMN IF NOT EXISTS workspace_id UUID
    REFERENCES public.workspaces(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS visibility   TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'workspace'));

-- 4. Indexes --------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_workspace_members_user
  ON public.workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_email
  ON public.workspace_members(email);
CREATE INDEX IF NOT EXISTS idx_workspace_members_ws
  ON public.workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_workspace
  ON public.transcripts(workspace_id) WHERE workspace_id IS NOT NULL;

-- One active workspace per user (prevents double-membership)
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_members_one_per_user
  ON public.workspace_members(user_id)
  WHERE status = 'active' AND user_id IS NOT NULL;

-- 5. RLS ------------------------------------------------------
ALTER TABLE public.workspaces       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;

-- Owner: full access to own workspace
CREATE POLICY "workspaces_owner_all" ON public.workspaces
  FOR ALL USING (auth.uid() = owner_id);

-- Active members: can see their workspace
CREATE POLICY "workspaces_member_select" ON public.workspaces
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.workspace_members
      WHERE workspace_id = id
        AND user_id = auth.uid()
        AND status = 'active'
    )
  );

-- Owner can manage all members of their workspace
CREATE POLICY "wm_owner_all" ON public.workspace_members
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.workspaces
      WHERE id = workspace_id AND owner_id = auth.uid()
    )
  );

-- Members can see their own membership row
CREATE POLICY "wm_self_select" ON public.workspace_members
  FOR SELECT USING (user_id = auth.uid());

-- 6. Update transcripts SELECT policy ------------------------
-- Add workspace visibility on top of existing owner access.
DROP POLICY IF EXISTS "Users can only see own transcripts"  ON public.transcripts;
DROP POLICY IF EXISTS "transcripts_select"                  ON public.transcripts;

CREATE POLICY "transcripts_access" ON public.transcripts
  FOR SELECT USING (
    -- Own transcripts always visible
    user_id = auth.uid()
    OR (
      -- Shared transcripts visible to workspace members
      visibility = 'workspace'
      AND workspace_id IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM public.workspace_members
          WHERE workspace_id = public.transcripts.workspace_id
            AND user_id = auth.uid()
            AND status = 'active'
        )
        OR EXISTS (
          SELECT 1 FROM public.workspaces
          WHERE id = public.transcripts.workspace_id
            AND owner_id = auth.uid()
        )
      )
    )
  );

-- Ensure basic CRUD policies exist (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_policies
    WHERE tablename = 'transcripts'
      AND policyname = 'Users can insert own transcripts'
  ) THEN
    CREATE POLICY "Users can insert own transcripts" ON public.transcripts
      FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT FROM pg_policies
    WHERE tablename = 'transcripts'
      AND policyname = 'Users can update own transcripts'
  ) THEN
    CREATE POLICY "Users can update own transcripts" ON public.transcripts
      FOR UPDATE USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT FROM pg_policies
    WHERE tablename = 'transcripts'
      AND policyname = 'Users can delete own transcripts'
  ) THEN
    CREATE POLICY "Users can delete own transcripts" ON public.transcripts
      FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;
