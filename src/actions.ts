// Luma — presentation toolbox engine (runs on Figma's main thread, has figma.* access).
// Every export is a single-click "do the multi-step thing for me" deck action.
// No AI, no network — deterministic operations on frames and prototype reactions.

export type Order = "position" | "name";

export type TransitionKind =
  | "SMART_ANIMATE"
  | "DISSOLVE"
  | "MOVE_IN"
  | "SLIDE_IN"
  | "PUSH"
  | "INSTANT";

export type EasingChoice =
  | "EASE_IN_AND_OUT"
  | "EASE_IN"
  | "EASE_OUT"
  | "LINEAR"
  | "GENTLE"
  | "QUICK"
  | "BOUNCY"
  | "SLOW"
  | "CUSTOM";

export type TriggerKind = "ON_CLICK" | "ARROW_KEYS" | "AUTO_ADVANCE";

export interface ConnectOptions {
  order: Order;
  orderIds?: string[]; // explicit manual order (frame ids) — overrides `order` when present
  transition: TransitionKind;
  direction: "LEFT" | "RIGHT" | "TOP" | "BOTTOM";
  easing: EasingChoice;
  bezier: { x1: number; y1: number; x2: number; y2: number };
  duration: number; // milliseconds (from UI)
  trigger: TriggerKind;
  autoDelay: number; // seconds, used for AUTO_ADVANCE
  loop: boolean;
  back: boolean;
  flowName: string;
}

export interface PageNumberOptions {
  format: "plain" | "fraction" | "labeled";
  position: "bottom-right" | "bottom-center" | "bottom-left" | "top-right";
  skipFirst: boolean;
  order: Order;
}

export interface NormalizeOptions {
  width: number;
  height: number;
}

export interface TidyOptions {
  gap: number;
}

export interface PolishOptions {
  normalize: boolean;
  width: number;
  height: number;
  tidy: boolean;
  gap: number;
  number: boolean;
  numberFormat: PageNumberOptions["format"];
  numberPosition: PageNumberOptions["position"];
  skipFirst: boolean;
  connect: boolean;
  connectOptions: ConnectOptions;
}

export interface FlowConnection {
  fromId: string;
  fromName: string;
  toId: string | null;
  toName: string;
  trigger: string;
  transition: string;
  broken: boolean;
}

export interface DeckInfo {
  selectedFrames: number;
  totalFrames: number;
  names: string[];
  ids: string[];
}

type DeckFrame = FrameNode | ComponentNode | InstanceNode;

const ARROW_RIGHT = 39;
const ARROW_LEFT = 37;
const PAGE_NUMBER_MARK = "luma-page-number";

// ---------------------------------------------------------------------------
// Frame collection + ordering
// ---------------------------------------------------------------------------

function isDeckFrame(n: SceneNode): n is DeckFrame {
  return n.type === "FRAME" || n.type === "COMPONENT" || n.type === "INSTANCE";
}

