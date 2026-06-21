# Luma — presentation toolbox for Figma

Luma is a designer's quick-action toolbox for building presentation decks. Each tool
does a multi-step chore in **one click**. No AI, no network — just deterministic
operations on your frames and prototype connections.

## Tools

- **Slide Flow** (flagship) — select frames, click once, and Luma wires them in order
  with prototype reactions. Choose the transition (Smart Animate / Dissolve / Move /
  Slide / Push), easing (presets, spring presets, or a custom curve), duration, and
  trigger (on click · arrow keys · auto-advance). Optional loop and arrow-key "back".
  It also sets the flow's starting point so **Present** mode just works.
- **Easing Studio** — a draggable cubic-bezier editor with a live preview. The curve
  you shape becomes the "Custom" easing in Slide Flow.
- **Page Numbers** — add/update a number on every slide (formats `1` · `1/N` ·
  `Slide 1`), positionable, skip-cover option. Re-run to refresh.
- **Layout** — normalize all selected frames to one size, and tidy them into an even
  left-to-right row.
- **More** (coming soon) — reorder manager, frame-to-frame morph, table-of-contents.

## Architecture

| Layer | File | Runs in | Has `figma.*`? |
|---|---|---|---|
| Engine | [src/actions.ts](src/actions.ts) | main thread | yes |
| Dispatcher | [src/code.ts](src/code.ts) | main thread | yes |
| UI | [ui.html](ui.html) | iframe | no (posts messages) |

The UI posts a typed message per tool (`connect-slides`, `page-numbers`, `normalize`,
`tidy`); `code.ts` runs the matching engine function and reports the result back.

The flagship uses Figma's prototyping API: `node.setReactionsAsync([{ trigger, actions:
[{ type: "NODE", navigation: "NAVIGATE", transition: { type: "SMART_ANIMATE", easing,
duration } }] }])`.

## Requirements

- **Figma desktop app** (plugin development / "Import from manifest" is desktop-only).
- **Node.js 18+** and npm (to build the plugin bundle).
- No API keys, accounts, or network access — Luma runs 100% on-canvas.

## Install

Luma isn't on the Figma Community yet, so you install it as a local development
plugin. One-time setup:

1. **Clone the repo**
   ```bash
   git clone https://github.com/Ferosnow95/luma-figma.git
   cd luma-figma
   ```
2. **Install dependencies**
   ```bash
   npm install
   ```
3. **Build the plugin bundle** (produces `dist/code.js`)
   ```bash
   npm run build
   ```
4. **Import into Figma** — open the Figma **desktop** app, then:
   **Menu → Plugins → Development → Import plugin from manifest…** and select the
   `manifest.json` at the root of this repo.
5. Luma now appears under **Plugins → Development → Luma**. Run it from there (or
   right-click the canvas → **Plugins → Development → Luma**).

> **Updating:** after `git pull`, run `npm run build` again and reload the plugin
> in Figma (it re-reads `dist/code.js` on each run).

## How to use

Open a file with frames you want to present, then run Luma. The panel groups tools
in a left icon rail (**Flow · Motion · Numbers · Layout · More**).

### Slide Flow — connect your deck (start here)
1. On the canvas, **select the frames** you want in your deck (or select a Section /
   nothing to use all top-level frames on the page).
2. Open the **Flow** tab. Pick the **order** (reading order or natural name sort),
   **transition**, **easing**, **duration**, and **trigger** (on click · arrow keys ·
   auto-advance). Optionally enable **loop** and arrow-key **back**.
3. Click **Connect slides.** Luma wires every frame to the next with prototype
   reactions and sets the flow's starting point.
4. Press **▶ Present** in Figma — your deck advances with the transitions you chose.

> Tip: drag the rows in the sequence list to reorder, double-click a name to rename,
> or drop a frame into a **Section** to park it as an animation "branch" sandbox.

### Easing Studio (Motion tab)
Drag the two handles of the cubic-bezier curve to shape your motion, or pick a preset.
The curve becomes the **Custom** easing used by Slide Flow. The preview ball plays your
curve so you can feel the timing before applying it.

### Page Numbers (Numbers tab)
Choose a format (`1` · `1 / N` · `Slide 1`), a position, and whether to skip the cover,
then click apply. Re-run any time to refresh numbering after you add or reorder slides.

### Layout (Layout tab)
- **Normalize** — resize all selected frames to one common size.
- **Tidy** — arrange them in an even left-to-right row with a set gap.

### Polish (one-click macro)
Runs your chosen steps in sequence — normalize → tidy → number → connect — so a rough
set of frames becomes a presentable, wired deck in a single click.

## Develop

```bash
npm install
npm run watch      # esbuild bundles src/code.ts -> dist/code.js (IIFE), rebuild on change
npm run typecheck  # tsc, type-check only (no emit)
```

> **Must bundle with esbuild** (`--format=iife`). Figma's sandbox runs one
> non-module script; raw `tsc` ES-module output fails at launch with a syntax error.

With `npm run watch` running, edit `src/*.ts` / `ui.html`, then re-run the plugin in
Figma to pick up the rebuilt bundle.

## License

MIT
