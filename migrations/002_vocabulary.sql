-- ============================================================
-- Migration 002: Personal vocabulary (auto-learned terminology)
-- Run in Supabase SQL Editor (project: bmonakhktbaliwgobrxv)
-- ============================================================
-- Стратегия: каждый раз когда Gemini correction исправляет слово на
-- что-то нетривиальное (аббревиатура, имя, технический термин) — мы
-- сохраняем эту пару в персональный словарь юзера. На следующей
-- транскрипции этот словарь прокидывается в initial_prompt Whisper'а,
-- чтобы он уже знал про твою специфическую лексику и распознавал её
-- с первого прохода (без необходимости в исправлениях Gemini).
--
-- Структура: JSONB-массив объектов в user_profiles.vocabulary
-- Формат каждого элемента:
--   { "term": "ADHD", "freq": 3, "lang": "uk", "last_seen": "2026-05-22T..." }
-- ============================================================

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS vocabulary JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.user_profiles.vocabulary IS
  'Auto-learned personal vocabulary. Array of {term, freq, lang, last_seen}. '
  'Populated by Gemini corrections during transcription. '
  'Top-N items get prepended to Whisper initial_prompt on next recording.';
