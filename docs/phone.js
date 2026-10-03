// Phone app data layer. Loaded before common.js on the phone version of each page.
//
// The Mac writes "garmin-dashboard.data" (gzip JSON) to iCloud Drive after each sync.
// Importing it here stores everything in this app's IndexedDB on the phone, and the
// dashboard pages read from that copy instead of the Mac's server. Nothing is uploaded.

(function () {
  const DB_NAME = "garmin-dashboard";
  const FILE_NAME = "garmin-dashboard.data";
  const STALE_DAYS = 3;

  // ---------- IndexedDB ----------
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("meta");
        req.result.createObjectStore("details");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbGet(db, store, key) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(store).objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function saveSnapshot(db, snap, size) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["meta", "details"], "readwrite");
      const meta = tx.objectStore("meta"), details = tx.objectStore("details");
      meta.clear(); details.clear();
      meta.put(snap.overview, "overview");
      meta.put({ generated_at: snap.generated_at, imported_at: new Date().toISOString(), size,
        activities: snap.overview.activities.length }, "info");
      for (const [id, detail] of Object.entries(snap.details)) details.put(detail, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Saving was interrupted (is the phone low on storage?)"));
    });
  }

  // ---------- reading the file ----------
  async function readFile(file) {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    let text;
    if (head[0] === 0x1f && head[1] === 0x8b) {
      if (typeof DecompressionStream === "undefined") {
        throw new Error("This iPhone's Safari is too old to open the file. Update to iOS 16.4 or later.");
      }
      text = await new Response(file.stream().pipeThrough(new DecompressionStream("gzip"))).text();
    } else {
      text = await file.text(); // already uncompressed (e.g. iOS unzipped it)
    }
    let snap;
    try { snap = JSON.parse(text); } catch { throw new Error(`That doesn't look like ${FILE_NAME}. Pick the file in iCloud Drive → Garmin Dashboard.`); }
    if (!snap || snap.format !== "garmin-dashboard" || !snap.overview || !snap.details) {
      throw new Error(`That doesn't look like ${FILE_NAME}. Pick the file in iCloud Drive → Garmin Dashboard.`);
    }
    if (snap.version > 1) throw new Error("This file is from a newer version of the app. Reload the app to update it, then import again.");
    return snap;
  }

  async function importFile(file, onStatus) {
    onStatus("Reading the file…");
    const snap = await readFile(file);
    onStatus(`Saving ${snap.overview.activities.length} activities on this phone…`);
    // remember what changed, to confirm it after the reload
    const before = overview ? new Set(overview.activities.map((a) => a.activity_id)) : null;
    const added = before ? snap.overview.activities.filter((a) => !before.has(a.activity_id)).length : null;
    try { sessionStorage.setItem("phoneImported", JSON.stringify({ added, total: snap.overview.activities.length })); } catch {}
    const db = await openDb();
    await saveSnapshot(db, snap, file.size);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  // ---------- zone system chosen on this phone ----------
  // The Mac sends both zone sets; a choice made here overrides the Mac's on this phone only,
  // and survives importing newer files.
  const ZONE_KEY = "phoneZoneSystem";

  function zonePref() {
    let pref = null;
    try { pref = localStorage.getItem(ZONE_KEY); } catch {}
    const options = overview && overview.settings && overview.settings.zone_options;
    return pref && options && options[pref] ? pref : null;
  }

  function setZoneSystem(value) {
    try {
      if (value) localStorage.setItem(ZONE_KEY, value); else localStorage.removeItem(ZONE_KEY);
    } catch {}
  }

  // Swap the zones in a settings object for the phone's choice. Returns the option used, or null.
  function applyZoneChoice(settings) {
    const pref = zonePref();
    settings.mac_zone_system = settings.mac_zone_system || settings.zone_system || "threshold";
    if (!pref || pref === settings.mac_zone_system) return null;
    const opt = overview.settings.zone_options[pref];
    settings.zone_system = pref;
    settings.zone_floors = opt.floors;
    settings.zone_method = opt.method;
    return opt;
  }

  // Time in each zone from the workout's heart-rate samples (same rules as the Mac: pauses
  // longer than 10 s count as one sample, not as time at that heart rate).
  function timeInZones(t, hr, zones, step) {
    const secs = zones.map(() => 0);
    for (let i = 0; i < t.length; i++) {
      const h = hr[i];
      if (h == null) continue;
      const gap = i ? t[i] - t[i - 1] : step;
      const dt = gap > 0 && gap <= 10 ? gap : step;
      const k = zones.findIndex((z) => h >= z.low && h < z.high);
      if (k >= 0) secs[k] += dt;
    }
    return secs;
  }

  function applyZonesToDetail(detail) {
    const opt = applyZoneChoice(detail.settings);
    if (!opt) return detail;
    detail.zones = opt.zones;
    const exact = detail.metrics && detail.metrics.zone_seconds_by_system;
    if (exact && exact[detail.settings.zone_system]) {
      // computed on the Mac from second-by-second data
      detail.metrics.zone_seconds = exact[detail.settings.zone_system];
    } else if (detail.metrics && detail.streams && detail.metrics.zone_seconds) {
      // older file: work it out here from the 5-second data (close, not exact)
      detail.metrics.zone_seconds = timeInZones(detail.streams.t, detail.streams.hr, opt.zones, detail.sample_step_s || 1);
    }
    return detail;
  }

  // ---------- API ----------
  let dbPromise = null, overview = null, info = null;
  const ready = (async () => {
    try {
      dbPromise = openDb();
      const db = await dbPromise;
      [overview, info] = await Promise.all([idbGet(db, "meta", "overview"), idbGet(db, "meta", "info")]);
    } catch (err) {
      console.error(err);
    }
    return !!overview;
  })();

  const routes = {
    "/api/activities": () => overview.activities,
    "/api/vo2max": () => overview.vo2max,
    "/api/training-load": () => overview.training_load,
    "/api/records": () => overview.records,
    "/api/settings": () => {
      const s = structuredClone(overview.settings);
      const opt = applyZoneChoice(s);
      if (opt) s.zones = opt.zones;
      return s;
    },
    "/api/insights": () => overview.insights,
    "/api/plan": () => overview.plan,
  };

  async function get(url, options) {
    const hasData = await ready;
    if (!hasData) return new Promise(() => {}); // the import screen is showing; pages wait
    if (options && options.method && options.method !== "GET") {
      throw new Error("That only works in the dashboard on your Mac.");
    }
    const u = new URL(url, location.href);
    if (routes[u.pathname]) return structuredClone(routes[u.pathname]());
    const m = u.pathname.match(/^\/api\/activities\/(\d+)$/);
    if (m) {
      const detail = await idbGet(await dbPromise, "details", m[1]);
      if (!detail) throw new Error("This activity isn't in the imported data. Import the latest file.");
      return applyZonesToDetail(detail);
    }
    if (u.pathname === "/api/ai/review") {
      const p = u.searchParams;
      const key = `${p.get("scope")}:${p.get("scope") === "activity" ? p.get("activity_id") : ""}:${p.get("units")}`;
      return { configured: false, review: (overview.ai_reviews || {})[key] || null };
    }
    throw new Error(`Not available on the phone: ${u.pathname}`);
  }

  // ---------- UI ----------
  function picker(onFile) {
    const input = document.createElement("input");
    input.type = "file";
    input.hidden = true;
    input.addEventListener("change", () => { if (input.files[0]) onFile(input.files[0]); input.value = ""; });
    document.body.appendChild(input);
    return input;
  }

  function relative(iso) {
    const mins = Math.round((Date.now() - new Date(iso)) / 60000);
    if (mins < 2) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days > 1 ? "s" : ""} ago`;
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function showOnboarding(main) {
    for (const child of main.children) child.hidden = true;
    const card = document.createElement("section");
    card.className = "onboard";
    card.innerHTML = `
      <img class="app-icon" src="icon-180.png" alt="" width="88" height="88">
      <h1>Running</h1>
      <p class="lead">Your runs, analyzed on your Mac and kept on this phone. Works offline.</p>
      <ol class="steps">
        <li><div><b>Sync on your Mac.</b>It saves <code>${FILE_NAME}</code> to iCloud Drive → Garmin Dashboard.</div></li>
        <li><div><b>Import it here.</b>Tap the button and pick that file.</div></li>
        <li><div><b>Stay up to date.</b>After your next sync, tap Update at the top.</div></li>
      </ol>
      <button class="primary wide" id="phone-import">Import data</button>
      <p class="hint" id="phone-status" role="status" aria-live="polite"></p>`;
    main.prepend(card);
    const status = card.querySelector("#phone-status");
    const input = picker(async (file) => {
      status.className = "hint";
      try {
        await importFile(file, (msg) => { status.textContent = msg; });
        status.textContent = "Done.";
        location.reload();
      } catch (err) {
        status.className = "hint err";
        status.textContent = err.message;
      }
    });
    card.querySelector("#phone-import").onclick = () => input.click();
  }

  function showDataBar(main) {
    const stale = (Date.now() - new Date(info.generated_at)) / 864e5 > STALE_DAYS;
    const bar = document.createElement("div");
    bar.className = "data-bar" + (stale ? " stale" : "");
    bar.innerHTML = `<span>Synced from your Mac ${esc(relative(info.generated_at))}${stale ? ". Sync on your Mac, then tap Update." : ""}</span>
      <button type="button">Update</button><span class="phone-status" role="status" aria-live="polite"></span>`;
    const header = main.querySelector("header");
    if (header) header.after(bar); else main.prepend(bar);
    const status = bar.querySelector(".phone-status");
    const input = picker(async (file) => {
      try {
        await importFile(file, (msg) => { status.textContent = msg; });
        location.reload();
      } catch (err) {
        status.textContent = err.message;
        status.style.color = "var(--danger)";
      }
    });
    bar.querySelector("button").onclick = () => input.click();
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const main = document.querySelector("main");
    if (await ready) showDataBar(main);
    else showOnboarding(main);
  });

  // Offline support: cache the app itself (not your data, which is in IndexedDB).
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Offline cache unavailable:", err)));
  }

  window.PhoneData = { get, ready, importFile, setZoneSystem, timeInZones };
})();