function collectFrames(selection: readonly SceneNode[]): DeckFrame[] {
  const out: DeckFrame[] = [];
  if (selection.length) {
    for (const n of selection) {
      if (n.type === "SECTION") {
        for (const c of n.children) if (isDeckFrame(c)) out.push(c);
      } else if (isDeckFrame(n)) {
        out.push(n);
      }
    }
  } else {
    for (const c of figma.currentPage.children) if (isDeckFrame(c)) out.push(c);
  }
  return out;
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// Reading order: group into rows by Y, then left-to-right within a row.
function orderFrames(frames: DeckFrame[], order: Order): DeckFrame[] {
  const arr = frames.slice();
  if (order === "name") {
    arr.sort((a, b) => naturalCompare(a.name, b.name));
    return arr;
  }
  arr.sort((a, b) => {
    const rowGap = Math.min(a.height, b.height) * 0.5;
    if (Math.abs(a.y - b.y) > rowGap) return a.y - b.y;
    return a.x - b.x;
  });
  return arr;
}

// Honor a manual drag-to-reorder list when the UI supplies one; otherwise fall
// back to the position/name preset. Ids no longer on the page are skipped, and
// any frames missing from the list are appended in their preset order.
function orderFramesForConnect(frames: DeckFrame[], opts: ConnectOptions): DeckFrame[] {
  const ids = opts.orderIds;
  if (ids && ids.length) {
    const byId = new Map<string, DeckFrame>();
    for (const f of frames) byId.set(f.id, f);
    const out: DeckFrame[] = [];
    for (const id of ids) {
      const f = byId.get(id);
      if (f) {
        out.push(f);
        byId.delete(id);
      }
    }
    if (byId.size) {
      for (const f of orderFrames(frames, opts.order)) if (byId.has(f.id)) out.push(f);
    }
    return out;
  }
  return orderFrames(frames, opts.order);
}

// ---------------------------------------------------------------------------
// Slide Flow — wire prototype reactions (the flagship)
// ---------------------------------------------------------------------------

function buildEasing(opts: ConnectOptions): Easing {
  if (opts.easing === "CUSTOM") {
    return { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: opts.bezier };
  }
  return { type: opts.easing } as Easing;
}

function buildTransition(opts: ConnectOptions): Transition | null {
  if (opts.transition === "INSTANT") return null;
  const easing = buildEasing(opts);
  const duration = Math.max(0, opts.duration) / 1000;
  if (opts.transition === "SMART_ANIMATE" || opts.transition === "DISSOLVE") {
    return { type: opts.transition, easing, duration };
  }
  return {
    type: opts.transition, // MOVE_IN | SLIDE_IN | PUSH
    direction: opts.direction,
    matchLayers: false,
    easing,
    duration,
  };
}

function reverseDirection(d: ConnectOptions["direction"]): ConnectOptions["direction"] {
  switch (d) {
    case "LEFT": return "RIGHT";
    case "RIGHT": return "LEFT";
    case "TOP": return "BOTTOM";
    case "BOTTOM": return "TOP";
  }
}

// Same type/curve as the forward transition, but directional motion is reversed
// so going back actually feels like stepping backwards.
function buildBackTransition(opts: ConnectOptions): Transition | null {
  if (opts.transition === "INSTANT") return null;
  const easing = buildEasing(opts);
  const duration = Math.max(0, opts.duration) / 1000;
  if (opts.transition === "SMART_ANIMATE" || opts.transition === "DISSOLVE") {
    return { type: opts.transition, easing, duration };
  }
  return {
    type: opts.transition,
    direction: reverseDirection(opts.direction),
    matchLayers: false,
    easing,
    duration,
  };
}

function navAction(destinationId: string, transition: Transition | null): Action {
  return {
    type: "NODE",
    destinationId,
    navigation: "NAVIGATE",
    transition,
    preserveScrollPosition: false,
    resetVideoPosition: false,
  };
}

function forwardTrigger(opts: ConnectOptions): Trigger {
  if (opts.trigger === "ARROW_KEYS") {
    return { type: "ON_KEY_DOWN", device: "KEYBOARD", keyCodes: [ARROW_RIGHT] };
  }
  if (opts.trigger === "AUTO_ADVANCE") {
    return { type: "AFTER_TIMEOUT", timeout: Math.max(0.1, opts.autoDelay) };
  }
  return { type: "ON_CLICK" };
}

export async function connectSlides(opts: ConnectOptions): Promise<string> {
  const frames = orderFramesForConnect(collectFrames(figma.currentPage.selection), opts);
  if (frames.length < 2) {
    throw new Error("Select at least 2 frames (or open a page with 2+ frames) to connect.");
  }

  const transition = buildTransition(opts);
  const backTransition = buildBackTransition(opts);

  for (let i = 0; i < frames.length; i++) {
    const node = frames[i];
    const reactions: Reaction[] = [];
    const next = frames[i + 1];
    const prev = frames[i - 1];

    if (next) {
      reactions.push({ trigger: forwardTrigger(opts), actions: [navAction(next.id, transition)] });
    } else if (opts.loop) {
      reactions.push({ trigger: forwardTrigger(opts), actions: [navAction(frames[0].id, transition)] });
    }

    if (opts.back) {
      const backTarget = prev || (opts.loop ? frames[frames.length - 1] : null);
      if (backTarget) {
        reactions.push({
          trigger: { type: "ON_KEY_DOWN", device: "KEYBOARD", keyCodes: [ARROW_LEFT] },
          actions: [navAction(backTarget.id, backTransition)],
        });
      }
    }

    await node.setReactionsAsync(reactions);
  }

  figma.currentPage.flowStartingPoints = [
    { nodeId: frames[0].id, name: opts.flowName || "Slide Flow" },
  ];

  const triggerLabel =
    opts.trigger === "ARROW_KEYS" ? "arrow keys" : opts.trigger === "AUTO_ADVANCE" ? "auto-advance" : "click";
  return `Connected ${frames.length} slides · ${prettyTransition(opts.transition)} · ${triggerLabel}.`;
}

function prettyTransition(t: TransitionKind): string {
  switch (t) {
    case "SMART_ANIMATE": return "Smart Animate";
    case "DISSOLVE": return "Dissolve";
    case "MOVE_IN": return "Move in";
    case "SLIDE_IN": return "Slide in";
    case "PUSH": return "Push";
    case "INSTANT": return "Instant";
  }
}

// ---------------------------------------------------------------------------
// Page numbers
// ---------------------------------------------------------------------------

function formatNumber(format: PageNumberOptions["format"], n: number, total: number): string {
  if (format === "fraction") return `${n} / ${total}`;
  if (format === "labeled") return `Slide ${n}`;
  return `${n}`;
}

function positionLabel(text: TextNode, frame: DeckFrame, position: PageNumberOptions["position"]): void {
  const margin = 40;
  const w = frame.width;
  const h = frame.height;
  const tw = text.width;
  const th = text.height;
  switch (position) {
    case "bottom-right": text.x = w - tw - margin; text.y = h - th - margin; break;
    case "bottom-center": text.x = (w - tw) / 2; text.y = h - th - margin; break;
    case "bottom-left": text.x = margin; text.y = h - th - margin; break;
    case "top-right": text.x = w - tw - margin; text.y = margin; break;
  }
}

function findPageNumber(frame: DeckFrame): TextNode | null {
  const found = frame.findOne((n) => n.type === "TEXT" && n.getPluginData(PAGE_NUMBER_MARK) === "1");
  return (found as TextNode) || null;
}

export async function addPageNumbers(opts: PageNumberOptions): Promise<string> {
  const frames = orderFrames(collectFrames(figma.currentPage.selection), opts.order);
  if (!frames.length) throw new Error("No frames found to number.");

  await figma.loadFontAsync({ family: "Inter", style: "Regular" });

  const total = opts.skipFirst ? frames.length - 1 : frames.length;
  let count = 0;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (opts.skipFirst && i === 0) {
      const existing = findPageNumber(frame);
      if (existing) existing.remove();
      continue;
    }
    count++;
    let text = findPageNumber(frame);
    if (!text) {
      text = figma.createText();
      text.setPluginData(PAGE_NUMBER_MARK, "1");
      frame.appendChild(text);
    }
    text.fontName = { family: "Inter", style: "Regular" };
    text.fontSize = 24;
    text.characters = formatNumber(opts.format, count, total);
    text.fills = [{ type: "SOLID", color: { r: 0.55, g: 0.55, b: 0.6 } }];
    positionLabel(text, frame, opts.position);
  }

  return `Numbered ${count} slides.`;
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export async function normalizeDeck(opts: NormalizeOptions): Promise<string> {
  const frames = collectFrames(figma.currentPage.selection);
  if (!frames.length) throw new Error("Select frames to normalize.");
  for (const f of frames) f.resizeWithoutConstraints(opts.width, opts.height);
  return `Resized ${frames.length} frames to ${opts.width}×${opts.height}.`;
}

export async function tidyDeck(opts: TidyOptions): Promise<string> {
  const frames = orderFrames(collectFrames(figma.currentPage.selection), "position");
  if (frames.length < 2) throw new Error("Select 2+ frames to tidy.");
  const y = Math.min(...frames.map((f) => f.y));
  let x = frames[0].x;
  for (const f of frames) {
    f.x = x;
    f.y = y;
    x += f.width + opts.gap;
  }
  return `Tidied ${frames.length} slides into a row.`;
}

// ---------------------------------------------------------------------------
// Polish my deck — run several steps in one click
// ---------------------------------------------------------------------------

export async function polishDeck(opts: PolishOptions): Promise<string> {
  const steps: string[] = [];
  if (opts.normalize) {
    await normalizeDeck({ width: opts.width, height: opts.height });
    steps.push("sized");
  }
  if (opts.tidy) {
    await tidyDeck({ gap: opts.gap });
    steps.push("tidied");
  }
  if (opts.number) {
    await addPageNumbers({
      format: opts.numberFormat,
      position: opts.numberPosition,
      skipFirst: opts.skipFirst,
      order: opts.connectOptions.order,
    });
    steps.push("numbered");
  }
  if (opts.connect) {
    await connectSlides(opts.connectOptions);
    steps.push("connected");
  }
  if (!steps.length) throw new Error("Pick at least one polish step.");
  return `Polished deck · ${steps.join(" · ")}.`;
}

// ---------------------------------------------------------------------------
// Flow Inspector — read, audit and clear prototype connections
// ---------------------------------------------------------------------------

function reactionActions(r: Reaction): readonly Action[] {
  if (r.actions && r.actions.length) return r.actions;
  const legacy = (r as { action?: Action | null }).action;
  return legacy ? [legacy] : [];
}

function triggerLabel(t: Trigger | null): string {
  if (!t) return "None";
  switch (t.type) {
    case "ON_CLICK": return "On click";
    case "ON_PRESS": return "On press";
    case "ON_HOVER": return "On hover";
    case "AFTER_TIMEOUT": return `After ${t.timeout}s`;
    case "ON_KEY_DOWN": return "Key press";
    default: return String(t.type);
  }
}

function transitionLabel(t: Transition | null | undefined): string {
  if (!t) return "Instant";
  switch (t.type) {
    case "SMART_ANIMATE": return "Smart Animate";
    case "DISSOLVE": return "Dissolve";
    case "MOVE_IN": return "Move in";
    case "MOVE_OUT": return "Move out";
    case "SLIDE_IN": return "Slide in";
    case "SLIDE_OUT": return "Slide out";
    case "PUSH": return "Push";
    case "SCROLL_ANIMATE": return "Scroll";
    default: return "Transition";
  }
}

export async function getFlowConnections(): Promise<FlowConnection[]> {
  const frames = collectFrames([]);
  const out: FlowConnection[] = [];
  for (const f of frames) {
    for (const r of f.reactions) {
      for (const a of reactionActions(r)) {
        if (a.type !== "NODE") continue;
        let toName = "(none)";
        let broken = false;
        if (a.destinationId) {
          const dest = await figma.getNodeByIdAsync(a.destinationId);
          if (dest) toName = dest.name;
          else { toName = "(missing)"; broken = true; }
        } else {
          broken = true;
        }
        out.push({
          fromId: f.id,
          fromName: f.name,
          toId: a.destinationId,
          toName,
          trigger: triggerLabel(r.trigger),
          transition: transitionLabel(a.transition),
          broken,
        });
      }
    }
  }
  return out;
}

export async function clearAllConnections(): Promise<string> {
  const frames = collectFrames([]);
  let cleared = 0;
  for (const f of frames) {
    if (f.reactions && f.reactions.length) {
      await f.setReactionsAsync([]);
      cleared++;
    }
  }
  figma.currentPage.flowStartingPoints = [];
  return cleared ? `Cleared connections on ${cleared} frames.` : "No connections to clear.";
}

export async function removeBrokenConnections(): Promise<string> {
  const frames = collectFrames([]);
  let removed = 0;
  for (const f of frames) {
    const kept: Reaction[] = [];
    for (const r of f.reactions) {
      let ok = true;
      for (const a of reactionActions(r)) {
        if (a.type === "NODE") {
          const dest = a.destinationId ? await figma.getNodeByIdAsync(a.destinationId) : null;
          if (!dest) { ok = false; break; }
        }
      }
      if (ok) kept.push(r);
      else removed++;
    }
    if (kept.length !== f.reactions.length) await f.setReactionsAsync(kept);
  }
  return removed ? `Removed ${removed} broken connection(s).` : "No broken connections found.";
}

// ---------------------------------------------------------------------------
// Morph Inspector — compare two frames, layer by layer
// ---------------------------------------------------------------------------

export interface LayerDiff {
  name: string;
  type: string;
  status: "moved" | "exit" | "enter";
  aId: string | null;
  bId: string | null;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  opacityFrom: number;
  opacityTo: number;
  hidden: boolean;
  jitter: boolean;
}

export interface RenameSuggestion {
  bId: string;
  bName: string;
  toName: string;
  reason: string;
}

export interface MorphReport {
  ok: boolean;
  message?: string;
  fromName?: string;
  toName?: string;
  moved?: LayerDiff[];
  exits?: LayerDiff[];
  enters?: LayerDiff[];
  staticCount?: number;
  jitterCount?: number;
  suggestions?: RenameSuggestion[];
}

interface RelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface UnmatchedInfo {
  id: string;
  name: string;
  type: string;
  box: RelBox | null;
}

const MORPH_GUIDE_MARK = "luma-morph-guides";

const GUIDE_MOVED: RGB = { r: 0.05, g: 0.6, b: 1 };
const GUIDE_EXIT: RGB = { r: 0.95, g: 0.28, b: 0.13 };
const GUIDE_ENTER: RGB = { r: 0.18, g: 0.78, b: 0.44 };

// Remembered frame pair so on-canvas guides can live-update as the design changes.
let guideFrameA: string | null = null;
let guideFrameB: string | null = null;

function pushToMap(map: Map<string, SceneNode[]>, key: string, node: SceneNode): void {
  const list = map.get(key);
  if (list) list.push(node);
  else map.set(key, [node]);
}

function relBox(node: SceneNode, frame: DeckFrame): RelBox | null {
  const nb = node.absoluteBoundingBox;
  const fb = frame.absoluteBoundingBox;
  if (!nb || !fb) return null;
  return { x: nb.x - fb.x, y: nb.y - fb.y, w: nb.width, h: nb.height };
}

function nodeOpacity(node: SceneNode): number {
  const o = (node as { opacity?: number }).opacity;
  return typeof o === "number" ? o : 1;
}

function absCenter(node: SceneNode): { x: number; y: number } | null {
  const bb = node.absoluteBoundingBox;
  if (!bb) return null;
  return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
}

function twoFramesFromSelection(): [DeckFrame, DeckFrame] | null {
  const frames = orderFrames(collectFrames(figma.currentPage.selection), "position");
  if (frames.length !== 2) return null;
  return [frames[0], frames[1]];
}

function buildRenameSuggestions(exitNodes: UnmatchedInfo[], enterNodes: UnmatchedInfo[]): RenameSuggestion[] {
  const out: RenameSuggestion[] = [];
  const usedB = new Set<string>();
  for (const ex of exitNodes) {
    if (!ex.box) continue;
    const exC = { x: ex.box.x + ex.box.w / 2, y: ex.box.y + ex.box.h / 2 };
    let best: UnmatchedInfo | null = null;
    let bestDist = Infinity;
    for (const en of enterNodes) {
      if (en.type !== ex.type || usedB.has(en.id) || !en.box) continue;
      const enC = { x: en.box.x + en.box.w / 2, y: en.box.y + en.box.h / 2 };
      const dist = Math.hypot(enC.x - exC.x, enC.y - exC.y);
      const sizeOk =
        Math.abs(en.box.w - ex.box.w) < ex.box.w * 0.6 + 24 &&
        Math.abs(en.box.h - ex.box.h) < ex.box.h * 0.6 + 24;
      if (dist < bestDist && dist < 220 && sizeOk) {
        best = en;
        bestDist = dist;
      }
    }
    if (best) {
      usedB.add(best.id);
      out.push({ bId: best.id, bName: best.name, toName: ex.name, reason: "Same type, near position" });
    }
  }
  return out;
}

interface FramePairing {
  matched: { na: SceneNode; nb: SceneNode }[];
  exitNodes: SceneNode[];
  enterNodes: SceneNode[];
}

// Match layers between two frames by type + name (same rule Smart Animate uses).
function pairFrames(a: DeckFrame, b: DeckFrame): FramePairing {
  const mapA = new Map<string, SceneNode[]>();
  const mapB = new Map<string, SceneNode[]>();
  for (const n of a.findAll(() => true)) pushToMap(mapA, n.type + "::" + n.name, n);
  for (const n of b.findAll(() => true)) pushToMap(mapB, n.type + "::" + n.name, n);
  const matched: { na: SceneNode; nb: SceneNode }[] = [];
  const exitNodes: SceneNode[] = [];
  const enterNodes: SceneNode[] = [];
  const keys = new Set<string>();
  for (const k of mapA.keys()) keys.add(k);
  for (const k of mapB.keys()) keys.add(k);
  for (const key of keys) {
    const la = mapA.get(key) || [];
    const lb = mapB.get(key) || [];
    const paired = Math.min(la.length, lb.length);
    for (let i = 0; i < paired; i++) matched.push({ na: la[i], nb: lb[i] });
    for (let i = paired; i < la.length; i++) exitNodes.push(la[i]);
    for (let i = paired; i < lb.length; i++) enterNodes.push(lb[i]);
  }
  return { matched, exitNodes, enterNodes };
}

function analyzeMorphFrames(a: DeckFrame, b: DeckFrame, threshold: number): MorphReport {
  const { matched, exitNodes: exNodes, enterNodes: enNodes } = pairFrames(a, b);

  const moved: LayerDiff[] = [];
  const exits: LayerDiff[] = [];
  const enters: LayerDiff[] = [];
  const exitInfos: UnmatchedInfo[] = [];
  const enterInfos: UnmatchedInfo[] = [];
  let staticCount = 0;
  let jitterCount = 0;

  for (const { na, nb } of matched) {
    const ra = relBox(na, a);
    const rb = relBox(nb, b);
    const oa = nodeOpacity(na);
    const ob = nodeOpacity(nb);
    const dx = ra && rb ? Math.round(rb.x - ra.x) : 0;
    const dy = ra && rb ? Math.round(rb.y - ra.y) : 0;
    const dw = ra && rb ? Math.round(rb.w - ra.w) : 0;
    const dh = ra && rb ? Math.round(rb.h - ra.h) : 0;
    const opacityChanged = Math.abs(oa - ob) > 0.001;
    const changed = dx !== 0 || dy !== 0 || dw !== 0 || dh !== 0 || opacityChanged;
    const hidden = oa === 0 || ob === 0 || !na.visible || !nb.visible;
    if (changed) {
      const geoMag = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dw), Math.abs(dh));
      const jitter = geoMag > 0 && geoMag <= threshold;
      if (jitter) jitterCount++;
      moved.push({ name: na.name, type: na.type, status: "moved", aId: na.id, bId: nb.id, dx, dy, dw, dh, opacityFrom: oa, opacityTo: ob, hidden, jitter });
    } else {
      staticCount++;
    }
  }
  for (const na of exNodes) {
    const oa = nodeOpacity(na);
    exits.push({ name: na.name, type: na.type, status: "exit", aId: na.id, bId: null, dx: 0, dy: 0, dw: 0, dh: 0, opacityFrom: oa, opacityTo: 0, hidden: oa === 0 || !na.visible, jitter: false });
    exitInfos.push({ id: na.id, name: na.name, type: na.type, box: relBox(na, a) });
  }
  for (const nb of enNodes) {
    const ob = nodeOpacity(nb);
    enters.push({ name: nb.name, type: nb.type, status: "enter", aId: null, bId: nb.id, dx: 0, dy: 0, dw: 0, dh: 0, opacityFrom: 0, opacityTo: ob, hidden: ob === 0 || !nb.visible, jitter: false });
    enterInfos.push({ id: nb.id, name: nb.name, type: nb.type, box: relBox(nb, b) });
  }

  return {
    ok: true,
    fromName: a.name,
    toName: b.name,
    moved,
    exits,
    enters,
    staticCount,
    jitterCount,
    suggestions: buildRenameSuggestions(exitInfos, enterInfos),
  };
}

