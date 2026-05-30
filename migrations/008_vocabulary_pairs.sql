-- ============================================================
-- Migration 008: Vocabulary wrong→right correction pairs
-- Run in Supabase SQL Editor (project: bmonakhktbaliwgobrxv)
-- ============================================================
-- Расширяет формат элемента user_profiles.vocabulary (JSONB) — добавляется
-- опциональное поле `wrong` (исходная ошибочная форма из Gemini-правки).
-- Это позволяет хранить пару wrong→right и подавать её Gemini correction как
-- "known corrections" на будущих транскрипциях (а не только правую форму в
-- Whisper initial_prompt, как раньше).
--
-- DDL НЕ требуется — JSONB schemaless, старые элементы без `wrong` валидны и
-- продолжают работать (кормят Whisper prompt). Эта миграция только обновляет
-- COMMENT для документации. Безопасно перезапускать.
--
-- Новый формат элемента:
--   { "term": "по ЖК", "wrong": "пожика", "freq": 3, "lang": "uk",
--     "last_seen": "2026-05-30T..." }
--   ("wrong" опционально — отсутствует у ручных/старых терминов)
-- ============================================================

COMMENT ON COLUMN public.user_profiles.vocabulary IS
  'Auto-learned personal vocabulary. Array of {term, wrong?, freq, lang, last_seen}. '
  'Populated by Gemini corrections during transcription (wrong→right pairs). '
  'term (right form) → prepended to Whisper initial_prompt (top-30 by freq). '
  'wrong→right pairs → passed to Gemini correction as known corrections (top-20).';
