---
name: figma-plugin-builder
description: >
  Hard-won, battle-tested knowledge for building ANY Figma plugin in
  TypeScript. Covers project scaffolding, the esbuild bundling requirement,
  the main-thread/UI split and message passing, the prototyping/reactions API,
  the dynamic-page document model, coordinate-system rules (the #1 source of
  bugs), fonts, thumbnails, node tagging, live document watchers, the Figma UI3
  design system, and a long list of gotchas that each cost real debugging time.
  Read this BEFORE writing a new Figma plugin so you start from working patterns
  instead of rediscovering the traps.
---

# Building Figma plugins — a practitioner's skill

This is a generalized playbook extracted from shipping the **Luma** presentation
toolbox plugin. Everything here is verified against real Figma runtime behavior,
not just the docs. When a rule is marked **GOTCHA**, it caused an actual bug.

---

## 1. Mental model: two isolated worlds

A Figma plugin is **two separate JavaScript contexts** that can only talk via
async messages:

| Context | Runs in | Has access to | Cannot |
|---|---|---|---|
| **Main / sandbox** (`code.js`) | Figma's plugin sandbox | `figma.*` API, the document, nodes | DOM, `window`, most network |
| **UI** (`ui.html` iframe) | A normal browser iframe | DOM, `fetch`, `window` | `figma.*`, the document |

They communicate **only** through message passing:

```ts
// main thread -> UI
figma.ui.postMessage({ type: "selection", info });
// UI -> main thread
parent.postMessage({ pluginMessage: { type: "run", options } }, "*");
// main thread receives
figma.ui.onmessage = (msg) => { /* dispatch by msg.type */ };
// UI receives
window.onmessage = (e) => { const msg = e.data.pluginMessage; };
```

**Architecture that scales well** (this is the Luma layout, recommend it):

- `src/actions.ts` — the **engine**: pure, exported async functions that take
  plain options and do all `figma.*` work. One function per capability. No UI.
- `src/code.ts` — the **dispatcher**: `figma.showUI`, a `figma.ui.onmessage`
  switch that maps `msg.type` → an engine function, then `figma.notify(...)` and
  posts a `{ type: "done", message }` back. Also pushes selection context.
- `ui.html` — the **view**: a single self-contained HTML file (inline `<style>`
  and `<script>`, vanilla JS, one `state` object). Posts typed messages, renders
  responses. Ships as-is (no build step for UI-only edits).

Keeping the engine UI-agnostic means you can unit-reason about it, reuse it
(e.g. across a plugin and a widget), and the dispatcher stays a thin switch.

---

## 2. Scaffolding & manifest

`manifest.json` essentials:

```json
{
  "name": "My Plugin",
  "id": "unique-reverse-dns-id",
  "api": "1.0.0",
  "main": "dist/code.js",
  "ui": "ui.html",
  "editorType": ["figma"],
  "documentAccess": "dynamic-page",
  "networkAccess": { "allowedDomains": ["none"] },
  "relaunchButtons": [{ "command": "open", "name": "Open My Plugin" }]
}
```

- `editorType`: `["figma"]`, `["figjam"]`, and/or `["dev"]`. Pick what you support.
- `networkAccess.allowedDomains`: use `["none"]` for fully on-canvas plugins.
  List explicit `https://` domains if the UI calls APIs. This is enforced.
- `documentAccess: "dynamic-page"` is the modern default and changes the API —
  see §5. It is worth understanding before you write any node code.
- Import into Figma via **Plugins → Development → Import plugin from manifest**.

---

## 3. The build: you MUST bundle to an IIFE

**GOTCHA (launch-blocking):** The Figma sandbox runs **one classic script**. It
does not support ES modules. If you ship raw `tsc` output with `import`
statements you get `Syntax error on line N: Unexpected token` the instant the
plugin launches.

**Fix:** bundle with esbuild into a single IIFE. `tsc` is used only for type
checking (`--noEmit`).

`package.json` scripts (proven):

```json
{
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "esbuild src/code.ts --bundle --format=iife --target=es2017 --outfile=dist/code.js",
    "watch": "esbuild src/code.ts --bundle --format=iife --target=es2017 --outfile=dist/code.js --watch"
  },
  "devDependencies": {
    "@figma/plugin-typings": "^1.100.0",
    "esbuild": "^0.23.0",
    "typescript": "^5.5.0"
  }
}
```