export async function analyzeMorph(threshold = 2): Promise<MorphReport> {
  const pair = twoFramesFromSelection();
  if (!pair) return { ok: false, message: "Select exactly 2 frames to compare." };
  return analyzeMorphFrames(pair[0], pair[1], threshold);
}

// Snap layers that barely move (<= threshold px) so they hold perfectly still and
// don't jitter during a Smart Animate. We align the "to" copy onto the "from" copy.
export async function fixJitter(threshold: number): Promise<string> {
  const pair = twoFramesFromSelection();
  if (!pair) throw new Error("Select exactly 2 frames to compare.");
  const [a, b] = pair;
  const { matched } = pairFrames(a, b);
  let fixed = 0;
  for (const { na, nb } of matched) {
    const ra = relBox(na, a);
    const rb = relBox(nb, b);
    if (!ra || !rb) continue;
    const dx = rb.x - ra.x;
    const dy = rb.y - ra.y;
    const dw = rb.w - ra.w;
    const dh = rb.h - ra.h;
    const geoMag = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dw), Math.abs(dh));
    if (geoMag === 0 || geoMag > threshold) continue;
    const target = nb as SceneNode & LayoutMixin;
    if ((Math.abs(dw) > 0.001 || Math.abs(dh) > 0.001) && "resize" in nb) {
      try {
        target.resize(Math.max(ra.w, 0.01), Math.max(ra.h, 0.01));
      } catch (e) {
        /* some node types can't be resized */
      }
    }
    const rb2 = relBox(nb, b);
    if (rb2) {
      target.x -= rb2.x - ra.x;
      target.y -= rb2.y - ra.y;
    }
    fixed++;
  }
  return fixed ? `Snapped ${fixed} jittery layer${fixed > 1 ? "s" : ""} into place.` : "No jitter found under the threshold.";
}

