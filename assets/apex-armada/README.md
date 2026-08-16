# Apex Armada media assets

`apex-armada.html` looks for these exact filenames here. None are required —
every reference has a graceful fallback (silent no-op for audio, the original
emoji for the missing gif), so the game works today with none of these
present. Drop a file in with the matching name and it's picked up automatically
on next page load, no code changes needed.

| File | Used for | Notes |
|---|---|---|
| `battle-music.mp3` | Optional looping background music | Toggleable in-game; starts muted-by-default-until-tapped per browser autoplay rules. Keep it loop-friendly (no long silence at the start/end). |
| `hit-roar.mp3` | Plays ~2-3s on a correct answer, alongside `trex-hit.gif` | |
| `dino-roar.mp3` | Plays on each miss, as the T-Rex creeps closer | |
| `cockpit-bg.jpg` | Full-bleed background, drawn cover-fit on the canvas every frame | Real generated art (Erica/Gemini), landscape (~1365×768 source). Falls back to a hand-drawn starfield/gradient if missing. |
| `trex-hero.png` | Static "idle" dino sprite, drawn over the cockpit-bg window area | Transparent PNG cutout, not animated — replaced the old `trex-idle.gif` for this role since it's higher quality. Falls back to the 🦖 emoji if missing. |
| `trex-hit.gif` | Full-screen cutscene for ~2.2s on a correct answer | |
| `trex-defeated.gif` | Full-screen cutscene once at the end of a session, before the summary screen reveals | |
| `trex-miss-final.gif` | Full-screen cutscene for ~2.8s at the 3rd-miss "regroup" beat | The dino briefly looms large/dominant, then falls back — no session restart, no lost progress, matching the app's no-loss-state rule. |
| `trex-idle.gif` | **No longer referenced** by `apex-armada.html` | Left in the repo unused rather than deleted, in case it's wanted again — `trex-hero.png` replaced its role. |

The `trex-hit.gif`/`trex-defeated.gif`/`trex-miss-final.gif` clips are cropped/recompressed frames from source videos Erica generated — placeholder quality, not final art. `cockpit-bg.jpg` and `trex-hero.png` are real generated art and are being treated as the actual assets, not placeholders, though still swappable any time by dropping in a new file with the same name — the layout is built around this specific background's proportions (open "window" area up top, console area at the bottom), so a replacement background should keep roughly the same composition for the dino/UI positioning to still line up.

The three event clips play as **full-screen cutscenes** (`#cutsceneOverlay`,
`object-fit: cover`, above the whole game UI) rather than swapping the small
in-scene dino sprite — so any replacement for these three specifically should
be composed to work cropped edge-to-edge at whatever aspect ratio the
player's screen happens to be, not framed like a small sprite.

Keep file sizes modest — these load over the same connection as everything
else on a phone, no lazy-loading/CDN here. (`cockpit-bg.jpg` was converted
from a 1.2MB PNG to an ~80KB JPEG since it has no transparency needs.)
