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
  drawMorphGuides,
  clearMorphGuides,
  redrawMorphGuides,
  morphGuidesActive,
  fixJitter,
  renameFrames,
  organizeConnected,
  getDeckInfo,
  ConnectOptions,
  PageNumberOptions,
  NormalizeOptions,
  TidyOptions,
  PolishOptions,
  OrganizeOptions,
} from "./actions";

figma.showUI(__html__, { width: 380, height: 640, themeColors: true, title: "Luma" });

function pushSelection(): void {
  figma.ui.postMessage({ type: "selection", info: getDeckInfo() });
}

figma.on("selectionchange", pushSelection);
pushSelection();

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