export async function selectLayers(ids: string[]): Promise<void> {
  const nodes: SceneNode[] = [];
  for (const id of ids) {
    const n = await figma.getNodeByIdAsync(id);
    if (n && "type" in n && n.type !== "PAGE" && n.type !== "DOCUMENT") nodes.push(n as SceneNode);
  }
  if (nodes.length) {
    figma.currentPage.selection = nodes;
    figma.viewport.scrollAndZoomIntoView(nodes);
  }
}

export async function renameLayer(id: string, name: string): Promise<string> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || !("name" in node)) throw new Error("Layer not found.");
  (node as SceneNode).name = name;
  return `Renamed layer to "${name}".`;
}

export interface RenameFramesOptions {
  ids: string[]; // frames to rename, in the order numbers should follow
  base: string; // base name; use "{n}" to place the number, else number is appended
  start: number; // first number
}

// Bulk-rename frames in the given order, numbering them sequentially. The number
// is zero-padded to the width of the highest value so names sort naturally.
export async function renameFrames(opts: RenameFramesOptions): Promise<string> {
  const ids = opts.ids || [];
  if (!ids.length) throw new Error("Select screens to rename.");
  const start = typeof opts.start === "number" ? opts.start : 1;
  const base = (opts.base || "").trim();
  const pad = String(start + ids.length - 1).length;
  let n = start;
  let count = 0;
  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.type === "PAGE" || node.type === "DOCUMENT" || !("name" in node)) continue;
    const num = String(n).padStart(pad, "0");
    let name: string;
    if (base.indexOf("{n}") !== -1) name = base.replace(/\{n\}/g, num);
    else if (base) name = `${base} ${num}`;
    else name = num;
    (node as SceneNode).name = name;
    n++;
    count++;
  }
  if (!count) throw new Error("No frames found to rename.");
  return `Renamed ${count} screen${count > 1 ? "s" : ""}.`;
}

