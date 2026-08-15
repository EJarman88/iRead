# Seed word lists

Canonical, version-controlled source for the starter sight-word lists. These are
standard, public-domain-style high-frequency word lists used across reading
instruction (Fry's Instant Words, Dolch sight words) — not scraped from any
proprietary source.

- `fry-1st-100.txt` — Edward Fry's first 100 Instant Words
- `dolch-pre-primer.txt` — Dolch pre-primer list (40 words)
- `dolch-primer.txt` — Dolch primer list (52 words)
- `dolch-1st-grade.txt` — Dolch 1st grade list (41 words)

Each file is loaded into the Worker's KV word-list store via
`scripts/seed-wordlists.mjs`, which POSTs it to `/api/admin/wordlist` as its
own `source` batch (filename minus extension). These are the same rules
`admin.html` uses when a source is pasted in by hand, so seeding here and
adding more later through the admin page compose the same way — the
session-words endpoint pools every batch together.

To add more later: drop another `.txt` file here (words separated by commas
and/or newlines) and re-run the seed script — it's safe to re-run, each
source overwrites its own KV entry.
