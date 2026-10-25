// Workout detail: the route map.

// ---------------------------------------------------------------- map

function zoneIndex(hr) {
  if (hr == null) return -1;
  return D.zones.findIndex((z) => hr >= z.low && hr < z.high);
}

function renderMap() {
  const s = D.streams;
  const has = s && s.lat.some((v) => v != null);
  $("map").parentElement.style.display = has ? "" : "none";
  if (!has || typeof L === "undefined") return;
  // The route is stored with the workout, but the map tiles behind it come from the internet.
  const colored = hasHr();
  $("map-hint").textContent = (colored ? "Colored by heart-rate zone." : "No heart rate was recorded, so the route isn't colored by zone.") +
    (navigator.onLine === false ? " You're offline, so the map background won't load; the route still shows." : "");
  if (!map) {
    map = L.map("map", { scrollWheelZoom: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
  }
  Object.values(mapLayers).forEach((l) => l && map.removeLayer(l));
  const group = L.featureGroup();
  // an outline under the whole route (white in light mode, near black in dark), so every zone
  // stands out from the map, the gray of Z1 included
  const runs = [[]];
  for (let i = 0; i < S.n; i++) {
    if (s.lat[i] == null) { if (runs.at(-1).length) runs.push([]); continue; }
    runs.at(-1).push([s.lat[i], s.lon[i]]);
  }
  for (const r of runs) if (r.length > 1) L.polyline(r, { color: cssVar("--route-casing"), weight: 8, opacity: 0.9, interactive: false }).addTo(group);
  let seg = [], zone = null;
  const flush = () => {
    if (seg.length > 1) L.polyline(seg, { color: zone > 0 ? cssVar(`--z${zone + 1}`) : zone === 0 ? cssVar("--map-z1") : cssVar("--elev"), weight: 4.5, opacity: 1 }).addTo(group);
  };
  for (let i = 0; i < S.n; i++) {
    if (s.lat[i] == null) continue;
    const z = zoneIndex(S.hr[i]);
    const pt = [s.lat[i], s.lon[i]];
    if (z !== zone) { seg.push(pt); flush(); seg = [pt]; zone = z; } else seg.push(pt);
  }
  flush();
  group.addTo(map);
  mapLayers.route = group;
  $("map-legend").innerHTML = !colored ? "" : D.zones.map((z, i) => `<span style="--c:var(${i ? `--z${i + 1}` : "--map-z1"})">Z${i + 1}</span>`).join("");
  map.fitBounds(group.getBounds(), { padding: [12, 12] });
}

function updateMapMarker() {
  if (!map) return;
  if (mapLayers.marker) { map.removeLayer(mapLayers.marker); mapLayers.marker = null; }
  const s = D.streams;
  if (hoverIdx == null || s.lat[hoverIdx] == null) return;
  mapLayers.marker = L.circleMarker([s.lat[hoverIdx], s.lon[hoverIdx]], {
    radius: 6, color: cssVar("--surface-1"), weight: 2, fillColor: cssVar("--text-primary"), fillOpacity: 1,
  }).addTo(map);
}

function updateMapSelection() {
  if (!map) return;
  if (mapLayers.selection) { map.removeLayer(mapLayers.selection); mapLayers.selection = null; }
  if (!selection) return;
  const s = D.streams, pts = [];
  for (let i = selection[0]; i <= selection[1]; i++) if (s.lat[i] != null) pts.push([s.lat[i], s.lon[i]]);
  if (pts.length > 1) mapLayers.selection = L.polyline(pts, { color: cssVar("--text-primary"), weight: 7, opacity: 0.35 }).addTo(map);
}