export interface Thumb {
  id: string;
  url: string; // data URL (PNG)
}

// Render each frame to a small PNG so the UI can show reorder thumbnails.
export async function exportThumbnails(ids: string[]): Promise<Thumb[]> {
  const out: Thumb[] = [];
  for (const id of ids) {
    const n = await figma.getNodeByIdAsync(id);
    if (!n || !("exportAsync" in n)) continue;
    try {
      const bytes = await (n as SceneNode).exportAsync({ format: "PNG", constraint: { type: "WIDTH", value: 160 } });
      out.push({ id, url: "data:image/png;base64," + figma.base64Encode(bytes) });
    } catch (e) {
      /* some nodes can't export \u2014 skip */
    }
  }
  return out;
}

// Reorder frames into the deck's existing slots: keep the current grid of
// positions and drop the frames into them following the supplied order.
export async function resequenceFrames(ids: string[]): Promise<number> {
  const nodes: DeckFrame[] = [];
  for (const id of ids) {
    const n = await figma.getNodeByIdAsync(id);
    if (n && "type" in n && isDeckFrame(n as SceneNode)) nodes.push(n as DeckFrame);
  }
  if (nodes.length < 2) return 0;
  const slots = orderFrames(nodes.slice(), "position").map((f) => ({ x: f.x, y: f.y }));
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].x = slots[i].x;
    nodes[i].y = slots[i].y;
  }
  return nodes.length;
}

