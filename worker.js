/**
 * Star Reader — Cloudflare Worker
 * Sight-word drill scoring endpoint.
 *
 * Bindings expected (set in wrangler.toml / dashboard):
 *   TUTOR_KV            - KV namespace (shared with TutorHub)
 *   AZURE_SPEECH_KEY    - encrypted secret, Azure Speech resource key (reused from TutorHub TTS)
 *   AZURE_SPEECH_REGION - plain text var, e.g. "eastus" (must match the TutorHub Azure Speech resource's region)
 *   ANTHROPIC_API_KEY   - encrypted secret, Claude API key (Word Helper's vision calls,
 *                         and /api/game/dispatch's text generation below)
 *
 * Route: POST /api/sight-word/score
 *   multipart/form-data:
 *     audio       - audio blob (16kHz mono 16-bit PCM WAV, encoded client-side via Web Audio API)
 *     targetWord  - string, the word Dustin was shown
 *     latencyMs   - string/number, VAD-measured latency from the client (optional)
 *
 * Scoring: uses Azure's Pronunciation Assessment (phoneme-level), not just word transcription.
 * "Correct" requires the word-level score AND every individual phoneme to clear a threshold —
 * strict, so a mispronounced-but-recognizable word (e.g. "said" as "sah-EED") is caught rather
 * than being auto-corrected to the target word the way a plain transcription API would.
 *
 * Route: POST /api/spelling/score
 *   JSON body: { targetWord, attempt }. Pure exact-match string comparison (no Azure
 *   call) — the child hears the word via /api/tts and types what they heard.
 *   Updates reading:dustin:words:{word}.spelling{correct,attempts} and appends to
 *   today's session log with drillType "spelling".
 *   Returns { correct, correctSpelling }.
 *
 * Route: POST /api/word-helper/analyze
 *   multipart/form-data: image - a photo/screenshot of a word (or words) Dustin is
 *   stuck on. Sends the image to Claude's vision API (ANTHROPIC_API_KEY) in one call
 *   asking it to: find the readable word(s) in the photo (just the one if it's
 *   circled/highlighted/the only text, otherwise up to 6, most-prominent first), and
 *   for each return a kid-friendly one-sentence definition plus a spelled syllable
 *   breakdown (grapheme chunks, same style as the reading drill's — not phonemes).
 *   Returns { words: [{ word, definition, syllables }] }. No KV writes here — that
 *   only happens once a word is actually selected, via /api/word-helper/log.
 *
 * Route: POST /api/word-helper/log
 *   JSON body: { word }. Called when Dustin taps a detected word to actually look at
 *   it — records to reading:dustin:words:{word}.wordHelper{timesLookedUp} and appends
 *   today's session log with drillType "word-helper" (no correct/incorrect — this
 *   isn't scored). Kept separate from /analyze so only words he actually opens count,
 *   not every word Claude happened to detect in a busier photo.
 *
 * Route: GET /api/tts?word=<word>&rate=slow|normal&phonemes=<space-separated SAPI codes>
 *   Returns audio/mpeg — spoken via Azure TTS (reuses the same Speech resource as
 *   scoring). Used for the whole-word "listen for the sound" hint (attempt 4+) and for
 *   tap-to-hear syllable pills (attempts 2-3). When `phonemes` is given, pronunciation
 *   is forced via an SSML <phoneme alphabet="sapi"> tag instead of guessed from `word`'s
 *   spelling — needed for isolated syllable fragments that aren't valid English spelling
 *   on their own (plain-text TTS on e.g. "dence" or a lone "i" mispronounces them).
 *
 * Route: GET /api/sight-word/session-words
 *   Public, no gate. Returns { words: string[], source } — the word set for a drill
 *   session, pulled from whatever the admin has loaded into reading:dustin:wordlist:*.
 *   Adaptively weighted (see computeWordWeight) by reading:dustin:words:{word}'s
 *   accumulated reading+spelling accuracy — struggling words come up more, mastered
 *   ones taper off but don't disappear, new words get a fair shot. Falls back to a
 *   small built-in default list if nothing's been loaded yet.
 *
 * Route: GET /api/game/session-words?count=N
 *   Public, no gate. Same pooling + weighting logic as the route above (reuses
 *   computeWordWeight/weightedSampleWithoutReplacement) — just a different default
 *   count (6, themed as "rounds" for Apex Armada). Intentionally the same selection
 *   function as the sight-word/spelling drills, not a separate pool or algorithm.
 *
 * Route: POST /api/game/dispatch
 *   JSON body: { words: string[], targetWord }. Generates a 1-2 sentence "sonar
 *   briefing" for the Apex Armada game via the Claude API, constrained to only the
 *   given words, and programmatically validates every token of the response against
 *   that word set before returning it — regenerating on failure (a few attempts).
 *   If ANTHROPIC_API_KEY isn't configured, or generation never validates, falls back
 *   to a deterministic template built directly from the word list (always valid).
 *   Returns { dispatch, source: "generated" | "template" }.
 *
 * Route: POST /api/game/attempt
 *   JSON body: { sessionId, word, mode, correct, attemptNumber, latencyMs, dispatchText? }.
 *   Records one Apex Armada round result. Mastery data goes through the same path as
 *   the spelling drill (recordSpellingAttempt — the game's typed cipher-breech input
 *   is the same exact-match mechanic as spelling, so it reuses that bucket rather than
 *   a parallel mastery mechanic), tagged drillType "game" in the daily session log.
 *   Session-specific data (score, wordsUsed, results, dispatchesShown, duration) is
 *   kept separately in reading:dustin:game:{sessionId}. Returns { ok, session }.
 *
 * Route: GET /api/admin/wordlist
 *   Requires header X-Admin-Passcode matching the ADMIN_PASSCODE secret binding.
 *   Returns { wordlists: [{ source, wordCount, updatedAt }] } — existing batches.
 *
 * Route: POST /api/admin/wordlist
 *   Requires header X-Admin-Passcode. JSON body: { source, words }, where `words` is
 *   raw pasted text (newline or comma separated). Parses, dedupes, and writes to
 *   reading:dustin:wordlist:{source}.
 *
 * Route: GET /api/passage/session
 *   Public, no gate. Returns { passages: [{ id, text, question: { prompt, options,
 *   correctIndex } }] } — PASSAGE_SESSION_COUNT passages from the built-in PASSAGES
 *   bank (short, original, 6th/7th-grade-level — grade-matched to Dustin's actual
 *   curriculum per TutorHub, not early-elementary content), adaptively weighted by
 *   reading:dustin:passages:{id}'s bestAccuracy the same way session-words is. The
 *   comprehension answer key ships with the payload and is checked client-side —
 *   low-stakes for a single child's reading practice, not worth a second round trip.
 *
 * Route: POST /api/passage/score
 *   multipart/form-data: audio (16kHz mono PCM WAV, same encoding as sight-word
 *   scoring), targetText (the full passage). Reuses assessPronunciation() as-is —
 *   Azure's pronunciation assessment already handles multi-word ReferenceText and
 *   returns utterance-level Accuracy/Fluency/Completeness scores directly, so no
 *   separate passage-scoring path was needed. Passages are kept short (under ~90
 *   words) to stay within what the short-audio REST endpoint handles well — no
 *   streaming/continuous-recognition endpoint here.
 *   Returns { overallAccuracy, fluencyScore, completenessScore, weakWords }, where
 *   weakWords is the list of recognized words that scored under WORD_SCORE_THRESHOLD
 *   (word-level, unlike the phoneme-level detail the sight-word drill surfaces —
 *   passage-scale feedback is about which words to revisit, not individual sounds).
 *   Updates reading:dustin:passages:{id}{attempts,bestAccuracy} and appends today's
 *   session log with drillType "passage".
 *
 * Additional binding expected:
 *   ADMIN_PASSCODE - encrypted secret, shared passcode gating the /api/admin/* routes
 */

