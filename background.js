// background.js (MV3 service worker)
// background.js (MV3 service worker)

const ANALYZE_URL = "https://computesimilarity-tz4nnskwtq-uc.a.run.app";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "ANALYZE_TEXT") {
    (async () => {
      try {
        const res = await fetch(ANALYZE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: msg.text }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          sendResponse({ ok: false, error: `HTTP ${res.status}`, data });
          return;
        }
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true; // keep the message channel open (async sendResponse)
  }
});

// --- tiny helper to message the active tab's content script ---
function withActiveTab(fn) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs?.[0];
    if (!tab?.id) {
      fn(null);
      return;
    }
    fn(tab.id);
  });
}

function relayToActiveTab(message, sendResponse) {
  withActiveTab((tabId) => {
    if (!tabId) {
      sendResponse?.({ ok: false, error: "NO_ACTIVE_TAB" });
      return;
    }
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      // Swallow lastError when content script isn't ready yet
      // (happens if you open popup on chrome:// pages or before page loads)
      if (chrome.runtime.lastError) {
        sendResponse?.({
          ok: false,
          error: chrome.runtime.lastError.message || "NO_CONTENT_SCRIPT",
        });
        return;
      }
      sendResponse?.(resp || { ok: true });
    });
  });
}

// --- popup → background → content script relays ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "POPUP_GET_SUMMARY") {
    relayToActiveTab({ type: "GET_SUMMARY" }, sendResponse);
    return true; // keep sendResponse alive (async)
  }

  if (msg?.type === "POPUP_CLEAN_CURRENT") {
    relayToActiveTab({ type: "CLEAN_CURRENT" }, sendResponse);
    return true;
  }
});

// --- keyboard shortcut support (from manifest "commands") ---
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "clean-current") {
    withActiveTab((tabId) => {
      if (tabId) chrome.tabs.sendMessage(tabId, { type: "CLEAN_CURRENT" });
    });
  }
});

// --- optional: simple diagnostics in chrome://extensions › service worker logs ---
chrome.runtime.onInstalled.addListener((details) => {
  console.log("[PH] installed:", details.reason);
});
chrome.runtime.onStartup.addListener(() => {
  console.log("[PH] service worker started");
});