function makeLine(p1: { x: number; y: number }, p2: { x: number; y: number }, color: RGB): RectangleNode {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.max(Math.hypot(dx, dy), 1);
  const cos = dx / len;
  const sin = dy / len;
  const r = figma.createRectangle();
  r.resize(len, 2);
  r.cornerRadius = 1;
  r.fills = [{ type: "SOLID", color }];
  // Place local origin at p1 and point the length toward p2.
  r.relativeTransform = [
    [cos, -sin, p1.x],
    [sin, cos, p1.y],
  ];
  return r;
}

function makeDot(p: { x: number; y: number }, color: RGB): EllipseNode {
  const e = figma.createEllipse();
  e.resize(9, 9);
  e.x = p.x - 4.5;
  e.y = p.y - 4.5;
  e.fills = [{ type: "SOLID", color }];
  return e;
}

function makeRing(p: { x: number; y: number }, color: RGB): EllipseNode {
  const e = figma.createEllipse();
  e.resize(13, 13);
  e.x = p.x - 6.5;
  e.y = p.y - 6.5;
  e.fills = [];
  e.strokes = [{ type: "SOLID", color }];
  e.strokeWeight = 2;
  return e;
}

export async function clearMorphGuides(): Promise<string> {
  const removed = removeGuideNodes();
  guideFrameA = null;
  guideFrameB = null;
  return removed ? "Cleared morph guides." : "No morph guides to clear.";
}

