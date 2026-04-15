(function () {
  "use strict";

  const data = window.FLOAT_VIEWER_DATA || { floats: [], counts: {} };
  const width = 1440;
  const height = 720;
  const ns = "http://www.w3.org/2000/svg";
  const categoryOrder = ["dm", "rt", "flagged_dm"];
  const LAND_URL = "assets/world_land.geojson";
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 32;

  const state = {
    selectedId: null,
    filters: { dm: true, rt: false, flagged_dm: false },
    sensorFilters: new Set(),   // empty = no sensor constraint
    yearRange: null,            // [minYear, maxYear] inclusive; null = all
    zoom: { scale: 1, tx: 0, ty: 0 },
  };

  const elements = {
    map: document.getElementById("trajectory-map"),
    detail: document.getElementById("detail-content"),
    empty: document.getElementById("detail-empty"),
    search: document.getElementById("float-search"),
    searchResults: document.getElementById("search-results"),
    searchCount: document.getElementById("search-count"),
    totals: document.getElementById("map-summary"),
  };

  const SENSORS = [
    { key: "BBP700",            label: "BBP700" },
    { key: "CHLA_CALIBRATED",   label: "CHLA"   },
    { key: "DOXY",              label: "DOXY"   },
    { key: "NITRATE",           label: "NO3"    },
    { key: "PH_IN_SITU_TOTAL",  label: "PH"     },
  ];

  const layerGroups = {};
  const nodeIndex = new Map();
  const floatIndex = new Map(data.floats.map((entry) => [entry.id, entry]));
  let zoomLayer = null;

  // ---------- projection ----------
  function lonToX(lon) { return ((normalizeLon(lon) + 180) / 360) * width; }
  function latToY(lat) { return ((90 - lat) / 180) * height; }
  function normalizeLon(lon) {
    let v = lon;
    while (v > 180) v -= 360;
    while (v < -180) v += 360;
    return v;
  }

  function createSvgNode(tag, attrs) {
    const node = document.createElementNS(ns, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
    return node;
  }

  function splitTrajectory(coords) {
    if (!coords || coords.length < 2) return [];
    const segments = [];
    let current = [coords[0]];
    for (let i = 1; i < coords.length; i += 1) {
      const prev = coords[i - 1];
      const next = coords[i];
      if (Math.abs(normalizeLon(next[0]) - normalizeLon(prev[0])) > 180) {
        if (current.length > 1) segments.push(current);
        current = [next];
      } else {
        current.push(next);
      }
    }
    if (current.length > 1) segments.push(current);
    return segments;
  }

  // ---------- map background: graticule + land ----------
  function buildGraticule(parent) {
    const frame = createSvgNode("rect", {
      x: 0, y: 0, width, height, class: "map-frame", rx: 28, ry: 28,
    });
    parent.appendChild(frame);

    for (let lat = -60; lat <= 60; lat += 30) {
      const y = latToY(lat);
      parent.appendChild(createSvgNode("line",
        { x1: 0, y1: y, x2: width, y2: y, class: "graticule" }));
      const label = createSvgNode("text",
        { x: 16, y: Math.max(18, y - 6), class: "graticule-label" });
      label.textContent = lat === 0 ? "Equator" : `${Math.abs(lat)}${lat > 0 ? "N" : "S"}`;
      parent.appendChild(label);
    }
    for (let lon = -120; lon <= 180; lon += 60) {
      const x = lonToX(lon);
      parent.appendChild(createSvgNode("line",
        { x1: x, y1: 0, x2: x, y2: height, class: "graticule" }));
      const label = createSvgNode("text", {
        x: Math.min(width - 40, Math.max(14, x + 8)),
        y: height - 14, class: "graticule-label",
      });
      label.textContent = lon === 0 ? "0" : `${Math.abs(lon)}${lon > 0 ? "E" : "W"}`;
      parent.appendChild(label);
    }
  }

  function ringToPath(ring) {
    if (!ring || !ring.length) return "";
    const parts = ring.map(([lon, lat], i) => {
      const x = lonToX(lon).toFixed(2);
      const y = latToY(lat).toFixed(2);
      return `${i === 0 ? "M" : "L"}${x},${y}`;
    });
    return parts.join(" ") + " Z";
  }

  function polygonToPath(polygons) {
    // polygons: array of rings (outer + holes)
    return polygons.map(ringToPath).join(" ");
  }

  function drawLand(parent, geojson) {
    const group = createSvgNode("g", { class: "land-layer" });
    const features = (geojson && geojson.features) || [];
    features.forEach((feat) => {
      const geom = feat.geometry;
      if (!geom) return;
      const pathD = [];
      if (geom.type === "Polygon") {
        pathD.push(polygonToPath(geom.coordinates));
      } else if (geom.type === "MultiPolygon") {
        geom.coordinates.forEach((poly) => pathD.push(polygonToPath(poly)));
      }
      if (pathD.length) {
        group.appendChild(createSvgNode("path", { d: pathD.join(" "), class: "land" }));
      }
    });
    parent.appendChild(group);
  }

  // ---------- trajectories ----------
  function renderTrajectories(parent) {
    categoryOrder.forEach((category) => {
      const group = createSvgNode("g", { "data-category": category });
      layerGroups[category] = group;
      parent.appendChild(group);
    });

    data.floats.forEach((entry) => {
      const group = createSvgNode("g", {
        "data-id": entry.id,
        "data-category": entry.category,
      });

      const onClick = (ev) => {
        ev.stopPropagation();
        selectFloat(entry.id);
      };

      splitTrajectory(entry.trajectory).forEach((segment) => {
        const points = segment
          .map(([lon, lat]) => `${lonToX(lon).toFixed(2)},${latToY(lat).toFixed(2)}`)
          .join(" ");
        // wide invisible hit-strip for easier clicking
        const hit = createSvgNode("polyline",
          { points, class: "trajectory-hit" });
        hit.addEventListener("click", onClick);
        group.appendChild(hit);

        const polyline = createSvgNode("polyline",
          { points, class: `trajectory ${entry.category}` });
        polyline.addEventListener("click", onClick);
        group.appendChild(polyline);
      });

      if (entry.trajectory.length) {
        const [lon, lat] = entry.trajectory[entry.trajectory.length - 1];
        const endpoint = createSvgNode("circle", {
          cx: lonToX(lon).toFixed(2),
          cy: latToY(lat).toFixed(2),
          r: 3.4,
          class: `endpoint ${entry.category}`,
        });
        endpoint.addEventListener("click", onClick);
        group.appendChild(endpoint);
      }

      layerGroups[entry.category].appendChild(group);
      nodeIndex.set(entry.id, group);
    });
  }

  // ---------- filtering ----------
  function entryYearSpan(entry) {
    const parse = (s) => {
      const y = parseInt(String(s || "").slice(0, 4), 10);
      return Number.isFinite(y) ? y : null;
    };
    return [parse(entry.start_date), parse(entry.end_date)];
  }

  function entryMatches(entry) {
    if (!state.filters[entry.category]) return false;
    if (state.sensorFilters.size > 0) {
      const vars = new Set(entry.variables || []);
      for (const sensor of state.sensorFilters) {
        if (!vars.has(sensor)) return false;
      }
    }
    if (state.yearRange) {
      const [lo, hi] = state.yearRange;
      const [s, e] = entryYearSpan(entry);
      if (s !== null && e !== null) {
        if (e < lo || s > hi) return false;
      }
    }
    return true;
  }

  function updateLayers() {
    nodeIndex.forEach((node, id) => {
      const entry = floatIndex.get(id);
      const visible = entryMatches(entry);
      node.classList.toggle("hidden-layer", !visible);
    });
    categoryOrder.forEach((cat) => {
      const visibleCat = !!state.filters[cat];
      if (layerGroups[cat]) {
        layerGroups[cat].classList.toggle("hidden-layer", !visibleCat);
      }
    });
    const visibleCount = data.floats.filter(entryMatches).length;
    const sensorNote = state.sensorFilters.size
      ? ` · sensors: ${Array.from(state.sensorFilters).map(
          (k) => (SENSORS.find((s) => s.key === k) || { label: k }).label
        ).join("+")}`
      : "";
    const yearNote = state.yearRange
      ? ` · ${state.yearRange[0]}–${state.yearRange[1]}`
      : "";
    elements.totals.textContent = `${visibleCount} visible trajectories${sensorNote}${yearNote}`;
  }

  // ---------- detail panel ----------
  function figureCard(figure) {
    return `
      <figure class="gallery-card">
        <a href="${figure.path}" target="_blank" rel="noopener noreferrer">
          <img loading="lazy" src="${figure.path}" alt="${figure.label}">
          <figcaption>
            <strong>${figure.label}</strong>
            <span>${figure.file_name}</span>
          </figcaption>
        </a>
      </figure>
    `;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function selectFloat(id) {
    const entry = floatIndex.get(id);
    if (!entry) return;
    if (!state.filters[entry.category]) {
      state.filters[entry.category] = true;
      const checkbox = document.querySelector(`[data-filter="${entry.category}"]`);
      if (checkbox) checkbox.checked = true;
      updateLayers();
    }
    state.selectedId = id;

    nodeIndex.forEach((node, nodeId) => {
      const selected = nodeId === id;
      node.querySelectorAll(".trajectory, .endpoint").forEach((child) => {
        child.classList.toggle("selected", selected);
      });
      if (selected && node.parentNode) {
        node.parentNode.appendChild(node);
      }
    });

    elements.empty.hidden = true;
    elements.detail.hidden = false;

    const chips = (entry.variables || [])
      .map((v) => `<span class="header-tag">${escapeHtml(v)}</span>`).join("");
    const modes = (entry.data_modes || []).length ? entry.data_modes.join(", ") : "n/a";
    const reasonBlock = entry.screening_reason
      ? `<div class="meta-card"><strong>Flag Reason</strong><span>${escapeHtml(entry.screening_reason)}</span></div>`
      : "";
    const gallery = entry.figures.length
      ? entry.figures.map(figureCard).join("")
      : '<div class="empty-state"><p>No figures for this float.</p></div>';
    const ncLink = entry.nc_path
      ? `<a href="${entry.nc_path}" target="_blank" rel="noopener noreferrer">Open NetCDF</a>` : "";
    const screeningLink = entry.screening_path
      ? `<a href="${entry.screening_path}" target="_blank" rel="noopener noreferrer">Open Screening Note</a>` : "";

    elements.detail.innerHTML = `
      <div class="detail-heading">
        <div>
          <p class="card-kicker">${escapeHtml(entry.root_label)}</p>
          <h2>${escapeHtml(entry.wmo)}</h2>
        </div>
        <span class="chip ${escapeHtml(entry.category)}">${escapeHtml(entry.category_label)}</span>
      </div>
      ${ncLink || screeningLink ? `<div class="detail-links">${ncLink}${screeningLink}</div>` : ""}
      <div class="meta-grid">
        <div class="meta-card"><strong>Profiles</strong><span>${entry.n_profiles}</span></div>
        <div class="meta-card"><strong>Cycles</strong><span>${entry.cycle_min} to ${entry.cycle_max}</span></div>
        <div class="meta-card"><strong>Period</strong><span>${escapeHtml(entry.start_date)} to ${escapeHtml(entry.end_date)}</span></div>
        <div class="meta-card"><strong>Combo</strong><span>${escapeHtml(entry.combo)}</span></div>
        <div class="meta-card"><strong>Modes</strong><span>${escapeHtml(modes)}</span></div>
        <div class="meta-card"><strong>Figures</strong><span>${entry.figures.length}</span></div>
        ${reasonBlock}
      </div>
      <div class="chip-row">${chips}</div>
      <h3 class="gallery-title">Time Series and Scatter Figures</h3>
      <div class="gallery-grid">${gallery}</div>
    `;
    elements.searchCount.textContent = `${entry.wmo} selected`;
  }

  // ---------- search ----------
  function searchMatches(term) {
    const normalized = term.trim().toLowerCase();
    if (!normalized) return [];
    return data.floats.filter((entry) =>
      entry.wmo.toLowerCase().includes(normalized) ||
      entry.combo.toLowerCase().includes(normalized) ||
      entry.category_label.toLowerCase().includes(normalized)
    );
  }

  function renderSearchResults(matches) {
    elements.searchResults.innerHTML = "";
    elements.searchResults.classList.toggle("active", !!matches.length);
    if (!matches.length) {
      elements.searchCount.textContent = "";
      return;
    }
    elements.searchCount.textContent = `${matches.length} match${matches.length > 1 ? "es" : ""}`;
    matches.slice(0, 12).forEach((entry) => {
      const a = document.createElement("a");
      a.href = "#";
      a.innerHTML = `<span><strong>${entry.wmo}</strong> &nbsp;${entry.category_label}</span><span>${entry.combo}</span>`;
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        selectFloat(entry.id);
        elements.searchResults.innerHTML = "";
        elements.searchResults.classList.remove("active");
      });
      elements.searchResults.appendChild(a);
    });
  }

  // ---------- sensor filters UI ----------
  function buildSensorFilters() {
    const container = document.getElementById("sensor-filter-row");
    if (!container) return;
    SENSORS.forEach((sensor) => {
      const label = document.createElement("label");
      label.className = "sensor-toggle";
      label.innerHTML = `
        <input type="checkbox" data-sensor="${sensor.key}">
        <span>${sensor.label}</span>
      `;
      const cb = label.querySelector("input");
      cb.addEventListener("change", () => {
        if (cb.checked) state.sensorFilters.add(sensor.key);
        else state.sensorFilters.delete(sensor.key);
        updateLayers();
      });
      container.appendChild(label);
    });
  }

  // ---------- year range slider UI ----------
  function buildYearRangeSlider() {
    const container = document.getElementById("year-filter-row");
    if (!container) return;

    // Global min/max year from all floats.
    let yMin = Infinity, yMax = -Infinity;
    data.floats.forEach((entry) => {
      const [s, e] = entryYearSpan(entry);
      if (s !== null && s < yMin) yMin = s;
      if (e !== null && e > yMax) yMax = e;
    });
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return;
    if (yMax < yMin) yMax = yMin;

    container.innerHTML = `
      <span class="sensor-kicker">Years:</span>
      <input type="range" class="year-slider" id="year-start" min="${yMin}" max="${yMax}" value="${yMin}" step="1">
      <span class="year-value" id="year-start-value">${yMin}</span>
      <span class="year-dash">—</span>
      <input type="range" class="year-slider" id="year-end" min="${yMin}" max="${yMax}" value="${yMax}" step="1">
      <span class="year-value" id="year-end-value">${yMax}</span>
      <button type="button" class="year-reset" id="year-reset">Reset</button>
    `;

    const startEl = document.getElementById("year-start");
    const endEl = document.getElementById("year-end");
    const startLabel = document.getElementById("year-start-value");
    const endLabel = document.getElementById("year-end-value");

    const applyRange = () => {
      let lo = parseInt(startEl.value, 10);
      let hi = parseInt(endEl.value, 10);
      if (lo > hi) { const t = lo; lo = hi; hi = t; }
      startLabel.textContent = lo;
      endLabel.textContent = hi;
      if (lo === yMin && hi === yMax) {
        state.yearRange = null;
      } else {
        state.yearRange = [lo, hi];
      }
      updateLayers();
    };

    startEl.addEventListener("input", applyRange);
    endEl.addEventListener("input", applyRange);
    document.getElementById("year-reset").addEventListener("click", () => {
      startEl.value = yMin;
      endEl.value = yMax;
      applyRange();
    });
  }

  // ---------- zoom / pan ----------
  function applyZoom() {
    if (!zoomLayer) return;
    const { scale, tx, ty } = state.zoom;
    zoomLayer.setAttribute("transform", `translate(${tx},${ty}) scale(${scale})`);
  }

  function clampTranslate() {
    const s = state.zoom.scale;
    // keep the rendered map fully inside viewBox
    const minTx = width - width * s;
    const minTy = height - height * s;
    if (state.zoom.tx > 0) state.zoom.tx = 0;
    if (state.zoom.ty > 0) state.zoom.ty = 0;
    if (state.zoom.tx < minTx) state.zoom.tx = minTx;
    if (state.zoom.ty < minTy) state.zoom.ty = minTy;
  }

  function svgMouseCoords(ev) {
    const rect = elements.map.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * width,
      y: ((ev.clientY - rect.top) / rect.height) * height,
    };
  }

  function bindZoom() {
    elements.map.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const { x, y } = svgMouseCoords(ev);
      const factor = ev.deltaY < 0 ? 1.2 : 1 / 1.2;
      const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.zoom.scale * factor));
      const actualFactor = newScale / state.zoom.scale;
      state.zoom.tx = x - actualFactor * (x - state.zoom.tx);
      state.zoom.ty = y - actualFactor * (y - state.zoom.ty);
      state.zoom.scale = newScale;
      clampTranslate();
      applyZoom();
    }, { passive: false });

    let dragging = false;
    let last = null;
    elements.map.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      last = svgMouseCoords(ev);
      elements.map.classList.add("dragging");
    });
    window.addEventListener("mousemove", (ev) => {
      if (!dragging) return;
      const p = svgMouseCoords(ev);
      state.zoom.tx += p.x - last.x;
      state.zoom.ty += p.y - last.y;
      last = p;
      clampTranslate();
      applyZoom();
    });
    window.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        elements.map.classList.remove("dragging");
      }
    });
    // double-click to reset
    elements.map.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      state.zoom = { scale: 1, tx: 0, ty: 0 };
      applyZoom();
    });
  }

  // ---------- controls ----------
  function bindControls() {
    document.querySelectorAll("[data-filter]").forEach((checkbox) => {
      checkbox.addEventListener("change", (ev) => {
        state.filters[ev.target.dataset.filter] = ev.target.checked;
        updateLayers();
      });
    });

    elements.search.addEventListener("input", () => {
      renderSearchResults(searchMatches(elements.search.value));
    });
    elements.search.addEventListener("focus", () => {
      if (elements.search.value.trim()) {
        renderSearchResults(searchMatches(elements.search.value));
      }
    });
    document.getElementById("search-button").addEventListener("click", () => {
      const matches = searchMatches(elements.search.value);
      if (matches.length) selectFloat(matches[0].id);
    });

    const firstDm = data.floats.find((entry) => entry.category === "dm");
    if (firstDm) selectFloat(firstDm.id);
  }

  // ---------- bootstrap ----------
  function bootstrap() {
    elements.map.setAttribute("viewBox", `0 0 ${width} ${height}`);

    zoomLayer = createSvgNode("g", { class: "zoom-layer" });
    elements.map.appendChild(zoomLayer);

    buildGraticule(zoomLayer);

    // kick off async land load, then render trajectories on top
    fetch(LAND_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((geojson) => { if (geojson) drawLand(zoomLayer, geojson); })
      .catch(() => { /* offline / missing file is OK */ })
      .finally(() => {
        renderTrajectories(zoomLayer);
        updateLayers();
      });

    buildSensorFilters();
    buildYearRangeSlider();
    bindZoom();
    bindControls();
  }

  bootstrap();
})();