const KV_PREFIX = "reading:dustin:";

const WORD_SCORE_THRESHOLD = 80; // 0-100, Azure's AccuracyScore for the whole word
const PHONEME_SCORE_THRESHOLD = 60; // 0-100, below this a phoneme counts as "weak"
// Up to this many weak phonemes are forgiven on an otherwise-strong word (calibrated
// against a real attempt: "conclude" scored 96 word/100 fluency/100 completeness but
// had one phoneme at 2 — requiring literally every phoneme to pass failed a
// near-perfect read over one trailing/mumbled sound).
const MAX_FORGIVABLE_WEAK_PHONEMES = 1;

const DEFAULT_SESSION_WORDS = ["the", "said", "was", "come", "friend"];
const SESSION_WORD_COUNT = 5;

const PASSAGE_SESSION_COUNT = 3;

const GAME_SESSION_WORD_COUNT = 6;
const GAME_KV_PREFIX = `${KV_PREFIX}game:`;
const DISPATCH_MAX_ATTEMPTS = 3;
const DISPATCH_MODEL = "claude-haiku-4-5-20251001";

// Original short passages, 6th/7th-grade level (grade-matched per TutorHub's actual
// curriculum, not early-elementary content) — none of this is drawn from any
// copyrighted source. Kept short (well under 100 words) so a full-passage read stays
// within what Azure's short-audio pronunciation-assessment endpoint handles well.
const PASSAGES = [
  {
    id: "moon-phases",
    text: "The moon does not make its own light. Instead, it reflects light from the sun. As the moon orbits Earth, we see different amounts of its lit half. This is why the moon seems to change shape every night, from a thin sliver to a full circle and back again.",
    question: {
      prompt: "Why does the moon appear to change shape?",
      options: [
        "It grows and shrinks each month",
        "We see different amounts of sunlight reflecting off it",
        "Clouds cover parts of it",
        "The moon spins very fast",
      ],
      correctIndex: 1,
    },
  },
  {
    id: "coral-reef",
    text: "A coral reef looks like a rock garden, but it is actually alive. Tiny animals called coral polyps build hard skeletons that connect together over many years. Thousands of fish, crabs, and other creatures depend on the reef for food and shelter, which is why reefs are sometimes called the rainforests of the sea.",
    question: {
      prompt: "Why are coral reefs compared to rainforests?",
      options: [
        "They are found in the same locations",
        "They are made of trees",
        "They support a huge variety of living things",
        "They are colored green",
      ],
      correctIndex: 2,
    },
  },
  {
    id: "pyramids",
    text: "Thousands of years ago, the people of ancient Egypt built massive pyramids as tombs for their pharaohs. Workers hauled enormous stone blocks across the desert without any modern machines. Historians still study how such a huge project was organized and completed with the tools available at the time.",
    question: {
      prompt: "What were the pyramids built for?",
      options: ["Storing grain", "Tombs for pharaohs", "Government buildings", "Marketplaces"],
      correctIndex: 1,
    },
  },
  {
    id: "baker-recipe",
    text: "A baker was testing a new bread recipe. Her first batch used too much salt, so the loaves tasted harsh. She adjusted the ratio of salt to flour and tried again. The second batch turned out perfectly balanced, and she wrote the exact measurements down so she would never lose the recipe.",
    question: {
      prompt: "What problem did the baker fix in her second batch?",
      options: ["The bread didn't rise", "There was too much salt", "The oven was too hot", "She ran out of flour"],
      correctIndex: 1,
    },
  },
  {
    id: "voting",
    text: "In a democracy, citizens choose their leaders by voting. Each vote counts toward deciding who will represent the community's interests. Because decisions affect everyone, many people believe voting is not just a right, but also an important responsibility.",
    question: {
      prompt: "According to the passage, why do some people see voting as a responsibility?",
      options: [
        "It is required by law in every country",
        "Decisions affect the whole community",
        "It only takes a few minutes",
        "Leaders ask citizens to vote",
      ],
      correctIndex: 1,
    },
  },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/api/sight-word/score" && request.method === "POST") {
      return withCors(await handleScore(request, env));
    }

    if (url.pathname === "/api/spelling/score" && request.method === "POST") {
      return withCors(await handleSpellingScore(request, env));
    }

    if (url.pathname === "/api/word-helper/analyze" && request.method === "POST") {
      return withCors(await handleWordHelperAnalyze(request, env));
    }

    if (url.pathname === "/api/word-helper/log" && request.method === "POST") {
      return withCors(await handleWordHelperLog(request, env));
    }

    if (url.pathname === "/api/passage/session" && request.method === "GET") {
      return withCors(await handlePassageSession(request, env));
    }

    if (url.pathname === "/api/passage/score" && request.method === "POST") {
      return withCors(await handlePassageScore(request, env));
    }

    if (url.pathname === "/api/tts" && request.method === "GET") {
      return withCors(await handleTTS(request, env));
    }

    if (url.pathname === "/api/sight-word/session-words" && request.method === "GET") {
      return withCors(await handleSessionWords(request, env));
    }

    if (url.pathname === "/api/game/session-words" && request.method === "GET") {
      return withCors(await handleGameSessionWords(request, env));
    }

    if (url.pathname === "/api/game/dispatch" && request.method === "POST") {
      return withCors(await handleGameDispatch(request, env));
    }

    if (url.pathname === "/api/game/attempt" && request.method === "POST") {
      return withCors(await handleGameAttempt(request, env));
    }

    if (url.pathname === "/api/admin/wordlist" && request.method === "GET") {
      return withCors(await handleAdminListWordlists(request, env));
    }

    if (url.pathname === "/api/admin/wordlist" && request.method === "POST") {
      return withCors(await handleAdminAddWordlist(request, env));
    }

    return withCors(new Response("Not found", { status: 404 }));
  },
};

