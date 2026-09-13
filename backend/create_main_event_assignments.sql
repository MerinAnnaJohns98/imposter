-- ============================================================
-- Migration: create main_event_assignments
-- Run this in the Supabase SQL Editor.
-- Drop and recreate if the table already exists with old columns.
-- ============================================================

DROP TABLE IF EXISTS main_event_assignments;

CREATE TABLE main_event_assignments (
    id                SERIAL PRIMARY KEY,

    participant_id    INTEGER      NOT NULL UNIQUE
                                   REFERENCES participants(id)
                                   ON DELETE CASCADE,

    participant_name  TEXT         NOT NULL,
    original_team     TEXT         NOT NULL,
    shuffled_group    TEXT         NOT NULL,

    task_number       INTEGER      NOT NULL,
    task_title        TEXT         NOT NULL,
    task_description  TEXT         NOT NULL,

    -- slot within the shuffled group
    person_slot       INTEGER      NOT NULL,   -- 1/2/3 = specialist, 4 = imposter
    role_name         TEXT         NOT NULL,   -- e.g. "The Frame Maker", "The Imposter"
    work_description  TEXT         NOT NULL,   -- the participant's visible work instructions
    is_imposter       BOOLEAN      NOT NULL DEFAULT FALSE,

    -- submission
    github_repo       TEXT,
    submission_status TEXT         NOT NULL DEFAULT 'Pending',   -- 'Pending' | 'Submitted'
    submitted_at      TIMESTAMPTZ,
    ai_score          NUMERIC,

    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Fast lookup by participant_id (used by GET /api/my-assignment/:id)
CREATE INDEX IF NOT EXISTS idx_mea_participant_id
    ON main_event_assignments (participant_id);

-- ── Phase 1 migration: add ai_feedback column ──────────────────────────────
-- Safe to run multiple times (IF NOT EXISTS)
ALTER TABLE main_event_assignments
  ADD COLUMN IF NOT EXISTS ai_feedback TEXT;

-- ── Phase 2 migration: add individual score breakdown columns ─────────────
ALTER TABLE main_event_assignments
  ADD COLUMN IF NOT EXISTS ui_score           INTEGER,
  ADD COLUMN IF NOT EXISTS task_match_score   INTEGER,
  ADD COLUMN IF NOT EXISTS logic_score        INTEGER,
  ADD COLUMN IF NOT EXISTS creativity_score   INTEGER,
  ADD COLUMN IF NOT EXISTS code_quality_score INTEGER,
  ADD COLUMN IF NOT EXISTS evaluation_status  TEXT DEFAULT 'Pending';

-- Run this in Supabase SQL Editor before using Phase 2 evaluation.

-- ── Phase 2 migration: GitHub metadata columns ─────────────────────────────
ALTER TABLE main_event_assignments
  ADD COLUMN IF NOT EXISTS github_owner     TEXT,
  ADD COLUMN IF NOT EXISTS github_repo_name TEXT,
  ADD COLUMN IF NOT EXISTS github_branch    TEXT;

-- ── Phase 3 migration: individual scores + submission lock ─────────────────
ALTER TABLE main_event_assignments
  ADD COLUMN IF NOT EXISTS main_event_score  INTEGER  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fizzbuzz_score    INTEGER  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS submission_locked BOOLEAN  DEFAULT FALSE;

-- ── manual_event_scores table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manual_event_scores (
    id             SERIAL PRIMARY KEY,
    event_name     TEXT         NOT NULL,
    original_team  TEXT         NOT NULL,
    marks          INTEGER      NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE(event_name, original_team)
);

-- ══════════════════════════════════════════════════════════════════════════════
-- Phase 4 migration — Event Timers, FizzBuzz group submissions, scores
-- ══════════════════════════════════════════════════════════════════════════════

-- Event timer table — one row per event, managed by coordinator
CREATE TABLE IF NOT EXISTS event_timers (
    id            SERIAL PRIMARY KEY,
    event_name    TEXT        NOT NULL UNIQUE,  -- 'Main Event','FizzBuzz','Code Imposter','Sherlock Holmes'
    duration_secs INTEGER     NOT NULL,         -- total duration in seconds
    started_at    TIMESTAMPTZ,                  -- NULL = not started / paused
    paused_at     TIMESTAMPTZ,                  -- NULL = running
    elapsed_secs  INTEGER     NOT NULL DEFAULT 0, -- seconds already elapsed before last pause
    status        TEXT        NOT NULL DEFAULT 'idle', -- idle | running | paused | finished
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the four events (safe to re-run)
INSERT INTO event_timers (event_name, duration_secs, status)
VALUES
  ('Main Event',      2700, 'idle'),  -- 45 min
  ('FizzBuzz',         900, 'idle'),  -- 15 min
  ('Code Imposter',   1200, 'idle'),  -- 20 min
  ('Sherlock Holmes', 2700, 'idle')   -- 45 min
ON CONFLICT (event_name) DO NOTHING;

-- FizzBuzz group submissions — one row per shuffled group
CREATE TABLE IF NOT EXISTS fizzbuzz_submissions (
    id             SERIAL PRIMARY KEY,
    shuffled_group TEXT         NOT NULL UNIQUE,  -- e.g. 'Group 1'
    submitted_by   TEXT         NOT NULL,          -- participant_name who submitted
    participant_id TEXT         NOT NULL,          -- UUID of submitter
    fizz_output    TEXT         NOT NULL,
    submitted_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    is_correct     BOOLEAN,                        -- set after coordinator marks
    imposter_sabotaged BOOLEAN  NOT NULL DEFAULT FALSE
);

-- FizzBuzz score columns on main_event_assignments
ALTER TABLE main_event_assignments
  ADD COLUMN IF NOT EXISTS fizzbuzz_team_score   INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fizzbuzz_speed_bonus  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS imposter_bonus        INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fizzbuzz_locked       BOOLEAN DEFAULT FALSE;  -- locked after group submits

-- fizzbuzz_score = fizzbuzz_team_score + fizzbuzz_speed_bonus + imposter_bonus
-- (already exists from Phase 3)

-- ══════════════════════════════════════════════════════════════════════════════
-- Phase 5 migration — event_key-based timer schema + FizzBuzz patches
-- Run this in Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════════════════════

-- New event_timers with event_key TEXT PRIMARY KEY (replaces SERIAL-based one)
-- Safe: uses IF NOT EXISTS and ON CONFLICT
CREATE TABLE IF NOT EXISTS event_timers_v2 (
    event_key         TEXT         PRIMARY KEY,
    event_name        TEXT         NOT NULL,
    duration_minutes  INTEGER      NOT NULL,
    started_at        TIMESTAMPTZ,
    paused_at         TIMESTAMPTZ,
    remaining_seconds INTEGER      NOT NULL,
    status            TEXT         NOT NULL DEFAULT 'waiting'
);

INSERT INTO event_timers_v2 (event_key, event_name, duration_minutes, remaining_seconds, status) VALUES
  ('main_event',    'Main Event',      45, 2700, 'waiting'),
  ('fizzbuzz',      'FizzBuzz',        15,  900, 'waiting'),
  ('code_imposter', 'Code Imposter',   20, 1200, 'waiting'),
  ('sherlock',      'Sherlock Holmes', 45, 2700, 'waiting')
ON CONFLICT (event_key) DO NOTHING;

-- Patch main_event_assignments with any missing columns
ALTER TABLE main_event_assignments
  ADD COLUMN IF NOT EXISTS github_repo_url        TEXT,
  ADD COLUMN IF NOT EXISTS imposter_bonus         INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_individual_score INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fizzbuzz_completed     BOOLEAN DEFAULT FALSE;

-- FizzBuzz submissions with repo_url and speed_bonus (new schema)
CREATE TABLE IF NOT EXISTS fizzbuzz_submissions_v2 (
    shuffled_group  TEXT        PRIMARY KEY,
    submitted_by    TEXT        NOT NULL,
    participant_id  TEXT        NOT NULL,
    repo_url        TEXT,
    fizz_output     TEXT,
    submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status          TEXT        NOT NULL DEFAULT 'Submitted',
    is_correct      BOOLEAN,
    speed_bonus     INTEGER     DEFAULT 0,
    imposter_bonus  INTEGER     DEFAULT 0,
    imposter_sabotaged BOOLEAN  DEFAULT FALSE
);

-- Manual event scores per team (flat schema)
CREATE TABLE IF NOT EXISTS manual_event_scores_v2 (
    original_team  TEXT  PRIMARY KEY,
    code_imposter  INTEGER DEFAULT 0,
    sherlock       INTEGER DEFAULT 0,
    drawing        INTEGER DEFAULT 0,
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Phase 6: add language column to fizzbuzz_submissions_v2 ─────────────────
ALTER TABLE fizzbuzz_submissions_v2
  ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'Unknown';

-- ── Ensure manual_event_scores table exists with correct schema ───────────────
-- Run this if the table is missing or upsert fails
CREATE TABLE IF NOT EXISTS manual_event_scores (
    id             SERIAL PRIMARY KEY,
    event_name     TEXT         NOT NULL,
    original_team  TEXT         NOT NULL,
    marks          INTEGER      NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE(event_name, original_team)
);

-- If the table exists but upsert fails due to constraint name mismatch, run:
-- ALTER TABLE manual_event_scores DROP CONSTRAINT IF EXISTS manual_event_scores_event_name_original_team_key;
-- ALTER TABLE manual_event_scores ADD CONSTRAINT manual_event_scores_event_name_original_team_key UNIQUE (event_name, original_team);
