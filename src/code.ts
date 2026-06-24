// Luma — plugin main thread. Thin dispatcher: the UI (ui.html) posts a typed
// message per toolbox action; we run the matching engine function from actions.ts
// and report the result back. No AI, no network.

import {
  connectSlides,
  addPageNumbers,
  normalizeDeck,
  tidyDeck,
  polishDeck,
  getFlowConnections,
  clearAllConnections,
  removeBrokenConnections,
  analyzeMorph,
  selectLayers,
  renameLayer,
  renameLayers,
  matchLayerName,
  setSelectionOpacity,
  setSelectionLocked,
  outlineSelection,
  clearOutlines,
  copyLayerToPrevSlide,
  copyLayerToSlide,
  getLayerSelection,
  getTargetSlide,
  drawMorphGuides,
  clearMorphGuides,
  redrawMorphGuides,
  morphGuidesActive,
  fixJitter,
  renameFrames,
  exportThumbnails,
  exportDeckForWeb,
  resequenceFrames,
  organizeConnected,
  branchFrame,
  promoteBranch,
  removeBranch,
  wireBranchIntoFlow,
  duplicateSlide,
  getBranchMap,
  getDeckInfo,
  listPages,
  gotoPage,
  ConnectOptions,
  PageNumberOptions,
  NormalizeOptions,
  TidyOptions,
  PolishOptions,
  OrganizeOptions,
} from "./actions";

figma.showUI(__html__, { width: 480, height: 640, themeColors: true, title: "Luma" });

function pushSelection(): void {
  figma.ui.postMessage({ type: "selection", info: getDeckInfo() });
  figma.ui.postMessage({ type: "layersel", info: getLayerSelection() });
}

function pushSelectionForced(): void {
  figma.ui.postMessage({ type: "selection", info: getDeckInfo(), force: true });
  figma.ui.postMessage({ type: "layersel", info: getLayerSelection() });
}

// ---------- page navigation + history ----------
// History of visited page ids during this plugin session, so "Back" can return
// to the previously viewed page without using Figma's left sidebar.
let pageHistory: string[] = [];
let histIndex = -1;
let navigating = false; // set while we programmatically change pages (suppresses history record)

function pushNav(): void {
  figma.ui.postMessage({
    type: "pages",
    pages: listPages(),
    currentId: figma.currentPage.id,
    canBack: histIndex > 0,
    canForward: histIndex < pageHistory.length - 1,
  });
}

function recordPage(): void {
  const id = figma.currentPage.id;
  if (histIndex >= 0 && pageHistory[histIndex] === id) return;
  pageHistory = pageHistory.slice(0, histIndex + 1);
  pageHistory.push(id);
  histIndex = pageHistory.length - 1;
}

async function navTo(index: number): Promise<void> {
  if (index < 0 || index >= pageHistory.length) return;
  histIndex = index;
  navigating = true;
  await gotoPage(pageHistory[histIndex]);
}

figma.on("selectionchange", pushSelection);
figma.on("currentpagechange", () => {
  if (navigating) navigating = false; // page change we initiated via Back/Forward
  else recordPage(); // user (or the page switcher) navigated to a new page
  pushSelection();
  pushNav();
});

recordPage();
pushSelection();
pushNav();

// --- Live morph guides: redraw the on-canvas motion paths as the design changes ---
let guidesLive = false;
let redrawScheduled = false;
let suppressGuideRedrawUntil = 0;

function scheduleGuideRedraw(): void {
  if (!guidesLive || redrawScheduled) return;
  if (Date.now() < suppressGuideRedrawUntil) return;
  redrawScheduled = true;
  setTimeout(async () => {
    redrawScheduled = false;
    if (!guidesLive) return;
    // Ignore the documentchange events caused by our own guide nodes for a moment.
    suppressGuideRedrawUntil = Date.now() + 350;
    try {
      const stillThere = await redrawMorphGuides();
      if (!stillThere) {
        guidesLive = false;
        figma.ui.postMessage({ type: "done", message: "Motion paths cleared \u2014 a frame was removed." });
      }
    } catch (e) {
      /* ignore transient redraw errors mid-edit */
    }
  }, 120);
}

