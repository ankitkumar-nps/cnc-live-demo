// cnc-overview-patch.js
//
// Patches the CNC dashboard's rendered output without touching the React source
// (the real source was never pushed to GitHub — this is a stopgap until it is).
//
// Design history, kept because each version fixed a real bug the previous one had:
//  v1: fetched `shift_parts` telemetry directly -> could differ from the page's own
//      Shift-wise widget by 1+ (two different computations of "shift total" existed
//      in this codebase; using a THIRD one made it worse, not better).
//  v2: scraped the number out of the page's own "Shift-wise Production" widget
//      instead -> correct on Overview, but that widget only renders on Overview, so
//      every other tab either showed nothing or (worse, in an earlier revision)
//      showed a stale/wrong cached number depending on which tab was visited first.
//  v3 (this version): computes the current shift's total DIRECTLY from ThingsBoard,
//      independently, on every tab, every poll — no dependency on another widget
//      having rendered, no dependency on visit order. This is the actual fix: the
//      patch no longer needs anything from the page except where to write the answer.
(function () {
  "use strict";

  var TB_BASE = "https://iot.iotnp.com";
  var PUBLIC_ID = "77772310-b1b8-11ef-b8f7-152cc84f141f";
  var DEVICE_ID = "1fe68930-8a68-11f1-ad77-1bcdb7c23082";
  var MAXSTEP = 5; // same discontinuity-safe rule the backend CSV pipeline uses
  var POLL_MS = 1500; // how often the DOM is patched
  var FETCH_MS = 30000; // how often the shift total is recomputed from ThingsBoard

  var count = null; // last computed value; never show a label we can't back up
  var source = null; // "live" (ThingsBoard, this poll) or "csv" (fallback, hourly)
  var tbToken = null;
  var cycleData = null; // { lastCycleS, runElapsedS, machineState, fetchedAtMs } — see fetchCycleData()

  function istNow() {
    // A Date whose UTC getters read out the IST wall-clock, avoiding any dependence
    // on the viewer's own timezone.
    return new Date(Date.now() + 5.5 * 3600000);
  }

  // Start-of-current-shift as a REAL epoch ms timestamp (A 06:00, B 14:00, C 22:00 IST).
  function currentShiftStartMs() {
    var ist = istNow();
    var h = ist.getUTCHours();
    var startHour = h >= 6 && h < 14 ? 6 : h >= 14 && h < 22 ? 14 : 22;
    var dayStartIST = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 0, 0, 0);
    var shiftStartIST = dayStartIST + startHour * 3600000;
    if (h < 6) shiftStartIST -= 24 * 3600000; // C shift that started yesterday evening
    return shiftStartIST - 5.5 * 3600000; // back to a real UTC epoch ms
  }

  function tbLogin() {
    return fetch(TB_BASE + "/api/auth/login/public", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicId: PUBLIC_ID }),
    })
      .then(function (r) { return r.json(); })
      .then(function (auth) { tbToken = auth.token; return tbToken; });
  }

  // FALLBACK: the committed PRODUCTION_LEDGER.csv (same one the Production Log tab
  // reads, pushed hourly by the Pi's self-healing log_commit.sh). Used ONLY when the
  // live ThingsBoard fetch fails — e.g. the public device's history endpoint is down
  // or slow. Same-origin relative fetch, no auth needed.
  function fetchShiftCountFromCsv() {
    var ist = istNow();
    var dateStr = ist.getUTCFullYear() + "-" +
      String(ist.getUTCMonth() + 1).padStart(2, "0") + "-" +
      String(ist.getUTCDate()).padStart(2, "0");
    var h = ist.getUTCHours();
    var letter = h >= 6 && h < 14 ? "A" : h >= 14 && h < 22 ? "B" : "C";
    return fetch("data/PRODUCTION_LEDGER.csv")
      .then(function (r) { return r.text(); })
      .then(function (text) {
        var lines = text.split("\n");
        for (var i = 1; i < lines.length; i++) {
          var cols = lines[i].split(",");
          if (cols[0] === dateStr && cols[1] === letter) return Number(cols[2]);
        }
        return null;
      });
  }

  function fetchShiftCount() {
    var shiftStart = currentShiftStartMs();
    var startTs = shiftStart - 3600000; // 1h lookback buffer for a baseline point
    var endTs = Date.now();
    var url = TB_BASE + "/api/plugins/telemetry/DEVICE/" + DEVICE_ID +
      "/values/timeseries?keys=parts_total&startTs=" + startTs + "&endTs=" + endTs +
      "&orderBy=ASC&agg=NONE&limit=5000";
    return (tbToken ? Promise.resolve(tbToken) : tbLogin())
      .then(function (token) {
        return fetch(url, { headers: { "X-Authorization": "Bearer " + token } });
      })
      .then(function (r) {
        if (r.status === 401) { tbToken = null; throw new Error("token expired"); }
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        var pts = (data.parts_total || []).slice().sort(function (a, b) { return a.ts - b.ts; });
        var total = 0, prev = null;
        for (var i = 0; i < pts.length; i++) {
          var ts = Number(pts[i].ts), v = Number(pts[i].value);
          if (prev != null) {
            var inc = v - prev;
            if (inc > 0 && inc <= MAXSTEP && ts >= shiftStart) total += inc;
          }
          prev = v;
        }
        console.log("[cnc-patch] live OK: shiftStart=" + new Date(shiftStart).toISOString() +
          " points=" + pts.length + " computed=" + total + " (prev count=" + count + ")");
        count = total;
        source = "live";
      })
      .catch(function (e) {
        console.warn("[cnc-patch] live fetch failed, falling back to CSV:", e && e.message);
        return fetchShiftCountFromCsv()
          .then(function (csvCount) {
            console.log("[cnc-patch] csv fallback result: " + csvCount + " (prev count=" + count + ")");
            if (csvCount != null) { count = csvCount; source = "csv"; }
            // else: leave `count` as whatever it last was — stale-but-recent beats blank.
          })
          .catch(function (e2) { console.warn("[cnc-patch] CSV fallback also failed:", e2 && e2.message); });
      });
  }

  // 2026-09-22: found the shipped "Cycle Time" tile bound to the WRONG telemetry key —
  // its "last completed cycle" number matched `job_parts` (a part count) exactly, not
  // `cnc_cycle_time_s` (the actual duration; confirmed against the HMI earlier). Same
  // unreachable-source problem as everything else here, so same fix: rebind via patch,
  // computed independently from ThingsBoard rather than trusting the bundle's own value.
  //
  // 2026-09-22 (later): switched from cnc_cycle_time_s/run_elapsed_s to
  // last_cycle_time_s/cutting_time_s. The gateway (pashupati_808d_tb.py) already
  // computes BOTH, and they answer different questions:
  //   cnc_cycle_time_s = exact $AC_CYCLE_TIME, program-start to M30/Reset — INCLUDES
  //                       any wait/interlock time (e.g. a chuck-clamp fault mid-cycle).
  //                       Matches the HMI's "Program" field exactly, but is not "cutting
  //                       time" — confirmed against Siemens' own system-variable manual.
  //   last_cycle_time_s = gateway-summed genuine RUN (status 0x21) segments only —
  //                       excludes any IDLE/wait/interrupted gaps entirely. This is what
  //                       was actually wanted: real cutting time, faults excluded.
  // Verified 2026-09-22: on a cycle with a chuck-fault wait, cnc_cycle_time_s read
  // 566.5s while last_cycle_time_s read 521.9s — matching the machine's own
  // Program+Time-to-go baseline (~524s) for a clean run of this program almost exactly.
  // cutting_time_s is the equivalent LIVE (in-progress) figure — accumulates across RUN
  // segments and freezes during a wait, rather than resetting like run_elapsed_s did.
  function fetchCycleData() {
    var url = TB_BASE + "/api/plugins/telemetry/DEVICE/" + DEVICE_ID +
      "/values/timeseries?keys=last_cycle_time_s,cutting_time_s,machine_state";
    return (tbToken ? Promise.resolve(tbToken) : tbLogin())
      .then(function (token) {
        return fetch(url, { headers: { "X-Authorization": "Bearer " + token } });
      })
      .then(function (r) {
        if (r.status === 401) { tbToken = null; throw new Error("token expired"); }
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        var last = function (k) { return data[k] && data[k][0] ? data[k][0].value : null; };
        // Use the telemetry point's OWN ts, not Date.now() at receipt — the
        // gateway->ThingsBoard->this fetch pipeline has real latency (measured ~13s),
        // so a live-ticking value is already stale by that much the instant it arrives
        // here. Ticking forward from receipt-time silently ate that gap every poll,
        // making "cycle running now" run ~13-20s permanently behind the real machine.
        var runTs = data.cutting_time_s && data.cutting_time_s[0] ? data.cutting_time_s[0].ts : Date.now();
        cycleData = {
          lastCycleS: last("last_cycle_time_s") != null ? Number(last("last_cycle_time_s")) : null,
          runElapsedS: last("cutting_time_s") != null ? Number(last("cutting_time_s")) : null,
          machineState: last("machine_state"),
          fetchedAtMs: runTs,
        };
        console.log("[cnc-patch] cycle data:", cycleData, "pipeline lag ms:", Date.now() - runTs);
      })
      .catch(function (e) {
        console.warn("[cnc-patch] cycle data fetch failed:", e && e.message);
      });
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

  function hideCurrentRun(main) {
    var node = findByExactText(main, "current run");
    if (node && node.parentElement) node.parentElement.style.display = "none";
  }

  // Deliberately NOT assuming a specific DOM nesting (e.g. "the value lives in a
  // direct-child div") — that assumption broke silently in some render states
  // (idle/no-recent-part) where the tile's internal structure differs, leaving the
  // label renamed but the number/unit/subtitle untouched. Instead: walk up from the
  // label until we reach an ancestor that actually contains a numeric value (levels
  // of nesting vary by render state), then act on whichever text nodes look like the
  // thing we're replacing — skipping the "FROM MACHINE" badge by name, since it's
  // also a longish all-caps string that would otherwise be mistaken for the subtitle.
  function findTileRoot(labelNode) {
    var el = labelNode.parentElement;
    for (var lvl = 0; lvl < 4 && el; lvl++) {
      var hasNum = textNodes(el).some(function (n) { return /^\d+$/.test(n.textContent.trim()); });
      if (hasNum) return el;
      el = el.parentElement;
    }
    return labelNode.parentElement; // fallback: at least don't crash
  }

  function patchMainTile(main) {
    if (count == null) return;
    var node = findByExactText(main, "cycles this job") || findByExactText(main, "parts this shift");
    if (!node) return;
    node.textContent = "PARTS THIS SHIFT";
    var tile = findTileRoot(node);
    var nodes = textNodes(tile);
    var numNode = null, unitNode = null, subtitleNode = null, subtitleTailNode = null;
    for (var i = 0; i < nodes.length; i++) {
      var t = nodes[i].textContent.trim();
      if (nodes[i] === node || /^from machine$/i.test(t)) continue;
      if (numNode == null && /^\d+$/.test(t)) { numNode = nodes[i]; continue; }
      if (numNode != null && unitNode == null && /^(cycles|parts)$/i.test(t)) { unitNode = nodes[i]; continue; }
      if (unitNode != null && subtitleNode == null && t.length > 8) { subtitleNode = nodes[i]; continue; }
      if (subtitleNode != null && subtitleTailNode == null && /^\d+$/.test(t)) { subtitleTailNode = nodes[i]; continue; }
    }
    if (numNode) numNode.textContent = count;
    if (unitNode) unitNode.textContent = "parts";
    if (subtitleNode) {
      subtitleNode.textContent = source === "csv"
        ? "From committed log (fallback) · current shift only"
        : "Live from ThingsBoard · current shift only";
    }
    if (subtitleTailNode) subtitleTailNode.textContent = ""; // e.g. the old "machine total <N>" trailing number
  }

  function patchSidebarBadge() {
    if (count == null) return;
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
    if (digitNode) digitNode.textContent = count;
  }

  // Anchored on each subtitle text ("last completed cycle" / "cycle running now" /
  // "no cycle running") rather than the "Cycle Time" heading: verified live in the DOM
  // that findTileRoot()-from-label grabs a container scoped to only ONE of the two
  // number blocks (the tile's two sub-blocks aren't both within a few levels of the
  // shared heading), so walking up from the label picked up nothing for the second
  // number. Each subtitle's OWN nearest numeric ancestor is a single small div one
  // level up — climbing from the subtitle itself avoids that.
  function nearestSingleNumber(node, maxLevels) {
    var el = node && node.parentElement;
    for (var lvl = 0; lvl < maxLevels && el; lvl++) {
      var nums = textNodes(el).filter(function (n) {
        var v = n.textContent.trim();
        return /^\d+(\.\d+)?$/.test(v) || v === "—";
      });
      if (nums.length === 1) return nums[0];
      el = el.parentElement;
    }
    return null;
  }

  // Only overwrites a number that's already rendered as a number (not the "—"
  // placeholder) AND only when our own telemetry agrees a cycle is actually running —
  // otherwise leaves the tile's own IDLE/"no cycle running" rendering alone, since that
  // part of the bundle is correct and shouldn't be touched.
  function patchCycleTime(main) {
    if (!cycleData) return;
    var nodes = textNodes(main);
    var sub1 = null, sub2 = null;
    for (var i = 0; i < nodes.length; i++) {
      var t = nodes[i].textContent.trim().toLowerCase();
      if (!sub1 && /^last completed cycle/.test(t)) sub1 = nodes[i];
      if (!sub2 && /(cycle running now|no cycle running|cutting time so far)/.test(t)) sub2 = nodes[i];
    }
    // Relabel to make clear these are cutting-only figures (last_cycle_time_s /
    // cutting_time_s), not the machine's raw $AC_CYCLE_TIME — the two can legitimately
    // differ by however long a mid-cycle fault/wait took, and that shouldn't look like
    // a data error to whoever's reading the tile.
    if (sub1) sub1.textContent = "last completed cycle (cutting only) · from the machine";
    if (sub2 && /cycle running now/.test(sub2.textContent.trim().toLowerCase())) {
      sub2.textContent = "cutting time so far · from the machine";
    }
    var lastCycleNode = nearestSingleNumber(sub1, 3);
    if (lastCycleNode && cycleData.lastCycleS != null) {
      lastCycleNode.textContent = Math.round(cycleData.lastCycleS);
    }
    var runningNode = nearestSingleNumber(sub2, 3);
    if (runningNode && runningNode.textContent.trim() !== "—" &&
        cycleData.machineState === "RUN" && cycleData.runElapsedS != null) {
      // Tick forward from the fetch baseline instead of showing the 30s-stale fetched
      // value as-is — otherwise this drifts behind the native "cutting Xs" tile (which
      // updates every second) by up to one FETCH_MS interval, looking inconsistent
      // even though both numbers are correct for their own last-known instant.
      var elapsedSinceFetch = (Date.now() - cycleData.fetchedAtMs) / 1000;
      runningNode.textContent = Math.round(cycleData.runElapsedS + elapsedSinceFetch);
    }
  }

  function paint() {
    try {
      var main = document.querySelector("main");
      if (!main) return;
      hideCurrentRun(main);
      patchMainTile(main);
      patchSidebarBadge();
      patchCycleTime(main);
    } catch (e) {
      console.warn("cnc-overview-patch:", e);
    }
  }

  Promise.all([fetchShiftCount(), fetchCycleData()]).then(paint);
  setInterval(function () { Promise.all([fetchShiftCount(), fetchCycleData()]).then(paint); }, FETCH_MS);
  setInterval(paint, POLL_MS); // repaint often so a tab switch picks up the number immediately
})();