function isAdminAuthorized(request, env) {
  const expected = (env.ADMIN_PASSCODE || "").trim();
  if (!expected) return false; // fail closed if the secret was never configured
  const provided = (request.headers.get("X-Admin-Passcode") || "").trim();
  return provided.length > 0 && provided === expected;
}

function parseWordList(rawText) {
  const seen = new Set();
  const words = [];
  rawText
    .split(/[\n,]+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0 && /^[a-z'-]+$/.test(w))
    .forEach((w) => {
      if (!seen.has(w)) {
        seen.add(w);
        words.push(w);
      }
    });
  return words;
}

// Adaptive selection — replaces plain shuffling. Each candidate (word or passage)
// gets a weight from how much practice it needs: never-attempted items get a fair,
// moderately-high shot at being introduced; struggling items (low accuracy) come up
// more often; mastered items taper off but never to zero, so there's still light
// review instead of a word disappearing forever the moment it's nailed once.
const ADAPTIVE_NEW_ITEM_WEIGHT = 1.5;
const ADAPTIVE_MIN_WEIGHT = 0.3;
const ADAPTIVE_MAX_WEIGHT = 3;

function computeWordWeight(record) {
  const reading = record && record.reading;
  const spelling = record && record.spelling;
  const attempts = ((reading && reading.attempts) || 0) + ((spelling && spelling.attempts) || 0);
  if (attempts === 0) return ADAPTIVE_NEW_ITEM_WEIGHT;
  const correct = ((reading && reading.correct) || 0) + ((spelling && spelling.correct) || 0);
  const accuracy = correct / attempts;
  return ADAPTIVE_MIN_WEIGHT + (1 - accuracy) * (ADAPTIVE_MAX_WEIGHT - ADAPTIVE_MIN_WEIGHT);
}

function computePassageWeight(record) {
  if (!record || !record.attempts) return ADAPTIVE_NEW_ITEM_WEIGHT;
  const accuracy = (record.bestAccuracy || 0) / 100; // bestAccuracy is 0-100, not 0-1
  return ADAPTIVE_MIN_WEIGHT + (1 - accuracy) * (ADAPTIVE_MAX_WEIGHT - ADAPTIVE_MIN_WEIGHT);
}

// Weighted sampling without replacement — picks `count` items, each draw
// proportional to remaining weight among what's left. O(count * items.length),
// fine at this app's scale (low hundreds of words, a handful of passages).
function weightedSampleWithoutReplacement(items, weights, count) {
  const pool = items.map((item, i) => ({ item, weight: Math.max(weights[i], 0.0001) }));
  const selected = [];
  while (selected.length < count && pool.length) {
    const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0);
    let r = Math.random() * totalWeight;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) {
      r -= pool[idx].weight;
      if (r <= 0) break;
    }
    selected.push(pool[idx].item);
    pool.splice(idx, 1);
  }
  return selected;
}

// Pools every reading:dustin:wordlist:* batch the admin has loaded into one deduped
// list. Shared by both session-words endpoints below — there is exactly one word
// pool and one weighting function, never a separate one per interface.
async function getPooledWords(kv) {
  const listResult = await kv.list({ prefix: `${KV_PREFIX}wordlist:` });
  if (!listResult.keys.length) return [];

  const seen = new Set();
  const allWords = [];
  for (const k of listResult.keys) {
    const raw = await kv.get(k.name);
    if (!raw) continue;
    const parsed = JSON.parse(raw);
    (parsed.words || []).forEach((w) => {
      if (!seen.has(w)) {
        seen.add(w);
        allWords.push(w);
      }
    });
  }
  return allWords;
}

async function selectAdaptiveWords(kv, allWords, count) {
  const records = await Promise.all(allWords.map((w) => kv.get(`${KV_PREFIX}words:${w}`)));
  const weights = records.map((raw) => computeWordWeight(raw ? JSON.parse(raw) : null));
  return weightedSampleWithoutReplacement(allWords, weights, Math.min(count, allWords.length));
}

async function handleSessionWords(request, env) {
  try {
    const allWords = await getPooledWords(env.TUTOR_KV);
    if (!allWords.length) {
      return jsonResponse({ words: DEFAULT_SESSION_WORDS, source: "default" });
    }
    const selected = await selectAdaptiveWords(env.TUTOR_KV, allWords, SESSION_WORD_COUNT);
    return jsonResponse({ words: selected, source: "wordlist" });
  } catch (err) {
    console.error("Session words error:", err && err.message);
    return jsonResponse({ words: DEFAULT_SESSION_WORDS, source: "default-error" });
  }
}

async function handleGameSessionWords(request, env) {
  try {
    const url = new URL(request.url);
    const countParam = parseInt(url.searchParams.get("count"), 10);
    const count = Number.isFinite(countParam) && countParam > 0 ? countParam : GAME_SESSION_WORD_COUNT;

    const allWords = await getPooledWords(env.TUTOR_KV);
    if (!allWords.length) {
      return jsonResponse({ words: DEFAULT_SESSION_WORDS.slice(0, count), source: "default" });
    }
    const selected = await selectAdaptiveWords(env.TUTOR_KV, allWords, count);
    return jsonResponse({ words: selected, source: "wordlist" });
  } catch (err) {
    console.error("Game session words error:", err && err.message);
    return jsonResponse({ words: DEFAULT_SESSION_WORDS.slice(0, GAME_SESSION_WORD_COUNT), source: "default-error" });
  }
}