function removeGuideNodes(): number {
  let removed = 0;
  for (const c of figma.currentPage.children) {
    if (c.getPluginData(MORPH_GUIDE_MARK) === "1") {
      c.remove();
      removed++;
    }
  }
  return removed;
}

// Draw motion-path guides between two specific frames. Synchronous so the live
// documentchange watcher can redraw cheaply on every drag tick.
function drawGuidesForFrames(a: DeckFrame, b: DeckFrame): number {
  const { matched, exitNodes, enterNodes } = pairFrames(a, b);
  removeGuideNodes();
  const created: SceneNode[] = [];

  for (const { na, nb } of matched) {
    const ra = relBox(na, a);
    const rb = relBox(nb, b);
    if (!ra || !rb) continue;
    const moved =
      Math.round(rb.x - ra.x) !== 0 ||
      Math.round(rb.y - ra.y) !== 0 ||
      Math.round(rb.w - ra.w) !== 0 ||
      Math.round(rb.h - ra.h) !== 0;
    if (!moved) continue;
    const ca = absCenter(na);
    const cb = absCenter(nb);
    if (ca && cb) {
      created.push(makeLine(ca, cb, GUIDE_MOVED));
      created.push(makeDot(cb, GUIDE_MOVED));
    }
  }
  for (const na of exitNodes) {
    const ca = absCenter(na);
    if (ca) created.push(makeRing(ca, GUIDE_EXIT));
  }
  for (const nb of enterNodes) {
    const cb = absCenter(nb);
    if (cb) created.push(makeDot(cb, GUIDE_ENTER));
  }

  if (!created.length) return 0;
  const group = figma.group(created, figma.currentPage);
  group.name = "Luma Motion Paths";
  group.setPluginData(MORPH_GUIDE_MARK, "1");
  group.locked = true;
  return created.length;
}

