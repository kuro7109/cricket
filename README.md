# Cricket — Minimal

A modern, minimal, dark-UI remake of the classic Nokia Cricket game. Plain HTML, CSS and JavaScript — no build step, no dependencies.

## Play

- **Timing** — press a shot just as the ball reaches the bat. You get a ~140 ms window; the closer to perfect, the bigger the hit.
- **Direction** — match the line: off-side balls → **Off**, leg-side → **Leg**. Short balls love a pull; yorkers want a block.
- **Risk** — lofted shots go for six or get caught; blocks are safe but slow. Leave a ball on the stumps and you're bowled.

| Shot  | Keys            | Nokia keypad |
|-------|-----------------|--------------|
| Leg   | ← / A           | 4            |
| Loft  | ↑ / W           | 2            |
| Block | ↓ / S / Space   | 8 or 5       |
| Off   | → / D           | 6            |

`P` pause · `M` mute · `Enter` start. On touch screens, use the four buttons.

## Features

- Chase a target or free play · 1/2/5/10 overs · 1/3/5/10 wickets · slow/medium/fast bowler
- Random lengths (yorker → bouncer), line, swing and the odd wide
- Live scoreboard, required rate, ball-by-ball over strip, millisecond timing feedback
- Wagon wheel and stats at the end of each innings, best score saved per setup
- Nokia-style beeps, haptics on mobile, auto-pause when the tab is hidden

## Run locally

Open `index.html` in a browser, or serve the folder:

```bash
npx serve .
```
