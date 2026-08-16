# Apex Armada media assets

`apex-armada.html` looks for these exact filenames here. None are required —
every reference has a graceful fallback (silent no-op for audio, the original
emoji for the missing gif), so the game works today with none of these
present. Drop a file in with the matching name and it's picked up automatically
on next page load, no code changes needed.

| File | Used for | Notes |
|---|---|---|
| `battle-music.mp3` | Optional looping background music | Toggleable in-game; starts muted-by-default-until-tapped per browser autoplay rules. Keep it loop-friendly (no long silence at the start/end). |
| `hit-roar.mp3` | Plays ~2-3s on a correct answer | |
| `dino-roar.mp3` | Plays on each miss, as the T-Rex creeps closer | |
| `trex.gif` | Replaces the 🦖 emoji sprite in the ambient scene | Animated GIFs play fine when drawn to `<canvas>` every frame. Roughly square, transparent background preferred so it blends into the ocean scene. |

Keep file sizes modest — these load over the same connection as everything
else on a phone, no lazy-loading/CDN here.