async function handlePassageSession(request, env) {
  const records = await Promise.all(PASSAGES.map((p) => env.TUTOR_KV.get(`${KV_PREFIX}passages:${p.id}`)));
  const weights = records.map((raw) => computePassageWeight(raw ? JSON.parse(raw) : null));
  const selected = weightedSampleWithoutReplacement(PASSAGES, weights, Math.min(PASSAGE_SESSION_COUNT, PASSAGES.length));
  return jsonResponse({
    passages: selected.map((p) => ({ id: p.id, text: p.text, question: p.question })),
  });
}

async function handlePassageScore(request, env) {
  try {
    const formData = await request.formData();
    const audio = formData.get("audio");
    const passageId = (formData.get("passageId") || "").toString().trim();
    const targetText = (formData.get("targetText") || "").toString().trim();

    if (!audio || !targetText) {
      return jsonResponse({ error: "Missing audio or targetText" }, 400);
    }

    const assessment = await assessPronunciation(audio, targetText, env.AZURE_SPEECH_KEY, env.AZURE_SPEECH_REGION);

    const weakWords = assessment.words.filter((w) => w.accuracy < WORD_SCORE_THRESHOLD).map((w) => w.word);

    if (passageId) {
      await recordPassageAttempt(env.TUTOR_KV, passageId, {
        overallAccuracy: assessment.wordAccuracy,
        fluencyScore: assessment.fluencyScore,
        completenessScore: assessment.completenessScore,
      });
    }

    return jsonResponse({
      overallAccuracy: assessment.wordAccuracy,
      fluencyScore: assessment.fluencyScore,
      completenessScore: assessment.completenessScore,
      weakWords,
      transcript: assessment.transcript,
    });
  } catch (err) {
    console.error("Passage scoring error:", err && err.message);
    return jsonResponse({ error: "Scoring failed", detail: err && err.message }, 500);
  }
}

