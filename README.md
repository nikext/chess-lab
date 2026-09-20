# Chess Lab

A local tool for studying chess positions, with two engines that disagree in
interesting ways:

- **Stockfish 19 (WASM)** — real search, runs entirely in your browser, no API.
  This is what tells you the strongest move.
- **Jev (TypeSafe AI)** — a System One model. No search: one forward pass that
  returns a calibrated probability distribution over the legal moves. This is
  *intuition*, and comparing it against Stockfish is the point of the app.

Two tabs:

**Analyse** — load a position from a FEN, a PGN, or a screenshot. Stockfish's
top lines are drawn as arrows (green best, blue second). Jev's pick gets an
amber arrow whenever it disagrees, alongside its probability mass, its own
positional read, and a "is the side to move in trouble" gauge.

**Play Jev** — play a full game against Jev as the move policy. Set it to take
its top pick, or to sample from its distribution, which gives more varied and
more human-looking games. An optional Stockfish eval shows how it is going.

## Scope

This reads positions you give it — a diagram from a book, a frame from a video,
a game that has already finished. It is deliberately not wired to a live game
in progress: pointing an engine at an opponent you are currently playing is
cheating, and chess.com and lichess both treat it that way.

## Setup

```bash
npm install
cp .env.example .env     # then put your real key in it
npm run dev              # http://127.0.0.1:5183
```

`.env`:

```
JEV_API_KEY=sk-ts-...
JEV_MODEL=jev-latest
```

The key is read by the Vite dev server and attached to requests server-side.
It is deliberately **not** `VITE_`-prefixed, so it never gets inlined into the
browser bundle. Restart the dev server after changing it.

Stockfish works with no key and no network.

## Importing a position from a screenshot

Board recognition is self-calibrating. There are no bundled piece templates,
because every site renders its own sprite set and bundled ones go stale.

**One-time, per site/theme:**

1. Screenshot the **starting position** on the site you use.
2. *Import screenshot…* → drop it in. The board is detected automatically;
   drag a square over it or nudge with the arrow buttons if it is off.
3. Name the theme (`lichess brown`, `chess.com green`) and hit **Calibrate**.

That single screenshot contains a labelled example of all twelve piece types,
which is enough to recognise any later position in that theme.

**After that:** drop in any screenshot, pick the theme, *Read the board*.
Squares the classifier was unsure about are outlined in amber. Click any square
to correct it — corrections are folded back into the theme, so the same mistake
does not recur.

Orientation cannot be recovered from pixels alone (a board looks the same
either way up), so it is guessed from material placement and there is a **Flip**
button when the guess is wrong. Side-to-move and castling rights aren't in the
image either; castling is inferred from home-square occupancy and both are
editable before you use the position.

Themes live in `localStorage`, so they are per-browser.

## Tests

```bash
npm run dev      # in one terminal
npm test         # in another
```

- `npm run selftest` — renders synthetic boards at several sizes, palettes and
  contrasts, then checks detection accuracy, calibration, per-square
  recognition, and that a flipped board reconstructs the same FEN. Open
  `/selftest.html` in a browser to see the rendered cases.
- `npm run smoke` — drives the real app: Stockfish boots and reaches depth,
  multipv lines and arrows appear, the Jev panel degrades gracefully with no
  key, and the console stays clean.

## How Jev is asked

All three questions go in a single request — TypeSafe's docs note batching is
roughly 12x cheaper and 10x faster than asking serially, and questions are
evaluated in parallel and in isolation.

| Question | Type | What it returns |
|---|---|---|
| `move` | `choice` over every legal move in SAN | the pick, a probability per move, a confidence |
| `evaluation` | `score` over a 7-level rubric | a fractional position on that scale |
| `danger` | `noul` | 0–1 that the side to move faces a real threat |

The `choice` type accepts up to 255 options; chess tops out at 218 legal moves,
so the full move list is always sent rather than a shortlist.

See `src/lib/jev.ts`.

## Layout

```
src/lib/stockfish.ts    UCI driver for the WASM engine
src/lib/jev.ts          Jev client, question construction
src/lib/fen.ts          labels -> FEN, orientation and castling inference
src/lib/pv.ts           UCI <-> SAN helpers
src/vision/board.ts     board detection, per-cell feature extraction
src/vision/templates.ts template bank, calibration, persistence
src/components/         UI
```
