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
`word-helper.html`, `passage.html`, `apex-armada.html`, `screener.html`,
`admin.html`) backed by one Cloudflare Worker (`worker.js`) and one shared KV
namespace (`TUTOR_KV`, prefix `reading:dustin:`). No build step, no framework —
plain HTML/CSS/JS per page, following the same visual conventions (Baloo 2 font,
theme-appropriate background, rounded glowing panels) — except `screener.html` and
`admin.html`, which are deliberately calmer/plainer (see below). The static site
auto-deploys via `.github/workflows/static.yml` on push to `main`. The Worker's
deploy story is in flux: `wrangler.jsonc` (checked in) targets Cloudflare Workers
Builds' Git integration, which auto-deploys `worker.js` on push IF that integration
has actually been connected on the Cloudflare dashboard side — the file alone
doesn't guarantee it's live. Confirm which is true before assuming a merge to
`main` alone puts new Worker code in production; the safe fallback is still a
manual paste into the dashboard.

Five drills exist for Dustin, all reachable from `index.html`:
- `reading.html` — say-the-word, scored via Azure Pronunciation Assessment (phoneme-level).
- `spelling.html` — hear-it-type-it, scored by exact string match.
- `word-helper.html` — photograph a stuck word, get a definition + syllable breakdown via Claude's vision API.
- `passage.html` — read a short passage aloud + answer a comprehension question.
- `apex-armada.html` — naval-vs-dino spelling minigame.

Plus one non-drill tool, linked from `index.html` via a deliberately quieter
secondary link (not a drill-picker button):
- `screener.html` ("Sound Check") — a phonemic awareness screener (rhyme judgment,
  first/last sound isolation, blending, segmentation). Built while Dustin's reading
  difficulty was still undiagnosed and awaiting formal evaluation. Explicitly NOT
  gamified and NOT a diagnostic instrument — only the rhyme task is auto-scored;
  the three production tasks just capture a plain, unbiased transcript (see
  `transcribeAudio()` in `worker.js` for why they're not auto-graded) for a parent
  to review or bring to an evaluator. No stars, no score shown to Dustin.

And one parent-facing surface:
- `admin.html` — passcode-gated. Word-list intake (paste/upload vocab, no redeploy
  needed) plus a Progress panel (`GET /api/admin/progress`) that aggregates
  everything already being recorded: recent activity by drill type, words needing
  practice vs. mastered, passage performance, and full Sound Check sessions with
  transcripts. Read-only rollup — doesn't change what gets recorded anywhere else.

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
- `reading:dustin:screener:{timestamp}` — one Sound Check session: `{ sessionId,
  rhymeAnswers[] ({id, wordA, wordB, correctAnswer, givenAnswer}),
  isolationResponses[] ({id, word, target, transcript}), blendingResponses[] ({id,
  answer, transcript}), segmentationResponses[] ({id, word, transcript}) }`. Stored
  verbatim, no derived scoring beyond what `admin.html` computes on read (rhyme
  correct count) — this is a record for review, not a mastery bucket.

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

- **Theme pivoted from naval/ocean to space/cockpit** after Erica shared an
  AI-generated video of a spacesuit-wearing T-Rex getting blasted from a ship's
  cockpit. The canvas scene is now a first-person cockpit view (starfield,
  drifting asteroids, twin cannon silhouettes at the bottom instead of a ship
  sprite) rather than sonar/ocean waves — but the underlying weapon flavor text
  ("breech," "salvo," "fire") barely had to change, since naval terminology
  reads fine for spaceship weapons too. If more theme work happens later, keep
  that in mind — most copy survives a visual reskin here.
- The three `trex-*.gif` files in `assets/apex-armada/` were extracted directly
  from that source video (cropped frames via Python/OpenCV/Pillow, not
  hand-made art) — genuinely reasonable placeholders, not a "TODO: replace,"
  but Erica may still send cleaner dedicated assets later under the same
  filenames.
- Typed input only. Speech input was explicitly deferred in the original handoff doc
  pending a fix to the sight-word drill's Azure webm/opus scoring bug — wire it in
  later via the same Azure Pronunciation Assessment path `reading.html` already uses.
- Dispatch briefings (`POST /api/game/dispatch`) are generated via the Claude API
  (`claude-haiku-4-5-20251001` — same model Word Helper's vision calls use, same
  `ANTHROPIC_API_KEY` secret) constrained to the current round's session word pool,
  and validated token-by-token against that pool before being shown — regenerated on
  failure, with a deterministic template fallback that's trivially always valid.
- No visible timers, no scores-as-grades — same design wall as the rest of the app.
  `latencyMs` is tracked per attempt but never rendered client-side.
- **One deliberate deviation from the app's no-loss-state rule, added after real
  playtesting feedback from Dustin**, not a doc author's guess: the T-Rex visibly
  creeps closer with a roar on each genuinely missed word (`registerMiss()` in
  `apex-armada.html` — only fires on a final reveal, not a forgiven first fumble).
  At 3 misses (`DINO_THREAT_MAX`), instead of restarting the session, the dino's
  advance "regroups" — bigger flash/sound, then eases back to its starting position
  — and play continues with whatever words are left. Real stakes and drama without
  discarding progress. If this gets revisited, that's the tension to preserve: kids
  legitimately want more game-like stakes than the original no-pressure doc assumed,
  but a hard restart risks discouraging the exact kid this app is built for.
- Help buttons (re-scramble, first/last letter) are free and instant, client-side
  only. Definition and Sound It Out both call `POST /api/game/word-hint` (stateless,
  no KV write — a hint lookup isn't a mastery event), sharing one cached fetch per
  round since both need the same Claude response.
- Optional background music + hit/miss sound cues + an animated T-Rex gif read from
  `assets/apex-armada/*` (see that folder's README for exact filenames) — every
  reference gracefully no-ops until the real files are dropped in, so none of this
  blocks the game working today.
