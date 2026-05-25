-- Run in Supabase SQL Editor
-- Adds Team plan billing to workspaces.
-- Single Stripe subscription per workspace, quantity = number of seats
-- (invited + active members, including owner). Owner is always the
-- Stripe customer / payer.
--
-- "seats" reflects the current Stripe subscription quantity. Sources of
-- truth: Stripe is authoritative for billing, workspaces.seats is a
-- denormalized cache kept in sync via webhook.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS plan                    TEXT NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS stripe_customer_id      TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id  TEXT,
  ADD COLUMN IF NOT EXISTS seats                   INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS billing                 TEXT NOT NULL DEFAULT 'monthly';

-- Quick lookup of "what workspace owns this Stripe subscription" — used by
-- webhook to find which workspace to sync when subscription quantity changes
CREATE INDEX IF NOT EXISTS idx_workspaces_stripe_subscription_id
  ON public.workspaces (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
