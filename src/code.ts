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
  getDeckInfo,
  ConnectOptions,
  PageNumberOptions,
  NormalizeOptions,
  TidyOptions,
  PolishOptions,
} from "./actions";

figma.showUI(__html__, { width: 380, height: 640, themeColors: true, title: "Luma" });

function pushSelection(): void {
  figma.ui.postMessage({ type: "selection", info: getDeckInfo() });
}

figma.on("selectionchange", pushSelection);
pushSelection();

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
