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
| `trex-idle.gif` | Ambient dino sprite, drawn every frame on the canvas scene | Extracted from Erica's Gemini-generated space-cockpit video. Replace with a cleaner asset any time — same filename, same treatment (animated GIFs play fine when drawn to `<canvas>` every frame). |
| `trex-hit.gif` | Swaps in for ~2.2s during the "Direct hit!" celebration | |
| `trex-defeated.gif` | Shown on the end-of-session screen (plain `<img>`, not canvas) | |

All three current `trex-*.gif` files are cropped/recompressed frames from the source video (`/root/.claude/uploads/.../gemini_generated_video_4B840A2F.mp4`) — a placeholder upgrade over the plain emoji, not final art. Swap any of them out any time by dropping in a new file with the same name.

Keep file sizes modest — these load over the same connection as everything
else on a phone, no lazy-loading/CDN here.
