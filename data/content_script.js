// ===============================================
// data/content_script.js
// ===============================================
// Content scripts run inside web pages (as specified in manifest.json).
// This file does 5 things:
//  1) Finds the page's text editor (e.g., ChatGPT prompt box).
//  2) Loads "wasteful" regex rules from data/wasteful_patterns.json.
//  3) Calculates removable chars/tokens and shows a floating badge.
//  4) Lets the user "Clean" the text with one click.
//  5) Blocks Enter on wasteful prompts and shows a 2-button modal:
//       [Clear]  [Send anyway]
//
// This version includes defensive checks so querySelector/DOM access
// never throw (e.g., "el.querySelector is not a function").

// =================== Global State ===================
let RULES = []; // Compiled regex rule objects: { id, explain, re }
let lastTarget = null; // The editor element we last interacted with
let badge = null; // Floating "Cleanable..." badge element
let lastSummary = null; // Latest { removedChars, savedTokens, hits: [...] }
const attached = new WeakSet(); // Track editors we've already attached listeners to
let modalEl = null; // Lazy-created blocking modal (backdrop root)

//safe default so that the UI never shows "undefined"
const EMPTY_SUMMARY = { removedChars: 0, savedTokens: 0, hits: [] };

// =================== Rule Loading (with fallback) ===================
function ensureFallbackRules() {
  if (!Array.isArray(RULES) || RULES.length === 0) {
    RULES = [
      {
        id: "sanity-hello",
        explain: "Sanity check: 'hello'",
        re: /\bhello\b/gi,
      },
    ];
    console.warn("[PH] Using fallback rules (JSON not loaded yet).");
    scanEditors();
    if (lastTarget) updateBadge(lastTarget);
  }
}

fetch(chrome.runtime.getURL("data/wasteful_patterns.json"))
  .then((r) => r.json())
  .then((json) => {
    RULES = json.map((r) => ({ ...r, re: new RegExp(r.pattern, r.flags) }));
    console.log(
      "[PH] Rules loaded:",
      RULES.map((r) => r.id)
    );
    scanEditors();
    if (lastTarget) updateBadge(lastTarget);
  })
  .catch((err) => {
    console.warn("[PH] Failed to load wasteful_patterns.json:", err);
  })
  .finally(() => {
    setTimeout(ensureFallbackRules, 500);
  });

// =================== Utilities ===================
function isEditableNode(el) {
  if (!el || !el.isConnected) return false;
  const tag = el.tagName?.toLowerCase();
  if (tag === "textarea") return true;
  const ce = el.getAttribute?.("contenteditable");
  if (ce === "true" || ce === "plaintext-only") return true;
  if (el.getAttribute?.("role") === "textbox") return true;
  return false;
}

const readVal = (el) =>
  el.tagName?.toLowerCase() === "textarea" ? el.value : el.innerText;

function writeVal(el, val) {
  if (el.tagName?.toLowerCase() === "textarea") {
    const { selectionStart, selectionEnd } = el;
    el.value = val;
    try {
      el.setSelectionRange(selectionStart, selectionEnd);
    } catch {}
  } else {
    el.innerText = val;
  }
}

const tokens = (s) => Math.max(1, Math.ceil((s || "").length / 4));

function safeRespond(fn) {
  try {
    fn();
  } catch {}
}

function isInViewport(el) {
  const r = el.getBoundingClientRect();
  return (
    r.bottom > 0 &&
    r.right > 0 &&
    r.top < window.innerHeight &&
    r.left < window.innerWidth
  );
}

// =================== Cleaning Core ===================
function applyRules(text) {
  let cleaned = text;
  let removed = 0;
  const hits = [];

  for (const r of RULES) {
    cleaned = cleaned.replace(r.re, (m) => {
      removed += m.length;
      hits.push({ id: r.id, match: m, explain: r.explain });
      return r.id === "excess-punct" ? m[0] : " ";
    });
  }

  const before = cleaned.length;
  cleaned = cleaned
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+\n/g, "\n")
    .trim();
  removed += before - cleaned.length;

  return { cleaned, removed, hits };
}

function summarize(hits, removed, savedTokens) {
  const counts = {};
  for (const h of hits) {
    const key = `${h.id}|${h.explain}`;
    if (!counts[key]) counts[key] = { id: h.id, explain: h.explain, count: 0 };
    counts[key].count++;
  }
  return {
    removedChars: removed,
    savedTokens,
    hits: Object.values(counts).sort((a, b) => b.count - a.count),
  };
}

// =================== Badge UI ===================
function ensureBadge() {
  if (badge) return badge;
  badge = document.createElement("div");
  badge.className = "ph-badge";
  badge.innerHTML = `
    <span class="ph-text"></span>
    <button class="ph-clean">Clean</button>
    <button class="ph-close" aria-label="Close">×</button>
  `;
  const closeBtn = badge.querySelector?.(".ph-close");
  if (closeBtn) closeBtn.onclick = () => hideBadge();

  // Append defensively (body may be missing very early)
  (document.body || document.documentElement).appendChild(badge);
  return badge;
}