// In dynamic-page mode a documentchange handler can only be registered after all
// pages are loaded. Do it lazily the first time live guides are turned on.
let guideWatcherReady = false;
async function ensureGuideWatcher(): Promise<void> {
  if (guideWatcherReady) return;
  await figma.loadAllPagesAsync();
  figma.on("documentchange", scheduleGuideRedraw);
  guideWatcherReady = true;
}

interface UIMessage {
  type: string;
  options?: unknown;
  width?: number;
  height?: number;
}

figma.ui.onmessage = async (msg: UIMessage) => {
  try {
    switch (msg.type) {
      case "connect-slides": {
        const result = await connectSlides(msg.options as ConnectOptions);
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "page-numbers": {
        const result = await addPageNumbers(msg.options as PageNumberOptions);
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "normalize": {
        const result = await normalizeDeck(msg.options as NormalizeOptions);
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "tidy": {
        const result = await tidyDeck(msg.options as TidyOptions);
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "match-name": {
        const result = await matchLayerName();
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "set-opacity": {
        const o = msg.options as { value: number };
        const result = await setSelectionOpacity(o.value);
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "lock-layers": {
        const o = msg.options as { locked: boolean };
        const result = setSelectionLocked(o.locked);
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "outline-selection": {
        const result = outlineSelection();
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "clear-outlines": {
        const result = clearOutlines();
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "copy-to-prev": {
        const result = await copyLayerToPrevSlide();
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "set-target": {
        const slide = getTargetSlide();
        figma.ui.postMessage({ type: "target", slide });
        figma.notify(`Target slide: ${slide.name}`);
        break;
      }
      case "copy-to-slide": {
        const o = msg.options as { id: string };
        const result = await copyLayerToSlide(o.id);
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "polish-deck": {
        const result = await polishDeck(msg.options as PolishOptions);
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "get-connections": {
        const list = await getFlowConnections();
        figma.ui.postMessage({ type: "connections", list });
        break;
      }
      case "clear-connections": {
        const result = await clearAllConnections();
        figma.notify(result);
        const list = await getFlowConnections();
        figma.ui.postMessage({ type: "connections", list, message: result });
        break;
      }
      case "remove-broken": {
        const result = await removeBrokenConnections();
        figma.notify(result);
        const list = await getFlowConnections();
        figma.ui.postMessage({ type: "connections", list, message: result });
        break;
      }
      case "morph-analyze": {
        const opts = (msg.options as { threshold?: number }) || {};
        const threshold = typeof opts.threshold === "number" ? opts.threshold : 2;
        const report = await analyzeMorph(threshold);
        figma.ui.postMessage({ type: "morph", report });
        break;
      }
      case "morph-select": {
        await selectLayers((msg.options as { ids: string[] }).ids);
        break;
      }
      case "morph-rename": {
        const o = msg.options as { id: string; name: string; threshold?: number };
        const result = await renameLayer(o.id, o.name);
        figma.notify(result);
        const threshold = typeof o.threshold === "number" ? o.threshold : 2;
        const report = await analyzeMorph(threshold);
        figma.ui.postMessage({ type: "morph", report, message: result });
        if (guidesLive) await redrawMorphGuides();
        break;
      }
      case "morph-fix-jitter": {
        const o = (msg.options as { threshold?: number }) || {};
        const threshold = typeof o.threshold === "number" ? o.threshold : 2;
        const result = await fixJitter(threshold);
        figma.notify(result);
        const report = await analyzeMorph(threshold);
        figma.ui.postMessage({ type: "morph", report, message: result });
        if (guidesLive) await redrawMorphGuides();
        break;
      }
      case "morph-guides": {
        await ensureGuideWatcher();
        const result = await drawMorphGuides();
        guidesLive = morphGuidesActive();
        suppressGuideRedrawUntil = Date.now() + 350;
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "morph-clear-guides": {
        guidesLive = false;
        const result = await clearMorphGuides();
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "rename-frames": {
        const result = await renameFrames(msg.options as { ids: string[]; base: string; start: number });
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        pushSelection();
        break;
      }
      case "rename-layer": {
        const o = msg.options as { id: string; name: string };
        const result = await renameLayer(o.id, o.name);
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "rename-layers": {
        const o = msg.options as { list: { id: string; name: string }[] };
        const result = await renameLayers(o.list || []);
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "branch-frame": {
        const o = msg.options as { id: string };
        const res = await branchFrame(o.id);
        const message = `Branched \u201c${res.parentName}\u201d \u00b7 ${res.name}.`;
        figma.notify(message);
        figma.ui.postMessage({ type: "branches", map: getBranchMap() });
        figma.ui.postMessage({ type: "done", message });
        break;
      }
      case "promote-branch": {
        const o = msg.options as { id: string };
        const res = await promoteBranch(o.id);
        const message = `Promoted \u201c${res.name}\u201d into the deck.`;
        figma.notify(message);
        figma.ui.postMessage({ type: "branches", map: getBranchMap() });
        pushSelectionForced();
        figma.ui.postMessage({ type: "done", message });
        break;
      }
      case "remove-branch": {
        const o = msg.options as { id: string };
        const message = await removeBranch(o.id);
        figma.notify(message);
        figma.ui.postMessage({ type: "branches", map: getBranchMap() });
        figma.ui.postMessage({ type: "done", message });
        break;
      }
      case "wire-branch": {
        const o = msg.options as { id: string; connectOptions: ConnectOptions };
        const message = await wireBranchIntoFlow({ branchId: o.id, connectOptions: o.connectOptions });
        figma.notify(message);
        figma.ui.postMessage({ type: "branches", map: getBranchMap() });
        figma.ui.postMessage({ type: "done", message });
        break;
      }
      case "duplicate-slide": {
        const o = msg.options as { id: string };
        const res = await duplicateSlide(o.id);
        const message = `Duplicated \u2192 ${res.name}.`;
        figma.notify(message);
        pushSelectionForced();
        figma.ui.postMessage({ type: "done", message });
        break;
      }
      case "get-thumbs": {
        const ids = ((msg.options as { ids?: string[] }) || {}).ids || [];
        const list = await exportThumbnails(ids);
        figma.ui.postMessage({ type: "thumbs", list });
        break;
      }
      case "export-web": {
        const o = (msg.options as { scale?: number }) || {};
        figma.notify("Exporting slides\u2026", { timeout: 1500 });
        const res = await exportDeckForWeb(o.scale || 1);
        figma.ui.postMessage({ type: "web-export", data: res.data, count: res.count, bytes: res.bytes });
        const message = `Exported ${res.count} slide${res.count > 1 ? "s" : ""}.`;
        figma.notify(message);
        figma.ui.postMessage({ type: "done", message });
        break;
      }
      case "apply-sequence": {
        const o = msg.options as {
          ids: string[];
          reposition: boolean;
          renumber: boolean;
          base: string;
          rewire: boolean;
          connectOptions: ConnectOptions;
        };
        const steps: string[] = [];
        if (o.reposition) {
          const n = await resequenceFrames(o.ids);
          if (n) steps.push("repositioned");
        }
        if (o.renumber) {
          await renameFrames({ ids: o.ids, base: o.base, start: 1 });
          steps.push("renumbered");
        }
        if (o.rewire) {
          const co = o.connectOptions;
          co.orderIds = o.ids;
          await connectSlides(co);
          steps.push("reconnected");
        }
        const message = steps.length ? `Applied new order \u00b7 ${steps.join(" \u00b7 ")}.` : "Nothing to apply \u2014 turn on a step.";
        figma.notify(message);
        figma.ui.postMessage({ type: "done", message });
        pushSelection();
        break;
      }
      case "organize-connected": {
        const result = await organizeConnected(msg.options as OrganizeOptions);
        figma.notify(result);
        figma.ui.postMessage({ type: "done", message: result });
        break;
      }
      case "resize": {
        if (typeof msg.width === "number" && typeof msg.height === "number") {
          figma.ui.resize(Math.round(msg.width), Math.round(msg.height));
        }
        break;
      }
      case "set-page": {
        const o = msg.options as { id: string };
        await gotoPage(o.id);
        break;
      }
      case "nav-back": {
        await navTo(histIndex - 1);
        break;
      }
      case "nav-forward": {
        await navTo(histIndex + 1);
        break;
      }
      case "close": {
        figma.closePlugin();
        break;
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    figma.notify(`Luma: ${message}`, { error: true });
    figma.ui.postMessage({ type: "error", message });
  }
};
