# Star Reader — App Context

> This file did not previously exist in the repository. The Apex Armada handoff doc
> referenced it as prior art ("read that first for overall app architecture, KV
> model, and constraints"), but no such doc was checked in. This is a minimal seed
> covering what a build session needs going forward, not a reconstruction of history
> that predates it — extend it in place as the app grows.

## What this app is

A static site (GitHub Pages: `index.html`, `reading.html`, `spelling.html`,
`apex-armada.html`, `admin.html`) backed by one Cloudflare Worker (`worker.js`) and
one shared KV namespace (`TUTOR_KV`, prefix `reading:dustin:`). No build step, no
framework — plain HTML/CSS/JS per page, following the same visual conventions
(Baloo 2 font, starfield/theme-appropriate background, rounded glowing panels).

Three drills exist for Dustin:
- `reading.html` — say-the-word, scored via Azure Pronunciation Assessment (phoneme-level).
- `spelling.html` — hear-it-type-it, scored by exact string match.
- `apex-armada.html` — naval-vs-dino spelling minigame (added by this build).

## KV shape

- `reading:dustin:words:{word}` — per-word mastery. `{ reading: {attempts, correct,
  incorrect, avgLatencyMs, latencySamples, lastAttemptAt, lastTranscript,
  lastWordAccuracy}, spelling: {attempts, correct, lastAttemptAt} }`. Both the
  spelling drill and Apex Armada's cipher-breech input write into `spelling` (both
  are exact-match typed scoring — the game does not have its own mastery bucket).
- `reading:dustin:wordlist:{source}` — admin-loaded word list batches, pooled
  together by the session-words endpoints.
- `reading:dustin:sessions:{date}` — daily log of every attempt across drills,
  tagged by `drillType` ("sight-word", "spelling", or "game").
- `reading:dustin:game:{sessionId}` — **new in this build.** Apex Armada
  session-specific data, kept separate from mastery data per the project's KV split
  rule: `{ date, wordsUsed[], results[] ({word, correct, mode, attempts, latencyMs}),
  dispatchesShown[], duration, score }`. `score` and `duration` are cosmetic only —
  never shown to Dustin as a grade, never used for word selection.

## Word selection

`selectAdaptiveWords()` in `worker.js` is the single shared selection function —
mastery/spaced-repetition-aware, combining both `reading` and `spelling` attempt
history per word (accuracy → struggle weight, days-since-last-attempt → spaced
review weight, never-attempted words get a baseline weight). Both
`GET /api/sight-word/session-words` (feeds `reading.html` and `spelling.html`) and
`GET /api/game/session-words` (feeds Apex Armada) call it — there is one word pool
and one selection algorithm, not a separate one per interface. This replaced a prior
"bootstrap phase" pure-random sample.

## Apex Armada — feature notes

- Typed input only. Speech input was explicitly deferred in the handoff doc pending
  a fix to the sight-word drill's Azure webm/opus scoring bug — wire it in later via
  the same Azure Pronunciation Assessment path `reading.html` already uses.
- Dispatch briefings (`POST /api/game/dispatch`) are generated via the Claude API
  (`claude-haiku-4-5-20251001`) constrained to the current round's session word pool,
  and validated token-by-token against that pool before being shown — regenerated on
  failure, with a deterministic template fallback that's trivially always valid.
  **Requires the `ANTHROPIC_API_KEY` secret to be added to the Worker** (Cloudflare
  dashboard) for live generation; without it, the game silently uses the template
  fallback and still works end-to-end.
- No loss states, no visible timers, no scores-as-grades — same design wall as the
  rest of the app. `latencyMs` is tracked per attempt but never rendered client-side.