function hideBadge() {
  if (badge) badge.style.display = "none";
}

function placeBadgeNear(target) {
  if (!badge || !target?.getBoundingClientRect) return;
  const r = target.getBoundingClientRect();
  const margin = 8;
  let top = r.bottom + margin;
  let left = r.right - 220;
  left = Math.max(8, Math.min(left, window.innerWidth - 228));
  top = Math.max(8, Math.min(top, window.innerHeight - 40));
  badge.style.top = `${top}px`;
  badge.style.left = `${left}px`;
}

function updateBadge(target) {
  if (!isEditableNode(target) || RULES.length === 0) return;

  const raw = readVal(target);
  const rawTrim = (raw || "").trim();
  if (rawTrim.length === 0) {
    lastSummary = null;
    hideBadge();
    return;
  }

  const { cleaned, removed, hits } = applyRules(raw);
  const savedTokens = Math.max(0, tokens(raw) - tokens(cleaned));
  lastSummary = summarize(hits, removed, savedTokens);

  if (removed <= 0) {
    hideBadge();
    return;
  }

  const b = ensureBadge();
  const textSpan = b.querySelector?.(".ph-text");
  if (textSpan)
    textSpan.textContent = `Cleanable: ${removed} chars (~${savedTokens} tokens)`;
  b.style.display = "flex";
  placeBadgeNear(target);

  const cleanBtn = b.querySelector?.(".ph-clean");
  if (cleanBtn) {
    cleanBtn.onclick = () => {
      writeVal(target, cleaned);
      target.dispatchEvent(
        new InputEvent("input", { bubbles: true, cancelable: true })
      );
      hideBadge();
    };
  }
}

function tickReposition() {
  if (!badge || badge.style.display === "none" || !lastTarget) return;
  if (!isInViewport(lastTarget)) {
    hideBadge();
    return;
  }
  placeBadgeNear(lastTarget);
}
addEventListener("scroll", tickReposition, true);
addEventListener("resize", tickReposition, true);

// =================== Blocking Policy + Modal (2 buttons) ===================
const BLOCK_RULE_IDS = new Set([
  "please",
  "polite-thanks",
  "hedges",
  "verbose-openers",
]);
const BLOCK_REMOVED_CHARS_THRESHOLD = 5;

function analyzeWaste(text) {
  const res = applyRules(text);
  const removedChars = text.length - res.cleaned.length;
  const hasBlockRule = res.hits.some((h) => BLOCK_RULE_IDS.has(h.id));
  const overThreshold = removedChars >= BLOCK_REMOVED_CHARS_THRESHOLD;
  return { ...res, shouldBlock: hasBlockRule || overThreshold };
}

// Create a reusable modal with 2 buttons: Clear + Send anyway
function ensureModal() {
  if (modalEl) return modalEl;

  const wrap = document.createElement("div");
  wrap.className = "ph-modal-backdrop";
  wrap.innerHTML = `
    <div class="ph-modal" role="dialog" aria-modal="true" aria-labelledby="ph-title" aria-describedby="ph-desc" tabindex="-1">
      <h3 id="ph-title" class="ph-modal-title">This prompt looks wasteful</h3>
      <p id="ph-desc" class="ph-modal-desc">We detected filler (e.g., “please”, “thanks”, hedges). Clear it before sending?</p>
      <div class="ph-modal-stats">
        <span class="ph-pill" id="ph-removed"></span>
        <span class="ph-pill" id="ph-tokens"></span>
      </div>
      <div class="ph-actions">
        <button class="ph-btn ph-primary" id="ph-clear">Clear</button>
        <button class="ph-btn" id="ph-send-anyway">Send anyway</button>
      </div>
    </div>
  `;
  (document.body || document.documentElement).appendChild(wrap);
  modalEl = wrap;
  return modalEl;
}

// Safer showModal with guards and matching ids
function showModal(summary, { onClear, onSendAnyway }) {
  const root = ensureModal();
  if (!root || typeof root.querySelector !== "function") return;

  const removedEl = root.querySelector("#ph-removed");
  const tokensEl = root.querySelector("#ph-tokens");
  if (removedEl)
    removedEl.textContent = `Removable: ${summary.removedChars} chars`;
  if (tokensEl) tokensEl.textContent = `~${summary.savedTokens} tokens`;

  root.style.display = "flex";

  const dialog = root.querySelector(".ph-modal");
  const clearBtn = root.querySelector("#ph-clear");
  const sendBtn = root.querySelector("#ph-send-anyway");
  if (dialog?.focus) dialog.focus();

  if (clearBtn) {
    clearBtn.onclick = () => {
      hideModal();
      try {
        onClear && onClear();
      } catch {}
    };
  }
  if (sendBtn) {
    sendBtn.onclick = () => {
      hideModal();
      try {
        onSendAnyway && onSendAnyway();
      } catch {}
    };
  }

  const onKey = (e) => {
    if (e.key === "Escape") {
      hideModal();
      dialog?.blur?.();
    }
  };
  root.addEventListener("keydown", onKey, { capture: true, once: true });
}

function hideModal() {
  if (modalEl) modalEl.style.display = "none";
}