async function handleAdminListWordlists(request, env) {
  if (!isAdminAuthorized(request, env)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  try {
    const listResult = await env.TUTOR_KV.list({ prefix: `${KV_PREFIX}wordlist:` });
    const wordlists = await Promise.all(
      listResult.keys.map(async (k) => {
        const raw = await env.TUTOR_KV.get(k.name);
        const parsed = raw ? JSON.parse(raw) : null;
        return {
          source: parsed ? parsed.source : k.name.replace(`${KV_PREFIX}wordlist:`, ""),
          wordCount: parsed && parsed.words ? parsed.words.length : 0,
          updatedAt: parsed ? parsed.updatedAt : null,
        };
      })
    );
    return jsonResponse({ wordlists });
  } catch (err) {
    console.error("Admin list wordlists error:", err && err.message);
    return jsonResponse({ error: "Failed to list word lists", detail: err && err.message }, 500);
  }
}

async function handleAdminAddWordlist(request, env) {
  if (!isAdminAuthorized(request, env)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  try {
    const body = await request.json();
    const source = (body.source || "")
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-");
    const rawText = (body.words || "").toString();

    if (!source || !rawText.trim()) {
      return jsonResponse({ error: "Missing source or words" }, 400);
    }

    const words = parseWordList(rawText);
    if (!words.length) {
      return jsonResponse({ error: "No valid words found" }, 400);
    }

    const key = `${KV_PREFIX}wordlist:${source}`;
    await env.TUTOR_KV.put(key, JSON.stringify({ source, words, updatedAt: new Date().toISOString() }));

    return jsonResponse({ source, wordCount: words.length, words });
  } catch (err) {
    console.error("Admin add wordlist error:", err && err.message);
    return jsonResponse({ error: "Failed to save word list", detail: err && err.message }, 500);
  }
}

async function handleGameDispatch(request, env) {
  try {
    const body = await request.json();
    const words = Array.isArray(body.words)
      ? body.words.map((w) => (w || "").toString().trim().toLowerCase()).filter(Boolean)
      : [];
    const targetWord = (body.targetWord || "").toString().trim().toLowerCase();

    if (!words.length || !targetWord) {
      return jsonResponse({ error: "Missing words or targetWord" }, 400);
    }

    const allowedSet = new Set(words);
    allowedSet.add(targetWord);

    const apiKey = (env.ANTHROPIC_API_KEY || "").trim();
    if (apiKey) {
      for (let attempt = 0; attempt < DISPATCH_MAX_ATTEMPTS; attempt++) {
        try {
          const dispatch = await generateDispatch(apiKey, [...allowedSet], targetWord);
          if (dispatch && isDispatchValid(dispatch, allowedSet)) {
            return jsonResponse({ dispatch, source: "generated" });
          }
        } catch (err) {
          console.error("Dispatch generation attempt failed:", err && err.message);
        }
      }
    }

    // No key configured, or every generation attempt failed validation — fall back
    // to a sentence built directly from the allowed word set, so it's trivially
    // valid and a dispatch is always returned (no human review exists before Dustin
    // sees this, so we never skip the validation gate).
    return jsonResponse({ dispatch: buildTemplateDispatch(targetWord, allowedSet), source: "template" });
  } catch (err) {
    console.error("Game dispatch error:", err && err.message);
    return jsonResponse({ error: "Failed to build dispatch", detail: err && err.message }, 500);
  }
}

async function generateDispatch(apiKey, allowedWords, targetWord) {
  const prompt =
    `You are writing a one-sentence sonar/recon briefing for a kids' naval-vs-dinosaur reading game.\n` +
    `Write exactly ONE short sentence (max 10 words) using ONLY words from this list, plus a trailing ` +
    `period: ${allowedWords.join(", ")}.\n` +
    `The sentence MUST include the word "${targetWord}".\n` +
    `Do not use any word that is not in the list, no names, no other punctuation. Reply with just the sentence.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DISPATCH_MODEL,
      max_tokens: 60,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const block = Array.isArray(data.content) ? data.content.find((c) => c.type === "text") : null;
  return block && block.text ? block.text.trim() : "";
}

// Tokenizes on whitespace after stripping punctuation and checks every token is a
// member of the allowed word set — the non-negotiable "never skip this check" rule
// from the project doc, since no human reviews dispatches before Dustin sees them.
function isDispatchValid(dispatch, allowedSet) {
  const tokens = dispatch
    .toLowerCase()
    .replace(/[^a-z'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return false;
  return tokens.every((t) => allowedSet.has(t));
}

function buildTemplateDispatch(targetWord, allowedSet) {
  const cap = targetWord.charAt(0).toUpperCase() + targetWord.slice(1);
  if (allowedSet.has("is") && allowedSet.has("here")) {
    return `${cap} is here.`;
  }
  if (allowedSet.has("the")) {
    return `The ${targetWord}.`;
  }
  return `${cap}.`;
}

async function handleGameAttempt(request, env) {
  try {
    const body = await request.json();
    const sessionId = (body.sessionId || "").toString().trim();
    const word = (body.word || "").toString().trim().toLowerCase();
    const mode = (body.mode || "scramble").toString().trim().toLowerCase();
    const correct = !!body.correct;
    const attemptNumber = Number.isFinite(body.attemptNumber) ? body.attemptNumber : 1;
    const latencyMs = typeof body.latencyMs === "number" && !Number.isNaN(body.latencyMs) ? body.latencyMs : null;
    const dispatchText = body.dispatchText ? body.dispatchText.toString() : null;

    if (!sessionId || !word) {
      return jsonResponse({ error: "Missing sessionId or word" }, 400);
    }

    // Mastery write: the game's typed cipher-breech input is exact-match scoring —
    // the same mechanic as the spelling drill, not a new one — so it reuses that
    // bucket/function rather than a parallel mastery mechanic. Tagged "game" in the
    // daily session log to stay distinguishable from the plain spelling drill.
    await recordSpellingAttempt(env.TUTOR_KV, word, correct, "game");

    const session = await recordGameAttempt(env.TUTOR_KV, sessionId, {
      word,
      mode,
      correct,
      attemptNumber,
      latencyMs,
      dispatchText,
    });

    return jsonResponse({ ok: true, session });
  } catch (err) {
    console.error("Game attempt error:", err && err.message);
    return jsonResponse({ error: "Failed to record attempt", detail: err && err.message }, 500);
  }
}

// Session-specific data, kept separate from word mastery per the project doc's
// explicit split: mastery -> words:{word}, session/game data -> game:{sessionId}.
async function recordGameAttempt(kv, sessionId, { word, mode, correct, attemptNumber, latencyMs, dispatchText }) {
  const key = `${GAME_KV_PREFIX}${sessionId}`;
  const existingRaw = await kv.get(key);
  const now = Date.now();
  const session = existingRaw
    ? JSON.parse(existingRaw)
    : {
        date: new Date().toISOString().slice(0, 10),
        wordsUsed: [],
        results: [],
        dispatchesShown: [],
        duration: 0,
        score: 0,
        startedAt: now, // internal timing anchor only — never surfaced to Dustin
      };

  if (!session.wordsUsed.includes(word)) session.wordsUsed.push(word);
  session.results.push({ word, correct, mode, attempts: attemptNumber, latencyMs });
  if (dispatchText && !session.dispatchesShown.includes(dispatchText)) {
    session.dispatchesShown.push(dispatchText);
  }
  // score is a cosmetic in-game number (salvos on target), not a mastery metric.
  session.score = session.results.filter((r) => r.correct).length;
  session.duration = Math.round((now - (session.startedAt || now)) / 1000);

  await kv.put(key, JSON.stringify(session));

  const { startedAt, ...publicSession } = session;
  return publicSession;
}

async function handleScore(request, env) {
  try {
    const formData = await request.formData();
    const audio = formData.get("audio");
    const targetWord = (formData.get("targetWord") || "").toString().trim().toLowerCase();
    const latencyMsRaw = formData.get("latencyMs");
    const latencyMs = latencyMsRaw ? parseInt(latencyMsRaw, 10) : null;

    if (!audio || !targetWord) {
      return jsonResponse({ error: "Missing audio or targetWord" }, 400);
    }

    // 1. Send audio + target word to Azure for phoneme-level pronunciation assessment
    const assessment = await assessPronunciation(audio, targetWord, env.AZURE_SPEECH_KEY, env.AZURE_SPEECH_REGION);

    // 2. Correctness: overall word score must clear its bar, and at most one phoneme
    // is allowed to fall short — forgives a single weak/trailing sound on an
    // otherwise-strong word without going soft on genuine multi-sound struggles.
    const wordPassed = assessment.wordAccuracy >= WORD_SCORE_THRESHOLD;
    const weakPhonemeCount = assessment.phonemes.filter((p) => p.accuracy < PHONEME_SCORE_THRESHOLD).length;
    const correct = wordPassed && weakPhonemeCount <= MAX_FORGIVABLE_WEAK_PHONEMES;

    // Weakest phoneme — used by the client to show "which sound was off" on a second miss
    const weakestPhoneme = assessment.phonemes.length
      ? assessment.phonemes.reduce((min, p) => (p.accuracy < min.accuracy ? p : min))
      : null;

    // 3. Update KV: reading:dustin:words:{word}
    await recordAttempt(env.TUTOR_KV, targetWord, {
      correct,
      latencyMs,
      transcript: assessment.transcript,
      wordAccuracy: assessment.wordAccuracy,
    });

    return jsonResponse({
      correct,
      transcript: assessment.transcript,
      wordAccuracy: assessment.wordAccuracy,
      weakestPhoneme: weakestPhoneme ? { phoneme: weakestPhoneme.phoneme, accuracy: weakestPhoneme.accuracy } : null,
      // Grapheme (spelled) syllable chunks, e.g. [{grapheme:"cir"},{grapheme:"cum"},{grapheme:"stance"}] —
      // used for the kid-legible syllable-breakdown hint on a second miss.
      syllables: assessment.syllables,
      // Diagnostic fields (not used by the correctness gate) — helps tell "badly
      // pronounced" apart from "alignment/miscue mismatch" while calibrating.
      debug: {
        recognitionStatus: assessment.recognitionStatus,
        wordErrorType: assessment.wordErrorType,
        fluencyScore: assessment.fluencyScore,
        completenessScore: assessment.completenessScore,
        pronScore: assessment.pronScore,
      },
    });
  } catch (err) {
    console.error("Scoring error message:", err && err.message);
    console.error("Scoring error stack:", err && err.stack);
    return jsonResponse({ error: "Scoring failed", detail: err && err.message }, 500);
  }
}

// Pure string comparison — no Azure call needed, unlike the reading drill's
// pronunciation assessment. `attempt` is what the child typed after hearing
// the word via /api/tts; correctness is exact-match, case/whitespace-insensitive.
async function handleSpellingScore(request, env) {
  try {
    const body = await request.json();
    const targetWord = (body.targetWord || "").toString().trim().toLowerCase();
    const attempt = (body.attempt || "").toString().trim().toLowerCase();

    if (!targetWord || !attempt) {
      return jsonResponse({ error: "Missing targetWord or attempt" }, 400);
    }

    const correct = attempt === targetWord;

    await recordSpellingAttempt(env.TUTOR_KV, targetWord, correct);

    return jsonResponse({ correct, correctSpelling: targetWord });
  } catch (err) {
    console.error("Spelling score error:", err && err.message);
    return jsonResponse({ error: "Scoring failed", detail: err && err.message }, 500);
  }
}

// System prompt for Claude's vision call — kept strict about JSON-only output since
// the Worker parses the response directly with no free-text fallback.
const WORD_HELPER_SYSTEM_PROMPT = `You help build a reading-support tool for a young child who is learning to read. You will be shown a photo of text (a worksheet, book page, sign, or screenshot) and must respond with ONLY valid JSON — no markdown code fences, no commentary before or after — matching exactly this shape:

{"words": [{"word": "example", "definition": "A short, simple sentence a 6-9 year old can understand, explaining what the word means.", "syllables": ["ex", "am", "ple"]}]}

Rules:
- Only include actual words a child might need help with — skip numbers, punctuation-only tokens, and stray single letters (unless the letter is a real word on its own, like "a" or "I").
- If one word is circled, highlighted, underlined, or is clearly the only/primary text in the photo, return just that single word.
- Otherwise return up to 6 of the most prominent words, most prominent first.
- "definition" must be exactly one short, plain sentence — no jargon, and never use the word itself (or an obvious variant of it) inside its own definition.
- "syllables" is the word split into spelled syllable chunks (not phonetic symbols), e.g. "circumstance" -> ["cir", "cum", "stance"]. For a one-syllable word, return a single-element array containing the whole word.
- If you can't find any readable words in the image, return {"words": []}.`;

async function handleWordHelperAnalyze(request, env) {
  try {
    const formData = await request.formData();
    const image = formData.get("image");
    if (!image) {
      return jsonResponse({ error: "Missing image" }, 400);
    }

    const apiKey = (env.ANTHROPIC_API_KEY || "").trim();
    if (!apiKey) {
      return jsonResponse({ error: "Missing ANTHROPIC_API_KEY binding" }, 500);
    }

    const mediaType = (image.type || "image/jpeg").split(";")[0] || "image/jpeg";
    const buffer = await image.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);

    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: WORD_HELPER_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
                { type: "text", text: "Here is the photo. Respond with only the JSON described in your instructions." },
              ],
            },
          ],
        }),
      });
    } catch (networkErr) {
      console.error("Anthropic API network error:", networkErr.message);
      throw new Error(`Anthropic API network error: ${networkErr.message}`);
    }

    if (!res.ok) {
      const errText = await res.text();
      console.error("Anthropic API non-OK response:", res.status, errText);
      return jsonResponse({ error: "Word Helper analysis failed", detail: errText }, 502);
    }

    const data = await res.json();
    const rawText = (data.content && data.content[0] && data.content[0].text) || "";

    let parsed;
    try {
      parsed = JSON.parse(stripJsonFences(rawText));
    } catch (parseErr) {
      console.error("Word Helper: couldn't parse Claude response as JSON:", rawText);
      return jsonResponse({ error: "Couldn't understand that photo — try again with just the word in view." }, 502);
    }

    const words = Array.isArray(parsed.words)
      ? parsed.words
          .slice(0, 6)
          .map((w) => ({
            word: (w.word || "").toString().trim().toLowerCase(),
            definition: (w.definition || "").toString().trim(),
            syllables: Array.isArray(w.syllables) ? w.syllables.map((s) => s.toString().toLowerCase()) : [],
          }))
          .filter((w) => w.word)
      : [];

    return jsonResponse({ words });
  } catch (err) {
    console.error("Word Helper analyze error:", err && err.message);
    return jsonResponse({ error: "Word Helper analysis failed", detail: err && err.message }, 500);
  }
}

