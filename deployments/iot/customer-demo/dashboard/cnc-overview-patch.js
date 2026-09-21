// Patches the Overview tab's stat-tile grid without touching the built React bundle:
//  1. Hides the "Current Run" tile (redundant with Cycle Time / the cutting ring).
//  2. Relabels "Cycles This Job" -> "Parts This Shift", bound to whatever the existing
//     "Shift-wise Production" widget already shows for the CURRENT shift — deliberately
//     NOT a separate telemetry fetch (shift_parts), because that's the gateway's own
//     live running tally and can differ by 1 from the history-recomputed number the
//     Shift-wise widget uses (boundary-timing artifact, confirmed 2026-09-21). Scraping
//     the already-displayed number guarantees the two never disagree, by construction.
// Re-applies on every DOM change since this is a live-polling React app that
// re-renders its own labels back on every refresh cycle.
(function () {
  // Persists across tab switches within this SPA session (a real page reload resets
  // it, which is correct — we don't want a stale count surviving a reload). Only set
  // when currentShiftCount() actually finds the Shift-wise Production widget (Overview
  // tab only); every other tab shares this same "Cycles This Job" label but has no
  // such widget to scrape, so without this cache they'd show a live-updating-looking
  // tile that's actually frozen/stale. See admin-dashboards-cnc-monitor-missing memory
  // for the 2026-09-21 incident this fixes: patch relabeled the tile on EVERY tab but
  // could only get a correct number on Overview, silently showing a wrong number
  // under a confident "synced" label everywhere else.
  var lastKnownCount = null;

  function findLabelSpan(root, sub) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim().toLowerCase() === sub) return node.parentElement;
    }
    return null;
  }

  function currentShiftLetter() {
    // Shifts are defined in IST regardless of viewer's own timezone: A 06-14, B 14-22, C 22-06.
    var istHour = new Date(Date.now() + 5.5 * 3600000).getUTCHours();
    if (istHour >= 6 && istHour < 14) return "A";
    if (istHour >= 14 && istHour < 22) return "B";
    return "C";
  }

  function currentShiftCount(main) {
    var walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    var n, texts = [], capture = false;
    while ((n = walker.nextNode())) {
      var t = n.textContent.trim();
      if (/shift-wise production/i.test(t)) capture = true;
      if (capture) {
        texts.push(t);
        if (texts.length > 30) break;
      }
    }
    var letter = currentShiftLetter();
    for (var i = 1; i < texts.length; i++) {
      if (texts[i] === letter && texts[i - 1] === "Shift") {
        for (var j = i + 1; j < texts.length; j++) {
          if (/^\d+$/.test(texts[j])) return texts[j];
        }
      }
    }
    return null;
  }

  function apply() {
    try {
      var main = document.querySelector("main");
      if (!main) return;

      var curRunLabel = findLabelSpan(main, "current run");
      if (curRunLabel && curRunLabel.parentElement) {
        curRunLabel.parentElement.style.display = "none";
      }

      var scraped = currentShiftCount(main);
      if (scraped != null) lastKnownCount = scraped;
      var count = lastKnownCount;

      // Only touch this tile at all if we have a trustworthy number (scraped now, or
      // cached from an earlier visit to Overview this session). Otherwise leave it
      // completely as-is — original label, original value — rather than showing a
      // confident "Parts This Shift" label over a number we can't actually vouch for.
      var cyclesLabel = findLabelSpan(main, "cycles this job") || findLabelSpan(main, "parts this shift");
      if (cyclesLabel && count != null) {
        cyclesLabel.textContent = "PARTS THIS SHIFT";
        var tile = cyclesLabel.parentElement;
        var valueRow = tile.querySelector(":scope > div");
        if (valueRow) {
          var spans = valueRow.querySelectorAll("span");
          if (spans[0]) spans[0].textContent = count;
          if (spans[1]) spans[1].textContent = "parts";
        }
        var subtitle = tile.querySelectorAll(":scope > span")[1];
        if (subtitle) subtitle.textContent = "Synced with the shift totals below · current shift only";
      }

      // Sidebar mini-badge (under the status pill) — same label text, separate DOM
      // subtree (bare number + label sharing one parent <span>), needs its own pass.
      var aside = document.querySelector("aside");
      if (aside && count != null) {
        var w = document.createTreeWalker(aside, NodeFilter.SHOW_TEXT);
        var m, sideLabelNode = null, sideDigitNode = null;
        while ((m = w.nextNode())) {
          var t2 = m.textContent.trim().toLowerCase();
          if (t2 === "cycles this job" || t2 === "parts this shift") sideLabelNode = m;
        }
        if (sideLabelNode) {
          var w2 = document.createTreeWalker(aside, NodeFilter.SHOW_TEXT);
          while ((m = w2.nextNode())) {
            if (/^\d+$/.test(m.textContent.trim()) && m.parentElement === sideLabelNode.parentElement) {
              sideDigitNode = m;
            }
          }
          sideLabelNode.textContent = " parts this shift";
          if (sideDigitNode && count != null) sideDigitNode.textContent = count;
        }
      }
    } catch (e) {
      console.warn("cnc-overview-patch: apply failed", e);
    }
  }

  var root = document.getElementById("root");
  if (root) {
    var debounce = null;
    new MutationObserver(function () {
      clearTimeout(debounce);
      debounce = setTimeout(apply, 150);
    }).observe(root, { childList: true, subtree: true, characterData: true });
  }

  setTimeout(apply, 500);
})();