// =================== Submit Helpers ===================
function tryClickSendButton() {
  const sels = [
    "[data-testid='send-button']", // ChatGPT
    "button[aria-label*='Send']",
  ];
  for (const sel of sels) {
    const btn = document.querySelector(sel);
    if (btn) {
      btn.click();
      return true;
    }
  }
  return false;
}

function simulateEnter(el) {
  if (tryClickSendButton()) return;
  const ev = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(ev);
}

function isSubmitEnter(e) {
  if (e.key !== "Enter") return false;
  if (e.shiftKey) return false;
  if (e.isComposing) return false;
  if (e.ctrlKey || e.metaKey) return false;
  return true;
}

// =================== Wiring: find editors & handle events ===================
function attachTo(el) {
  if (!isEditableNode(el) || attached.has(el)) return;
  attached.add(el);

  const handler = () => {
    lastTarget = el;
    updateBadge(el);
  };
  el.addEventListener("input", handler, { passive: true });
  el.addEventListener("focus", handler, { passive: true });
  el.addEventListener("blur", () => hideBadge(), { passive: true });

  handler();
  // console.log("[PH] attached to editor:", el);
}

function scanEditors(root = document) {
  try {
    root
      .querySelectorAll("textarea,[contenteditable],[role='textbox']")
      .forEach(attachTo);
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) scanEditors(el.shadowRoot);
    });
  } catch {}
}

// Initial scan
scanEditors();

// Re-scan for SPA changes
new MutationObserver(() => scanEditors()).observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
});

// Fallback discovery via event path (for closed shadow roots)
function findCandidateFromEvent(e) {
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  const inPath = path.find(isEditableNode);
  if (inPath) return inPath;
  const ae = document.activeElement;
  if (isEditableNode(ae)) return ae;
  return null;
}

function onAnyInputLikeEvent(e) {
  const candidate = findCandidateFromEvent(e);
  if (candidate) {
    attachTo(candidate);
    lastTarget = candidate;
    updateBadge(candidate);
  }
}
addEventListener("input", onAnyInputLikeEvent, true);
addEventListener("focusin", onAnyInputLikeEvent, true);

// Intercept Enter to possibly block and show modal (2 options)
addEventListener(
  "keydown",
  (e) => {
    if (!isSubmitEnter(e)) return;

    const target = findCandidateFromEvent(e);
    if (!target) return;

    const raw = readVal(target);

    // async work:
    e.preventDefault(); // stop default immediately so we can await
    e.stopPropagation();

    (async () => {
      try {
        const resp = await fetch(
          "https://computesimilarity-tz4nnskwtq-uc.a.run.app",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: raw }),
          }
        );
        const analysis = await resp.json();
        console.log("sanity here");
        console.log(analysis);

        const shouldBlock = analysis.maxSimilarity > 0.8;

        const removedChars = 5;
        const savedTokens = 5;
        lastSummary = summarize(
          [
            { id: 15, explain: "fsferhk", count: 4 },
            { id: 154, explain: "fsferrfefhk", count: 34 },
          ],
          removedChars,
          savedTokens
        );
        console.log(shouldBlock);

        if (!shouldBlock) {
          hideBadge();
          simulateEnter(target); // send normally
          return;
        }

        showModal(lastSummary, {
          onClear: () => {
            writeVal(target, analysis.cleaned);
            target.dispatchEvent(
              new InputEvent("input", { bubbles: true, cancelable: true })
            );
            hideBadge();
            target.focus();
          },
          onSendAnyway: () => {
            hideBadge();
            simulateEnter(target);
          },
        });
      } catch (err) {
        console.error("analysis fetch failed", err);
        // optionally fall back to local analyzeWaste(raw)
        simulateEnter(target);
      }
    })();
  },
  true
);

// Refresh hooks after tab becomes visible again
window.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    scanEditors();
    if (lastTarget) updateBadge(lastTarget);
  }
});

// =================== Popup Messaging (GET_SUMMARY / CLEAN_CURRENT) ===================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  try {
    if (msg?.type === "GET_SUMMARY") {
      // console.log("[PH] GET_SUMMARY:", lastSummary);
      safeRespond(() => sendResponse({ ok: true, summary: lastSummary }));
      return;
    }
    if (
      msg?.type === "CLEAN_CURRENT" &&
      lastTarget &&
      isEditableNode(lastTarget)
    ) {
      const raw = readVal(lastTarget);
      const { cleaned } = applyRules(raw);
      writeVal(lastTarget, cleaned);
      lastSummary = summarize(
        [],
        raw.length - cleaned.length,
        Math.max(0, tokens(raw) - tokens(cleaned))
      );
      hideBadge();
      // console.log("[PH] CLEAN_CURRENT applied");
      safeRespond(() => sendResponse({ ok: true }));
      return;
    }
  } catch {}
});

// =================== Debug Helpers ===================
window.__PH = {
  get state() {
    return { rulesLoaded: RULES.length, lastTarget, lastSummary };
  },
  rescan() {
    scanEditors();
    if (lastTarget) updateBadge(lastTarget);
  },
};