esbuild inlines `actions.ts` into the single `code.js` IIFE. Always run
`npm run typecheck && npm run build` after edits.

`tsconfig.json` gotchas:

- **Do NOT include `"DOM"` in `lib`.** The DOM lib's globals (`console`, `fetch`,
  etc.) conflict with `@figma/plugin-typings` and produce confusing type errors
  in the main thread. Target the figma typings only.
- Set `"noEmit": true` (esbuild emits, not tsc).
- `typeRoots`/`types` should point at `@figma/plugin-typings`.
- For widgets you additionally need `@figma/widget-typings` and JSX settings.

**Ignore these harmless launch warnings** — they come from Figma's own host
page, not your code: "Unload event listeners are deprecated", "Quirks Mode".

---

## 4. The message/dispatch pattern (copy this)

Main thread:

```ts
figma.showUI(__html__, { width: 380, height: 640, themeColors: true, title: "My Plugin" });

figma.ui.onmessage = async (msg) => {
  try {
    switch (msg.type) {
      case "do-thing": {
        const result = await doThing(msg.options);
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      // ...
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    figma.notify(message, { error: true });
    figma.ui.postMessage({ type: "error", message });
  }
};
```

- Wrap the whole dispatch in try/catch so engine `throw new Error("...")` becomes
  a user-facing toast + a UI `error` message. Engine functions should throw with
  **plain, human-readable** messages ("Select exactly 2 layers").
- Standardize on `{ type: "done", message }` for success and
  `{ type: "error", message }` for failure so the UI has one status sink.

---

## 5. dynamic-page document model (modern API)

With `documentAccess: "dynamic-page"`, pages/nodes are loaded lazily. This
changes several APIs from their old synchronous forms:

- **`figma.getNodeByIdAsync(id)`** instead of `getNodeById`. Always `await` it,
  and null-check the result (the node may have been deleted).
- To traverse or touch other pages you must **`await figma.loadAllPagesAsync()`**
  first.
- **GOTCHA:** You **cannot** register `figma.on("documentchange", ...)` at
  startup in dynamic-page mode. It throws: *"Cannot register documentchange
  handler in incremental mode without calling figma.loadAllPagesAsync first."*
  Fix: lazily `await figma.loadAllPagesAsync()` once, then register the handler
  (do it the first time you actually need the watcher, not on boot).
- Reading reactions/destinations: a reaction's `destinationId` must be resolved
  via `getNodeByIdAsync` — you can't assume the node object is in hand.

---

## 6. Coordinates — the #1 source of bugs

Read this twice. Figma's coordinate semantics are the most common cause of
"my element flew off to (480, 34250)".

- A node's `x`/`y` are **relative to its parent**.
- **GOTCHA / hard-won:** A **Section's children have coordinates relative to the
  section**, because a section behaves like a group for transforms — NOT like an
  absolute container. Assuming page-absolute coords for section children will
  fling them far away. When you append a child to a section, set **small
  section-local** offsets.
- For any **cross-hierarchy** placement (moving/cloning a node from one parent to
  another and keeping it visually in the same spot), do not reason about `x/y`.
  Use **`absoluteBoundingBox`** (always null-guard it) and the robust pattern:

```ts
// Place `node` so its absolute position lands at (targetAbsX, targetAbsY)
parent.appendChild(node);              // reparent first
const b = node.absoluteBoundingBox;    // measure AFTER reparenting
if (b) {
  node.x += targetAbsX - b.x;
  node.y += targetAbsY - b.y;
}
```

- To preserve a child's position **relative to a container** across slides:
  `offset = childAbs - containerAbs` on the source, then
  `targetChildAbs = targetContainerAbs + offset`, then apply the delta pattern above.
- `absoluteBoundingBox` is `null` for nodes not yet in the scene or with no
  geometry — always guard.
- For rotation-free line/arrow drawing, place a rectangle via `relativeTransform`
  `[[cos,-sin,p1.x],[sin,cos,p1.y]]` with `cos=dx/len, sin=dy/len` to avoid
  rotation-pivot ambiguity.

---

## 7. Prototyping / reactions (slide flows, click-throughs)

Wiring interactions is done with `setReactionsAsync`:

