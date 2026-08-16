# Seed word lists

Canonical, version-controlled source for the starter word lists that get seeded
into the Worker's KV store.

- `grade-6-7-vocabulary.txt` — 150 general academic (tier-2) vocabulary words
  appropriate to Dustin's actual 6th/7th grade curriculum (see TutorHub's unit
  titles — ELA, math, science, and social studies all land at this level).
  Earlier drafts of this file used Fry's Instant Words / Dolch sight words,
  which are early-elementary lists — too easy for his actual grade level —
  and were replaced with this one.

Each file is loaded into the Worker's KV word-list store via
`scripts/seed-wordlists.mjs`, which POSTs it to `/api/admin/wordlist` as its
own `source` batch (filename minus extension). These are the same rules
`admin.html` uses when a source is pasted in by hand, so seeding here and
adding more later through the admin page compose the same way — the
session-words endpoint pools every batch together.

To add more later: drop another `.txt` file here (words separated by commas
and/or newlines) and re-run the seed script — it's safe to re-run, each
source overwrites its own KV entry.
