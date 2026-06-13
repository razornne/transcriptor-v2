-- Run in Supabase SQL Editor
-- Sprint 3: кастомні пресети генерації.
-- Додає JSONB-поле presets до user_profiles (особисті пресети)
-- та workspaces (командні пресети).
-- Структура пресету: {id, name, prompt, scope, created_by, updated_at}
-- Ліміт: ≤20 пресетів, prompt ≤2000 символів (enforced in app.py).

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS presets JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS presets JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN user_profiles.presets IS
  'Особисті кастомні пресети генерації. [{id, name, prompt, scope:"personal", created_by, updated_at}]. Ліміт 20, prompt ≤2000 символів.';

COMMENT ON COLUMN workspaces.presets IS
  'Командні кастомні пресети генерації (спільні для учасників). [{id, name, prompt, scope:"team", created_by, updated_at}]. Ліміт 20, prompt ≤2000 символів.';
