// Patches the Overview tab's stat-tile grid without touching the built React bundle:
//  1. Hides the "Current Run" tile (redundant with Cycle Time / the cutting ring).
//  2. Relabels "Cycles This Job" -> "Parts This Shift", bound to the gateway's own
//     shift_parts telemetry (not the raw per-job machine counter it was showing before).
// Re-applies on every DOM change since this is a live-polling React app that
// re-renders its own labels back on every refresh cycle.
(function () {
  var DEVICE_ID = "1fe68930-8a68-11f1-ad77-1bcdb7c23082";
  var PUBLIC_ID = "77772310-b1b8-11ef-b8f7-152cc84f141f";
  var shiftParts = null;

  function findLabelSpan(root, sub) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim().toLowerCase() === sub) return node.parentElement;
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

      var cyclesLabel = findLabelSpan(main, "cycles this job") || findLabelSpan(main, "parts this shift");
      if (cyclesLabel) {
        cyclesLabel.textContent = "PARTS THIS SHIFT";
        var tile = cyclesLabel.parentElement;
        var valueRow = tile.querySelector(":scope > div");
        if (valueRow) {
          var spans = valueRow.querySelectorAll("span");
          if (spans[0] && shiftParts != null) spans[0].textContent = shiftParts;
          if (spans[1]) spans[1].textContent = "parts";
        }
        var subtitle = tile.querySelectorAll(":scope > span")[1];
        if (subtitle) subtitle.textContent = "Gateway shift counter · current shift only";
      }

      // Sidebar mini-badge (under the status pill) shows the same "cycles this job"
      // text as a bare number + label sharing one <span> — separate DOM subtree from
      // the main tile above, so it needs its own pass.
      var aside = document.querySelector("aside");
      if (aside) {
        var w = document.createTreeWalker(aside, NodeFilter.SHOW_TEXT);
        var n, sideLabelNode = null, sideDigitNode = null;
        while ((n = w.nextNode())) {
          var t = n.textContent.trim().toLowerCase();
          if (t === "cycles this job" || t === "parts this shift") sideLabelNode = n;
        }
        if (sideLabelNode) {
          var w2 = document.createTreeWalker(aside, NodeFilter.SHOW_TEXT);
          while ((n = w2.nextNode())) {
            if (/^\d+$/.test(n.textContent.trim()) && n.parentElement === sideLabelNode.parentElement) {
              sideDigitNode = n;
            }
          }
          sideLabelNode.textContent = " parts this shift";
          if (sideDigitNode && shiftParts != null) sideDigitNode.textContent = shiftParts;
        }
      }
    } catch (e) {
      console.warn("cnc-overview-patch: apply failed", e);
    }
  }

  function refreshShiftParts() {
    fetch("https://iot.iotnp.com/api/auth/login/public", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicId: PUBLIC_ID }),
    })
      .then(function (r) { return r.json(); })
      .then(function (auth) {
        return fetch(
          "https://iot.iotnp.com/api/plugins/telemetry/DEVICE/" + DEVICE_ID + "/values/timeseries?keys=shift_parts",
          { headers: { "X-Authorization": "Bearer " + auth.token } }
        );
      })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.shift_parts && data.shift_parts[0]) shiftParts = data.shift_parts[0].value;
        apply();
      })
      .catch(function (e) { console.warn("cnc-overview-patch: shift_parts fetch failed", e); });
  }

  var root = document.getElementById("root");
  if (root) {
    var debounce = null;
    new MutationObserver(function () {
      clearTimeout(debounce);
      debounce = setTimeout(apply, 150);
    }).observe(root, { childList: true, subtree: true, characterData: true });
  }

  refreshShiftParts();
  setInterval(refreshShiftParts, 30000);
  setTimeout(apply, 500);
})();