export async function drawMorphGuides(): Promise<string> {
  const pair = twoFramesFromSelection();
  if (!pair) throw new Error("Select exactly 2 frames to compare.");
  guideFrameA = pair[0].id;
  guideFrameB = pair[1].id;
  const n = drawGuidesForFrames(pair[0], pair[1]);
  if (!n) throw new Error("Nothing is moving between these frames yet.");
  return `Live motion paths on \u2014 drag an element in "${pair[0].name}" to preview where it lands in "${pair[1].name}".`;
}

// Redraw against the remembered frame pair. Returns false when a frame is gone so
// the caller can stop the live watcher.
export async function redrawMorphGuides(): Promise<boolean> {
  if (!guideFrameA || !guideFrameB) return false;
  const a = await figma.getNodeByIdAsync(guideFrameA);
  const b = await figma.getNodeByIdAsync(guideFrameB);
  if (!a || !b || !isDeckFrame(a as SceneNode) || !isDeckFrame(b as SceneNode)) {
    removeGuideNodes();
    guideFrameA = null;
    guideFrameB = null;
    return false;
  }
  drawGuidesForFrames(a as DeckFrame, b as DeckFrame);
  return true;
}

export function morphGuidesActive(): boolean {
  return guideFrameA !== null && guideFrameB !== null;
}

// ---------------------------------------------------------------------------
// Organize connected screens — cluster a main screen with its auxiliaries
// ---------------------------------------------------------------------------

export interface OrganizeOptions {
  gap: number;
  clusterGap: number;
}

export async function organizeConnected(opts: OrganizeOptions): Promise<string> {
  const frames = collectFrames([]);
  if (frames.length < 2) throw new Error("Need at least 2 connected frames.");

  const idToFrame = new Map<string, DeckFrame>();
  for (const f of frames) idToFrame.set(f.id, f);

  const adj = new Map<string, Set<string>>();
  const outDeg = new Map<string, number>();
  for (const f of frames) {
    adj.set(f.id, new Set());
    outDeg.set(f.id, 0);
  }
  for (const f of frames) {
    for (const r of f.reactions) {
      for (const act of reactionActions(r)) {
        if (act.type === "NODE" && act.destinationId && act.destinationId !== f.id && idToFrame.has(act.destinationId)) {
          adj.get(f.id)!.add(act.destinationId);
          adj.get(act.destinationId)!.add(f.id);
          outDeg.set(f.id, (outDeg.get(f.id) || 0) + 1);
        }
      }
    }
  }

  const seen = new Set<string>();
  const clusters: string[][] = [];
  for (const f of frames) {
    if (seen.has(f.id)) continue;
    const stack = [f.id];
    const comp: string[] = [];
    seen.add(f.id);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(id);
      for (const nb of adj.get(id)!) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    if (comp.length >= 2) clusters.push(comp);
  }

  if (!clusters.length) {
    throw new Error("No connected screen groups found. Connect a main screen to its states first.");
  }

  const baseX = Math.min(...frames.map((f) => f.x));
  let cursorY = Math.min(...frames.map((f) => f.y));

  for (const comp of clusters) {
    const mainId = comp
      .slice()
      .sort((p, q) => (outDeg.get(q)! - outDeg.get(p)!) || (idToFrame.get(p)!.x - idToFrame.get(q)!.x))[0];
    const main = idToFrame.get(mainId)!;
    const aux = comp.filter((id) => id !== mainId).map((id) => idToFrame.get(id)!);

    main.x = baseX;
    main.y = cursorY;

    const auxX = baseX + main.width + opts.gap;
    let auxY = cursorY;
    for (const a of aux) {
      a.x = auxX;
      a.y = auxY;
      auxY += a.height + opts.gap;
    }

    const auxTotal = aux.length ? auxY - cursorY - opts.gap : 0;
    const clusterHeight = Math.max(main.height, auxTotal);
    cursorY += clusterHeight + opts.clusterGap;
  }

  return `Organized ${clusters.length} connected group${clusters.length > 1 ? "s" : ""}.`;
}

// ---------------------------------------------------------------------------
// Selection info for the UI
// ---------------------------------------------------------------------------

export function getDeckInfo(): DeckInfo {
  const selectedFrames = collectFrames(figma.currentPage.selection);
  const totalFrames = figma.currentPage.children.filter(isDeckFrame).length;
  const ordered = orderFrames(selectedFrames.length ? selectedFrames : collectFrames([]), "position");
  return {
    selectedFrames: selectedFrames.length,
    totalFrames,
    names: ordered.slice(0, 40).map((f) => f.name),
    ids: ordered.slice(0, 40).map((f) => f.id),
  };
}