function stripJsonFences(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000; // avoid call-stack blowup from String.fromCharCode(...bytes) on large images
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function handleWordHelperLog(request, env) {
  try {
    const body = await request.json();
    const word = (body.word || "").toString().trim().toLowerCase();
    if (!word) {
      return jsonResponse({ error: "Missing word" }, 400);
    }

    await recordWordHelperLookup(env.TUTOR_KV, word);

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("Word Helper log error:", err && err.message);
    return jsonResponse({ error: "Failed to log lookup", detail: err && err.message }, 500);
  }
}

async function recordWordHelperLookup(kv, word) {
  const key = `${KV_PREFIX}words:${word}`;
  const existingRaw = await kv.get(key);
  const existing = existingRaw
    ? JSON.parse(existingRaw)
    : {
        reading: { attempts: 0, correct: 0, incorrect: 0, avgLatencyMs: null, latencySamples: [] },
        spelling: { correct: 0, attempts: 0 },
      };

  existing.wordHelper = existing.wordHelper || { timesLookedUp: 0 };
  existing.wordHelper.timesLookedUp += 1;
  existing.wordHelper.lastLookedUpAt = new Date().toISOString();

  await kv.put(key, JSON.stringify(existing));

  // Also append to today's session log
  await appendSessionLog(kv, word, null, null, "word-helper");
}

async function recordPassageAttempt(kv, passageId, { overallAccuracy, fluencyScore, completenessScore }) {
  const key = `${KV_PREFIX}passages:${passageId}`;
  const existingRaw = await kv.get(key);
  const existing = existingRaw ? JSON.parse(existingRaw) : { attempts: 0, bestAccuracy: 0 };

  existing.attempts += 1;
  existing.bestAccuracy = Math.max(existing.bestAccuracy, overallAccuracy);
  existing.lastAccuracy = overallAccuracy;
  existing.lastFluencyScore = fluencyScore;
  existing.lastCompletenessScore = completenessScore;
  existing.lastAttemptAt = new Date().toISOString();

  await kv.put(key, JSON.stringify(existing));

  // Also append to today's session log — passageId doubles as the item identifier,
  // same as how reading/spelling log an actual word.
  await appendSessionLog(kv, passageId, overallAccuracy >= WORD_SCORE_THRESHOLD, null, "passage");
}

async function handleTTS(request, env) {
  try {
    const url = new URL(request.url);
    const word = (url.searchParams.get("word") || "").toString().trim();
    const rate = url.searchParams.get("rate") === "slow" ? "-40%" : "0%";
    // Optional: space-separated SAPI phoneme codes (Azure's default phoneme alphabet,
    // matching what the recognizer returns) forcing exact pronunciation instead of
    // letting TTS guess from the spelled text — needed for isolated syllable/word
    // fragments that aren't valid English spelling on their own (e.g. "dence").
    // Whitelisted to letters/digits/spaces since it's going straight into an SSML attribute.
    const phonemesRaw = (url.searchParams.get("phonemes") || "").toString().trim();
    const phonemes = phonemesRaw.replace(/[^a-zA-Z0-9 ]/g, "").trim();

    if (!word) {
      return jsonResponse({ error: "Missing word" }, 400);
    }

    const trimmedKey = (env.AZURE_SPEECH_KEY || "").trim();
    const trimmedRegion = (env.AZURE_SPEECH_REGION || "").trim();
    if (!trimmedKey || !trimmedRegion) {
      return jsonResponse({ error: "Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION binding" }, 500);
    }

    const innerContent = phonemes
      ? `<phoneme alphabet="sapi" ph="${phonemes}">${escapeXml(word)}</phoneme>`
      : escapeXml(word);
    const ssml =
      `<speak version="1.0" xml:lang="en-US">` +
      `<voice name="en-US-JennyNeural"><prosody rate="${rate}">${innerContent}</prosody></voice>` +
      `</speak>`;

    let res;
    try {
      res = await fetch(`https://${trimmedRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": trimmedKey,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-16khz-32kbitrate-mono-mp3",
          "User-Agent": "star-reader-worker",
        },
        body: ssml,
      });
    } catch (networkErr) {
      console.error("Azure TTS fetch network error:", networkErr.message);
      throw new Error(`Azure TTS network error: ${networkErr.message}`);
    }

    if (!res.ok) {
      const errText = await res.text();
      console.error("Azure TTS API non-OK response:", res.status, errText);
      return jsonResponse({ error: "TTS failed", detail: errText }, 502);
    }

    return new Response(res.body, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
  } catch (err) {
    console.error("TTS error:", err && err.message);
    return jsonResponse({ error: "TTS failed", detail: err && err.message }, 500);
  }
}

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function assessPronunciation(audioBlob, targetWord, apiKey, region) {
  const trimmedKey = (apiKey || "").trim(); // secrets are whitespace-sensitive, per project notes
  const trimmedRegion = (region || "").trim();

  if (!trimmedKey || !trimmedRegion) {
    throw new Error("Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION binding");
  }

  const pronunciationConfig = {
    ReferenceText: targetWord,
    GradingSystem: "HundredMark",
    Granularity: "Phoneme",
    Dimension: "Comprehensive",
    EnableMiscue: true,
  };
  const pronunciationHeader = base64Encode(JSON.stringify(pronunciationConfig));

  const audioBuffer = await audioBlob.arrayBuffer();

  let res;
  try {
    res = await fetch(
      `https://${trimmedRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": trimmedKey,
          // Azure's short-audio REST endpoint only accepts "audio/wav; codecs=audio/pcm; samplerate=16000"
          // or "audio/ogg; codecs=opus" here. The client used to send raw MediaRecorder webm/opus bytes
          // labeled "audio/webm; codecs=opus" — not a supported value — which Azure would still return a
          // transcript for but silently mis-score on pronunciation accuracy. Client now encodes true 16kHz
          // mono PCM WAV, so this header must match that.
          "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
          "Pronunciation-Assessment": pronunciationHeader,
          Accept: "application/json",
        },
        body: audioBuffer,
      }
    );
  } catch (networkErr) {
    console.error("Azure Speech fetch network error:", networkErr.message);
    throw new Error(`Azure Speech network error: ${networkErr.message}`);
  }

  if (!res.ok) {
    const errText = await res.text();
    console.error("Azure Speech API non-OK response:", res.status, errText);
    throw new Error(`Azure Speech API error: ${res.status} ${errText}`);
  }

  const data = await res.json();

  if (data.RecognitionStatus !== "Success" || !data.NBest || !data.NBest.length) {
    // No speech recognized at all (silence, too quiet, etc.)
    return {
      transcript: "",
      wordAccuracy: 0,
      phonemes: [],
      syllables: [],
      words: [],
      recognitionStatus: data.RecognitionStatus || null,
      wordErrorType: null,
      fluencyScore: null,
      completenessScore: null,
      pronScore: null,
    };
  }

  const best = data.NBest[0];
  const transcript = (data.DisplayText || "").trim();
  // Pronunciation-assessment scores are flat properties directly on NBest[0]/Word/Phoneme —
  // not nested under a "PronunciationAssessment" sub-object, despite that being the request
  // header's name. Confirmed against a real response (a correctly-scored 100/100/100/100
  // "the" was coming back as all zeros/nulls before this fix because of that wrong nesting).
  const wordAccuracy = typeof best.AccuracyScore === "number" ? best.AccuracyScore : 0;

  // Flatten phonemes across all recognized words (usually just one, for a sight word)
  const phonemes = [];
  (best.Words || []).forEach((w) => {
    (w.Phonemes || []).forEach((p) => {
      phonemes.push({
        phoneme: p.Phoneme,
        accuracy: typeof p.AccuracyScore === "number" ? p.AccuracyScore : 0,
      });
    });
  });

  // Syllables carry a "Grapheme" — the actual spelled-out chunk (e.g. "cir"/"cum"/"stance"),
  // not a phonetic symbol — which is what lets the client show a kid-legible breakdown
  // instead of Azure's raw phoneme alphabet.
  //
  // sapiPhonemes reconstructs that same syllable's phonemes for TTS use instead: each
  // phoneme and syllable carries its own Offset/Duration, and a syllable's range spans
  // its phonemes' offsets, so grouping by offset gives the SAPI phoneme sequence for
  // just that syllable. Feeding that back into Azure TTS via an SSML <phoneme> tag
  // (same alphabet Azure's own recognizer used) forces correct pronunciation of an
  // isolated fragment — plain-text TTS on a fragment like "dence" or a single letter
  // like "i" guesses at spelling and gets it wrong (confirmed live: "i" read as the
  // word "eye", "dence" read as "denkay").
  const syllables = [];
  (best.Words || []).forEach((w) => {
    const wordPhonemes = (w.Phonemes || []).map((p) => ({
      phoneme: p.Phoneme,
      offset: typeof p.Offset === "number" ? p.Offset : 0,
    }));
    (w.Syllables || []).forEach((s) => {
      const sylOffset = typeof s.Offset === "number" ? s.Offset : 0;
      const sylEnd = sylOffset + (typeof s.Duration === "number" ? s.Duration : 0);
      const sapiPhonemes = wordPhonemes
        .filter((p) => p.offset >= sylOffset && p.offset < sylEnd)
        .map((p) => p.phoneme)
        .join(" ");
      syllables.push({
        grapheme: s.Grapheme || s.Syllable || "",
        accuracy: typeof s.AccuracyScore === "number" ? s.AccuracyScore : null,
        sapiPhonemes,
      });
    });
  });

  // ErrorType (from EnableMiscue) flags a word as "Insertion" when it's recognized
  // but doesn't align to the reference text — insertions get AccuracyScore forced to
  // 0 regardless of how well the word was actually said.
  const wordErrorType = best.Words && best.Words[0] ? best.Words[0].ErrorType || null : null;

  // Per-word accuracy (as opposed to the flat per-phoneme list above) — used by
  // passage scoring to say *which words* need another look, since phoneme-level
  // detail doesn't make sense to surface across a whole paragraph.
  const words = (best.Words || []).map((w) => ({
    word: (w.Word || "").toString(),
    accuracy: typeof w.AccuracyScore === "number" ? w.AccuracyScore : 0,
    errorType: w.ErrorType || null,
  }));

  return {
    transcript,
    wordAccuracy,
    phonemes,
    syllables,
    words,
    recognitionStatus: data.RecognitionStatus,
    wordErrorType,
    fluencyScore: typeof best.FluencyScore === "number" ? best.FluencyScore : null,
    completenessScore: typeof best.CompletenessScore === "number" ? best.CompletenessScore : null,
    pronScore: typeof best.PronScore === "number" ? best.PronScore : null,
  };
}

