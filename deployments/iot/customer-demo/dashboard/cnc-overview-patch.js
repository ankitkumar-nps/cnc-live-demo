// cnc-overview-patch.js
//
// Patches the CNC dashboard's rendered output without touching the React source
// (the real source was never pushed to GitHub — this is a stopgap until it is).
// Design notes, because the first few iterations of this file had real bugs:
//
//  - POLLS on a fixed interval instead of reacting to MutationObserver events. The
//    observer approach reacted to the DOM mid-transition (e.g. mid-route-change,
//    while React is still swapping content), which could read/cache a transient,
//    wrong value. Polling a SETTLED DOM every 1.5s avoids that whole class of bug.
//  - The "Shift-wise Production" widget only exists on the Overview tab, but the
//    "Cycles This Job" label this patches appears on every tab (shared component).
//    So the scraped count is cached in module state and reused on tabs that can't
//    scrape it themselves — and the cache is NEVER used to show a number we can't
//    back up (if nothing's been scraped yet this session, the tile is left alone).
//  - The cache only accepts a new value if it's >= the current one (shift counts are
//    monotonic non-decreasing within a shift), except on a genuine shift change
//    (A->B->C), which explicitly resets it. This guards the cache against exactly
//    the "transient state during patching" problem above hitting a lower value.
//  - The widget-heading match requires the text look like an actual heading (starts
//    with the phrase, short) rather than "contains the phrase anywhere" — this
//    dashboard's own injected subtitle text used to say "Shift-wise Production" too,
//    which made the loose match find itself instead of the real widget. Structural
//    fix, not a one-off wording change, so this class of bug can't recur.
(function () {
  "use strict";

  var POLL_MS = 1500;
  var state = { count: null, shiftLetter: null };

  function shiftLetterNowIST() {
    // Shifts are IST-fixed regardless of the viewer's own timezone: A 06-14, B 14-22, C 22-06.
    var h = new Date(Date.now() + 5.5 * 3600000).getUTCHours();
    if (h >= 6 && h < 14) return "A";
    if (h >= 14 && h < 22) return "B";
    return "C";
  }

  function textNodes(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var out = [], n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function findByExactText(root, text) {
    var nodes = textNodes(root);
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].textContent.trim().toLowerCase() === text) return nodes[i];
    }
    return null;
  }

  // Reads the CURRENT shift's row from the "Shift-wise Production" widget. Returns
  // null when that widget isn't present (any tab but Overview) or hasn't loaded yet.
  function readShiftWiseCount(main) {
    var nodes = textNodes(main);
    var startIdx = -1;
    for (var i = 0; i < nodes.length; i++) {
      var t = nodes[i].textContent.trim();
      // Anchored + length-capped so no injected text elsewhere on the page (which
      // might legitimately mention "shift-wise production" in a sentence) can ever
      // be mistaken for the widget's own heading.
      if (t.length < 40 && /^shift-wise production\b/i.test(t)) {
        startIdx = i;
        break;
      }
    }
    if (startIdx === -1) return null;
    var letter = shiftLetterNowIST();
    var end = Math.min(startIdx + 30, nodes.length);
    for (var j = startIdx + 1; j < end; j++) {
      var cur = nodes[j].textContent.trim();
      var prev = nodes[j - 1].textContent.trim();
      if (cur === letter && prev === "Shift") {
        for (var k = j + 1; k < end; k++) {
          var v = nodes[k].textContent.trim();
          if (/^\d+$/.test(v)) return v;
        }
      }
    }
    return null;
  }

  function updateCache(main) {
    var letter = shiftLetterNowIST();
    if (letter !== state.shiftLetter) {
      state.shiftLetter = letter;
      state.count = null; // legitimate reset — a new shift really does start lower
    }
    var scraped = readShiftWiseCount(main);
    if (scraped != null && (state.count == null || Number(scraped) >= Number(state.count))) {
      state.count = scraped;
    }
  }

  function hideCurrentRun(main) {
    var node = findByExactText(main, "current run");
    if (node && node.parentElement) node.parentElement.style.display = "none";
  }

  function patchMainTile(main) {
    if (state.count == null) return; // never show a label backed by no real number
    var node = findByExactText(main, "cycles this job") || findByExactText(main, "parts this shift");
    if (!node) return;
    node.textContent = "PARTS THIS SHIFT";
    var tile = node.parentElement;
    var valueRow = tile.querySelector(":scope > div");
    if (valueRow) {
      var spans = valueRow.querySelectorAll("span");
      if (spans[0]) spans[0].textContent = state.count;
      if (spans[1]) spans[1].textContent = "parts";
    }
    var subtitle = tile.querySelectorAll(":scope > span")[1];
    if (subtitle) subtitle.textContent = "Synced with the shift totals below · current shift only";
  }

  function patchSidebarBadge() {
    if (state.count == null) return;
    var aside = document.querySelector("aside");
    if (!aside) return;
    var labelNode = findByExactText(aside, "cycles this job") || findByExactText(aside, "parts this shift");
    if (!labelNode) return;
    var digitNode = null;
    var nodes = textNodes(aside);
    for (var i = 0; i < nodes.length; i++) {
      if (/^\d+$/.test(nodes[i].textContent.trim()) && nodes[i].parentElement === labelNode.parentElement) {
        digitNode = nodes[i];
      }
    }
    labelNode.textContent = " parts this shift";
    if (digitNode) digitNode.textContent = state.count;
  }

  function tick() {
    try {
      var main = document.querySelector("main");
      if (!main) return;
      hideCurrentRun(main);
      updateCache(main);
      patchMainTile(main);
      patchSidebarBadge();
    } catch (e) {
      console.warn("cnc-overview-patch:", e);
    }
  }

  setInterval(tick, POLL_MS);
  tick();
})();
