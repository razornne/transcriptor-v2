-- Run in Supabase SQL Editor
-- Privacy Mode toggle — when ON, the user's data never reaches Gemini/OpenAI:
--   • STT correction skips Gemini Flash, falls back to local Qwen 7B on Modal
--   • Summary / Action items skip Gemini Pro, run on LabGPTOSS20B on Modal L40S
--
-- Gated to Max + Team plans on the application side (column itself is just
-- a flag for everyone, but /api/profile only exposes the toggle to those plans).

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS privacy_mode BOOLEAN NOT NULL DEFAULT false;