function base64Encode(str) {
  // Worker runtime supports btoa, but it only handles Latin1 — fine here since
  // the pronunciation config JSON is plain ASCII.
  return btoa(str);
}

async function recordAttempt(kv, word, { correct, latencyMs, transcript, wordAccuracy }) {
  const key = `${KV_PREFIX}words:${word}`;
  const existingRaw = await kv.get(key);
  const existing = existingRaw
    ? JSON.parse(existingRaw)
    : {
        reading: { attempts: 0, correct: 0, incorrect: 0, avgLatencyMs: null, latencySamples: [] },
        spelling: { correct: 0, attempts: 0 },
      };

  const reading = existing.reading;
  reading.attempts += 1;
  if (correct) {
    reading.correct += 1;
  } else {
    reading.incorrect += 1;
  }

  if (typeof latencyMs === "number" && !Number.isNaN(latencyMs)) {
    reading.latencySamples = reading.latencySamples || [];
    reading.latencySamples.push(latencyMs);
    // Keep a rolling window so this doesn't grow unbounded
    if (reading.latencySamples.length > 50) reading.latencySamples.shift();
    const sum = reading.latencySamples.reduce((a, b) => a + b, 0);
    reading.avgLatencyMs = Math.round(sum / reading.latencySamples.length);
  }

  reading.lastAttemptAt = new Date().toISOString();
  reading.lastTranscript = transcript;
  reading.lastWordAccuracy = wordAccuracy;

  await kv.put(key, JSON.stringify(existing));

  // Also append to today's session log
  await appendSessionLog(kv, word, correct, latencyMs, "sight-word");
}