```ts
await frame.setReactionsAsync([{
  trigger: { type: "ON_CLICK" },
  actions: [{
    type: "NODE",
    destinationId: nextFrame.id,
    navigation: "NAVIGATE",
    transition: { type: "SMART_ANIMATE", easing: { type: "EASE_OUT" }, duration: 0.3 },
    preserveScrollPosition: false,
  }],
}]);
```

- Triggers: `ON_CLICK`, `ON_KEY_DOWN` (`{ device: "KEYBOARD", keyCodes: [39] }`
  — 39=Right, 37=Left), `AFTER_TIMEOUT` (`{ timeout: seconds }`).
- Transitions: `SMART_ANIMATE` / `DISSOLVE` (simple), or directional
  `MOVE_IN`/`SLIDE_IN`/`PUSH` (need `direction` + `matchLayers`). `duration` is in
  **seconds** (ms/1000).
- Easing: presets `EASE_*`/`LINEAR`, spring presets `GENTLE`/`QUICK`/`BOUNCY`/`SLOW`,
  or `CUSTOM_CUBIC_BEZIER { x1, y1, x2, y2 }`.
- Set `figma.currentPage.flowStartingPoints` so Present mode has an entry point.
- A back-button that coexists with any forward trigger: always wire it to the
  **Left-arrow** key so it doesn't clash with the forward trigger.
- **GOTCHA (TS):** a `switch` over the `Transition` union that's exhaustive makes
  the `default` branch's parameter type `never` — don't access `.type` there
  (TS2339); just return a constant.
- Smart Animate matches layers by **name**: two layers across frames morph into
  each other only if they share a name. "Rename to match" is a real, useful tool.

---

## 8. Fonts: load before you touch text

**GOTCHA:** Any text mutation (including creating a `TextNode` and setting
`characters`) throws unless the font is loaded first:

```ts
await figma.loadFontAsync({ family: "Inter", style: "Regular" });
text.characters = "Hello";
```

When editing existing text, load **every** font the node uses (mixed fonts are
possible) before changing characters.

---

## 9. Thumbnails (render node previews in the UI)

The UI iframe can't read the document, so render thumbnails on the main thread
and send data URLs:

```ts
const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "WIDTH", value: 160 } });
const url = "data:image/png;base64," + figma.base64Encode(bytes);
figma.ui.postMessage({ type: "thumbs", list: [{ id: node.id, url }] });
```

- `figma.base64Encode(Uint8Array)` exists on the **main thread** (use it here).
- `exportAsync` constraint `type` is `"WIDTH" | "HEIGHT" | "SCALE"`.
- Cache by node id in the UI; only request thumbnails you don't already have.

---

## 10. Tagging nodes you create (pluginData)

To recognize/clean up your own nodes later, stamp them:

```ts
node.setPluginData("my-plugin-mark", "1");
// later
node.getPluginData("my-plugin-mark") === "1";
```

Use this to (a) skip your own helper nodes when scanning the document, and
(b) find-and-remove all of them on cleanup. It's also how you store small bits of
structured state on a node (JSON in a pluginData string).

---

## 11. Live document watchers without infinite loops

If you redraw on-canvas helpers when the user edits (e.g. live motion paths):

- Register `figma.on("documentchange", handler)` (after `loadAllPagesAsync`, §5).
- **GOTCHA:** `documentchange` fires for **your own** mutations too. Naively
  redrawing inside the handler → infinite loop. Guard it:
  - **Debounce** with `setTimeout` (yes, `setTimeout` is available in the main
    thread), e.g. 120 ms.
  - Set a `suppressUntil = Date.now() + 350` right before you mutate, and ignore
    events while `Date.now() < suppressUntil`.
  - Keep a `live` boolean flag; bail when off. Stop watching if a referenced node
    disappears (resolve stored ids each redraw; `false` → stop).

---

## 12. Selection plumbing (and the self-select trap)

Push selection context to the UI so it can react:

```ts
function pushSelection() {
  figma.ui.postMessage({ type: "selection", info: getDeckInfo() });
}
figma.on("selectionchange", pushSelection);
pushSelection(); // initial
```

**GOTCHA (the self-select trap):** When the UI lets the user click a list row to
select that node on canvas, your own `figma.currentPage.selection = [...]` fires
a `selectionchange`, which posts back a `selection` message, which can collapse
the list the user built. Fix with a **`selfSelecting` flag**: set it `true`
right before you self-select; in the UI's selection handler, if `selfSelecting`
is set, clear it and **skip** the reconcile. Add a `force: true` field on
messages where you DO want the UI to resync regardless.

