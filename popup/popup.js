// popup/popup.js

// ---------- Promise helpers ----------
function queryActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(err);
      resolve(tabs && tabs[0]);
    });
  });
}

function sendToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(err);
      resolve(resp);
    });
  });
}

async function injectContentScript(tabId) {
  // Try CSS first (nice-to-have), then content script (must-have)
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["styles.css"],
    });
  } catch (_) {
    // Some pages disallow CSS injection; that's fine.
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["data/content_script.js"],
  });
}

// ---------- Minimal UI ----------
function ensureUI() {
  let root = document.getElementById("ph-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "ph-root";
    root.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div id="ph-status" style="font:12px/1.2 system-ui"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="btnClearCurrent"
                  style="padding:6px 10px;border-radius:8px;border:1px solid #ddd;cursor:pointer">
            Clear current
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
  }
  return {
    statusEl: document.getElementById("ph-status"),
    clearBtn: document.getElementById("btnClearCurrent"),
  };
}

function setStatus(el, text, kind = "info") {
  const color = kind === "error" ? "#b00020" : kind === "ok" ? "#0b7" : "#444";
  el.textContent = text;
  el.style.color = color;
}

function setDisabled(btn, disabled) {
  btn.disabled = disabled;
  btn.style.opacity = disabled ? "0.6" : "1";
  btn.style.cursor = disabled ? "not-allowed" : "pointer";
}

// ---------- Init ----------
document.addEventListener("DOMContentLoaded", async () => {
  const { statusEl, clearBtn } = ensureUI();
  setStatus(statusEl, "Loading…");

  // Always wire the button (no early returns)
  clearBtn.addEventListener("click", async () => {
    setDisabled(clearBtn, true);
    setStatus(statusEl, "Clearing…");

    // Re-read the active tab at click time (handles “sudden” failures)
    let tabId = null;
    try {
      const tab = await queryActiveTab();
      tabId = tab?.id ?? null;
    } catch {
      setStatus(statusEl, "Could not read active tab.", "error");
      setDisabled(clearBtn, false);
      return;
    }
    if (!tabId) {
      setStatus(statusEl, "No active tab to clear.", "error");
      setDisabled(clearBtn, false);
      return;
    }

    try {
      // Try talking to an already-injected content script
      let resp = await sendToTab(tabId, { type: "CLEAN_CURRENT" });
      if (resp?.ok) {
        setStatus(statusEl, "Cleared the current editor.", "ok");
      } else {
        setStatus(
          statusEl,
          "Nothing to clear (no editor or no matches).",
          "info"
        );
      }
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/Receiving end does not exist/i.test(msg)) {
        // Not injected yet → inject once and retry
        try {
          await injectContentScript(tabId);
          const resp2 = await sendToTab(tabId, { type: "CLEAN_CURRENT" });
          if (resp2?.ok) {
            setStatus(statusEl, "Cleared the current editor.", "ok");
          } else {
            setStatus(
              statusEl,
              "Nothing to clear (no editor or no matches).",
              "info"
            );
          }
        } catch {
          setStatus(
            statusEl,
            "Couldn’t prepare this page. Refresh the tab and try again.",
            "error"
          );
        }
      } else {
        setStatus(statusEl, `Clear failed: ${msg}`, "error");
      }
    } finally {
      setDisabled(clearBtn, false);
    }
  });

  // Show latest summary (best-effort; no early returns)
  try {
    const tab = await queryActiveTab();
    const tabId = tab?.id ?? null;
    if (!tabId) {
      setStatus(statusEl, "No active tab.", "error");
      return;
    }
    try {
      const resp = await sendToTab(tabId, { type: "GET_SUMMARY" });
      if (resp?.ok && resp.summary) {
        const {
          removedChars = 0,
          savedTokens = 0,
          hits = [],
        } = resp.summary || {};
        const top = hits[0]
          ? `${hits[0].explain} ×${hits[0].count}`
          : "No hits yet";
        setStatus(
          statusEl,
          `Cleanable: ${removedChars} chars (~${savedTokens} tokens). Top: ${top}`
        );
      } else {
        setStatus(statusEl, "No cleanable text detected.", "info");
      }
    } catch {
      // Try inject + retry once
      try {
        await injectContentScript(tabId);
        const resp2 = await sendToTab(tabId, { type: "GET_SUMMARY" });
        if (resp2?.ok && resp2.summary) {
          const {
            removedChars = 0,
            savedTokens = 0,
            hits = [],
          } = resp2.summary || {};
          const top = hits[0]
            ? `${hits[0].explain} ×${hits[0].count}`
            : "No hits yet";
          setStatus(
            statusEl,
            `Cleanable: ${removedChars} chars (~${savedTokens} tokens). Top: ${top}`
          );
        } else {
          setStatus(statusEl, "No cleanable text detected.", "info");
        }
      } catch {
        setStatus(statusEl, "Can’t reach this page. Refresh the tab.", "error");
      }
    }
  } catch {
    setStatus(statusEl, "Could not read active tab.", "error");
  }
});