// drillType tags the daily session log entry — "spelling" for the plain spelling
// drill, "game" for Apex Armada's cipher-breech input, which uses this exact same
// exact-match mastery mechanic rather than a parallel one.
async function recordSpellingAttempt(kv, word, correct, drillType = "spelling") {
  const key = `${KV_PREFIX}words:${word}`;
  const existingRaw = await kv.get(key);
  const existing = existingRaw
    ? JSON.parse(existingRaw)
    : {
        reading: { attempts: 0, correct: 0, incorrect: 0, avgLatencyMs: null, latencySamples: [] },
        spelling: { correct: 0, attempts: 0 },
      };

  const spelling = existing.spelling;
  spelling.attempts += 1;
  if (correct) spelling.correct += 1;
  spelling.lastAttemptAt = new Date().toISOString();

  await kv.put(key, JSON.stringify(existing));

  // Also append to today's session log
  await appendSessionLog(kv, word, correct, null, drillType);
}

async function appendSessionLog(kv, word, correct, latencyMs, drillType) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${KV_PREFIX}sessions:${today}`;
  const existingRaw = await kv.get(key);
  const session = existingRaw
    ? JSON.parse(existingRaw)
    : { date: today, drillTypes: [], items: [] };

  if (!session.drillTypes.includes(drillType)) {
    session.drillTypes.push(drillType);
  }
  session.items.push({
    drillType,
    word,
    correct,
    latencyMs,
    at: new Date().toISOString(),
  });

  await kv.put(key, JSON.stringify(session));
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withCors(response) {
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*"); // tighten to your app's origin before real use
  // GET was added for /api/tts and /api/sight-word/session-words, and X-Admin-Passcode
  // for the /api/admin/* routes. admin.html sends that custom header on its GET/POST
  // calls, which forces the browser to preflight — and the preflight response has to
  // list both the real method and the custom header or the browser blocks the actual
  // request outright (surfaces in JS as a generic failed-fetch, not an HTTP error).
  newHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  newHeaders.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Passcode");
  return new Response(response.body, { status: response.status, headers: newHeaders });
}
