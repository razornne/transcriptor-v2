-- Run in Supabase SQL Editor
-- Adds referral system to user_profiles:
--   - referral_code: short unique code, shared in invite links (?ref=CODE)
--   - referred_by:   user_id of inviter (set once at signup, immutable)
--   - bonus_minutes: minutes awarded via referrals — survive monthly reset,
--                    added on top of plan limit when checking usage

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS referral_code  TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS referred_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bonus_minutes  INTEGER NOT NULL DEFAULT 0;

-- Index on referral_code for fast lookup when a new user signs up
-- with ?ref=CODE — we resolve the inviter's user_id
CREATE INDEX IF NOT EXISTS idx_user_profiles_referral_code
  ON public.user_profiles (referral_code);

-- Note: bonus_minutes is INTEGER (whole minutes). Usage tracking uses
-- floats for sub-minute precision, but the bonus comes from human-facing
-- rewards (always whole numbers like +60).
