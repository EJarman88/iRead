/**
 * Star Reader — Cloudflare Worker
 * Sight-word drill scoring endpoint.
 *
 * Bindings expected (set in wrangler.toml / dashboard):
 *   TUTOR_KV            - KV namespace (shared with TutorHub)
 *   AZURE_SPEECH_KEY    - encrypted secret, Azure Speech resource key (reused from TutorHub TTS)
 *   AZURE_SPEECH_REGION - plain text var, e.g. "eastus" (must match the TutorHub Azure Speech resource's region)
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
 * Route: GET /api/tts?word=<word>&rate=slow|normal
 *   Returns audio/mpeg — the target word spoken via Azure TTS (reuses the same Speech
 *   resource as scoring). Used for the "listen for the sound" hint on a second miss.
 *   Isolated single-phoneme audio isn't attempted here — TTS engines can't reliably
 *   produce a standalone consonant sound, so the reliable version of "listen for it"
 *   is the whole word spoken slowly.
 *
 * Route: GET /api/sight-word/session-words
 *   Public, no gate. Returns { words: string[], source } — the word set for a drill
 *   session, pulled from whatever the admin has loaded into reading:dustin:wordlist:*.
 *   No adaptive/spaced-repetition selection yet (that's a later build step per the
 *   project doc) — just a random sample across everything loaded so far. Falls back
 *   to a small built-in default list if nothing's been loaded yet.
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/api/sight-word/score" && request.method === "POST") {
      return withCors(await handleScore(request, env));
    }

    if (url.pathname === "/api/tts" && request.method === "GET") {
      return withCors(await handleTTS(request, env));
    }

    if (url.pathname === "/api/sight-word/session-words" && request.method === "GET") {
      return withCors(await handleSessionWords(request, env));
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

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function handleSessionWords(request, env) {
  try {
    const listResult = await env.TUTOR_KV.list({ prefix: `${KV_PREFIX}wordlist:` });

    if (!listResult.keys.length) {
      return jsonResponse({ words: DEFAULT_SESSION_WORDS, source: "default" });
    }

    const seen = new Set();
    const allWords = [];
    for (const k of listResult.keys) {
      const raw = await env.TUTOR_KV.get(k.name);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      (parsed.words || []).forEach((w) => {
        if (!seen.has(w)) {
          seen.add(w);
          allWords.push(w);
        }
      });
    }

    if (!allWords.length) {
      return jsonResponse({ words: DEFAULT_SESSION_WORDS, source: "default" });
    }

    // Bootstrap phase: no adaptive/spaced-repetition selection yet (that's a later
    // build step) — just a random sample across everything the admin has loaded.
    const selected = shuffle(allWords).slice(0, Math.min(SESSION_WORD_COUNT, allWords.length));
    return jsonResponse({ words: selected, source: "wordlist" });
  } catch (err) {
    console.error("Session words error:", err && err.message);
    return jsonResponse({ words: DEFAULT_SESSION_WORDS, source: "default-error" });
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

async function handleTTS(request, env) {
  try {
    const url = new URL(request.url);
    const word = (url.searchParams.get("word") || "").toString().trim();
    const rate = url.searchParams.get("rate") === "slow" ? "-40%" : "0%";

    if (!word) {
      return jsonResponse({ error: "Missing word" }, 400);
    }

    const trimmedKey = (env.AZURE_SPEECH_KEY || "").trim();
    const trimmedRegion = (env.AZURE_SPEECH_REGION || "").trim();
    if (!trimmedKey || !trimmedRegion) {
      return jsonResponse({ error: "Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION binding" }, 500);
    }

    const ssml =
      `<speak version="1.0" xml:lang="en-US">` +
      `<voice name="en-US-JennyNeural"><prosody rate="${rate}">${escapeXml(word)}</prosody></voice>` +
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
  const syllables = [];
  (best.Words || []).forEach((w) => {
    (w.Syllables || []).forEach((s) => {
      syllables.push({
        grapheme: s.Grapheme || s.Syllable || "",
        accuracy: typeof s.AccuracyScore === "number" ? s.AccuracyScore : null,
      });
    });
  });

  // ErrorType (from EnableMiscue) flags a word as "Insertion" when it's recognized
  // but doesn't align to the reference text — insertions get AccuracyScore forced to
  // 0 regardless of how well the word was actually said.
  const wordErrorType = best.Words && best.Words[0] ? best.Words[0].ErrorType || null : null;

  return {
    transcript,
    wordAccuracy,
    phonemes,
    syllables,
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
  await appendSessionLog(kv, word, correct, latencyMs);
}

async function appendSessionLog(kv, word, correct, latencyMs) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${KV_PREFIX}sessions:${today}`;
  const existingRaw = await kv.get(key);
  const session = existingRaw
    ? JSON.parse(existingRaw)
    : { date: today, drillTypes: [], items: [] };

  if (!session.drillTypes.includes("sight-word")) {
    session.drillTypes.push("sight-word");
  }
  session.items.push({
    drillType: "sight-word",
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
