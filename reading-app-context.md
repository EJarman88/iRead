# Star Reader — App Context

> This file did not previously exist in the repository. The Apex Armada handoff doc
> that prompted this file referenced it as prior art ("read that first for overall
> app architecture, KV model, and constraints"), but no such doc was checked in.
> This is a minimal seed covering what a build session needs going forward, not a
> reconstruction of history that predates it — extend it in place as the app grows.
>
> One correction worth flagging: the Apex Armada handoff doc assumed Dustin's real
> word list was early-elementary (Dolch/Fry) and that grade 7-8+ vocabulary was "too
> hard." By the time this file was written, the opposite had been established and
> acted on — Dustin's actual level is 6th/7th grade (per TutorHub's curriculum), the
> Dolch/Fry lists were too easy, and they were replaced with `grade-6-7-vocabulary.txt`.
> Don't trust a doc's stated grade level over what's actually loaded in KV.

## What this app is

A static site (GitHub Pages: `index.html`, `reading.html`, `spelling.html`,
`word-helper.html`, `passage.html`, `apex-armada.html`, `admin.html`) backed by one
Cloudflare Worker (`worker.js`) and one shared KV namespace (`TUTOR_KV`, prefix
`reading:dustin:`). No build step, no framework — plain HTML/CSS/JS per page,
following the same visual conventions (Baloo 2 font, theme-appropriate background,
rounded glowing panels). The Worker is deployed by hand (paste into the Cloudflare
dashboard, or `wrangler deploy` with a locally-created `wrangler.toml` — none is
checked in); only the static site auto-deploys, via `.github/workflows/static.yml`
on push to `main`.

Five features exist for Dustin, all reachable from `index.html`:
- `reading.html` — say-the-word, scored via Azure Pronunciation Assessment (phoneme-level).
- `spelling.html` — hear-it-type-it, scored by exact string match.
- `word-helper.html` — photograph a stuck word, get a definition + syllable breakdown via Claude's vision API.
- `passage.html` — read a short passage aloud + answer a comprehension question.
- `apex-armada.html` — naval-vs-dino spelling minigame.

## KV shape

- `reading:dustin:words:{word}` — per-word mastery. `{ reading: {attempts, correct,
  incorrect, avgLatencyMs, latencySamples, lastAttemptAt, lastTranscript,
  lastWordAccuracy}, spelling: {attempts, correct, lastAttemptAt}, wordHelper?:
  {timesLookedUp, lastLookedUpAt} }`. The spelling drill and Apex Armada's
  cipher-breech input both write into `spelling` (both are exact-match typed
  scoring — the game does not have its own mastery bucket).
- `reading:dustin:passages:{passageId}` — `{ attempts, bestAccuracy, lastAccuracy,
  lastFluencyScore, lastCompletenessScore, lastAttemptAt }`.
- `reading:dustin:wordlist:{source}` — admin-loaded word list batches, pooled
  together by the session-words endpoints.
- `reading:dustin:sessions:{date}` — daily log of every attempt across features,
  tagged by `drillType` ("sight-word", "spelling", "word-helper", "passage", or "game").
- `reading:dustin:game:{sessionId}` — Apex Armada session-specific data, kept
  separate from mastery data: `{ date, wordsUsed[], results[] ({word, correct, mode,
  attempts, latencyMs}), dispatchesShown[], duration, score }`. `score` and
  `duration` are cosmetic only — never shown to Dustin as a grade, never used for
  word selection.

## Word selection

`computeWordWeight()` + `weightedSampleWithoutReplacement()` in `worker.js` are the
shared adaptive-selection primitives — never-attempted words get a fair baseline
weight, struggling words (low accuracy) weigh more, mastered words taper off but
never to zero. `computePassageWeight()` is the passage-side equivalent, keyed on
`bestAccuracy`. `GET /api/sight-word/session-words` (feeds `reading.html` and
`spelling.html`) and `GET /api/game/session-words` (feeds Apex Armada) both pool
`wordlist:*` via `getPooledWords()` and select via the same `selectAdaptiveWords()`
wrapper — one word pool, one weighting function, not a separate one per interface.

## Apex Armada — feature notes

- Typed input only. Speech input was explicitly deferred in the original handoff doc
  pending a fix to the sight-word drill's Azure webm/opus scoring bug — wire it in
  later via the same Azure Pronunciation Assessment path `reading.html` already uses.
- Dispatch briefings (`POST /api/game/dispatch`) are generated via the Claude API
  (`claude-haiku-4-5-20251001` — same model Word Helper's vision calls use, same
  `ANTHROPIC_API_KEY` secret) constrained to the current round's session word pool,
  and validated token-by-token against that pool before being shown — regenerated on
  failure, with a deterministic template fallback that's trivially always valid.
- No loss states, no visible timers, no scores-as-grades — same design wall as the
  rest of the app. `latencyMs` is tracked per attempt but never rendered client-side.