Also: `figma.currentPage.selection` is in **document order, not click order**.
If a tool needs "source first, then target", document that the order is by layer
stacking, not the order the user clicked.

---

## 13. The UI: design system & patterns

**Use Figma's UI3 design tokens** so the plugin matches light/dark automatically.
`showUI(..., { themeColors: true })` injects `--figma-color-*` CSS variables.
Map your own semantic vars to them with fallbacks:

```css
:root {
  --bg: var(--figma-color-bg, #fff);
  --bg-secondary: var(--figma-color-bg-secondary, #f5f5f5);
  --brand: var(--figma-color-bg-brand, #0d99ff);
  --text: var(--figma-color-text, #000);
  --muted: var(--figma-color-text-secondary, #666);
  --stroke: var(--figma-color-border, #e6e6e6);
  --danger: var(--figma-color-text-danger, #e03e3e);
}
```

Visual language that reads as native Figma: flat surfaces, 6–8px radii, 12px base
font, a single blue accent (`#0d99ff`), native-feeling segmented controls, chips,
toggles, and sliders. Avoid heavy gradients/glass.

UI structure that worked: a left **icon rail** of tabs + a scrollable main column
+ a footer **status line**. One `state` object; render functions per section;
`$(id)` helper; delegate by `msg.type` in `window.onmessage`. Cards group related
controls. Provide a drag-to-resize grip that posts `{ type: "resize", width,
height }` → `figma.ui.resize(...)` (enforce a min size).

Interaction niceties that users asked for repeatedly:
- Inline rename: double-click a label → swap to an `<input>`; Enter/blur commits,
  Esc cancels.
- Live preview before commit (e.g. find/replace rewrites input values, a separate
  Apply button commits).
- Optimistic UI: update the local list immediately, set `selfSelecting`, and let
  the echoed selection message be ignored.

---

## 14. Product/process lessons (meta)

These shaped Luma and apply to most plugin work:

- **Deterministic > clever.** Users trust predictable, reversible, one-click
  multi-step actions over AI that mutates the canvas unpredictably. If you use AI,
  have it emit a **structured action** (typed JSON) that a safe executor runs —
  never run model-authored code against the document.
- **Auto-created Sections are a mess** in practice. Wrapping user content in
  plugin-generated sections repeatedly frustrated the user (stray sections,
  giant bounding boxes from the coordinate trap in §6). Prefer positioning over
  containerizing unless the user explicitly wants grouping.
- **Avoid surprising viewport changes.** Auto-zoom/scroll on every action feels
  aggressive. Make viewport moves gentle, optional, or absent.
- **Confirm destructive/ambiguous intent.** When a request has two plausible
  readings (e.g. "paste into the matching layer" = replace vs anchor-relative),
  ask one crisp question rather than guessing and shipping the wrong thing.
- **Ship small, verify with the user, iterate.** Typecheck + build + commit per
  change; let the user validate in Figma before piling on.

---

## 15. Pre-flight checklist for a new plugin

1. `manifest.json` with `documentAccess: "dynamic-page"`, correct `editorType`,
   honest `networkAccess`.
2. esbuild IIFE build + `tsc --noEmit` typecheck scripts. `lib` excludes `"DOM"`.
3. `code.ts` dispatcher (try/catch → notify + done/error), `actions.ts` engine
   (throw human-readable errors), single-file `ui.html` with UI3 tokens.
4. Use `getNodeByIdAsync` + null guards; `loadAllPagesAsync` before cross-page
   work or `documentchange`.
5. `loadFontAsync` before any text edit.
6. For placement, use `absoluteBoundingBox` deltas; remember section-relative
   coords.
7. Selection: push on `selectionchange`, guard self-selects with a flag.
8. Stamp helper nodes with `setPluginData`; clean them up by that mark.
9. If watching the document, debounce + suppress your own mutations.
10. Render previews via `exportAsync` + `figma.base64Encode` on the main thread.

---

*Source: distilled from building the Luma presentation toolbox (TypeScript +
esbuild, dynamic-page). Every GOTCHA above corresponds to a bug that actually
happened.*
