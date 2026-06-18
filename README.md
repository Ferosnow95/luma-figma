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

## Develop

```powershell
cd figma-plugin
npm install
npm run watch      # esbuild bundles src/code.ts -> dist/code.js (IIFE)
npm run typecheck  # tsc, no emit
```

> **Must bundle with esbuild** (`--format=iife`). Figma's sandbox runs one
> non-module script; raw `tsc` ES-module output fails at launch with a syntax error.

Then in Figma desktop: **Plugins → Development → Import plugin from manifest…** and
pick `figma-plugin/manifest.json`.
