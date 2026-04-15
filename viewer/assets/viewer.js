(function () {
  "use strict";

  const data = window.FLOAT_VIEWER_DATA || { floats: [], counts: {} };
  const width = 1440;
  const height = 720;
  const ns = "http://www.w3.org/2000/svg";
  const categoryOrder = ["dm", "rt", "flagged_dm"];

  const state = {
    selectedId: null,
    filters: {
      dm: true,
      rt: false,
      flagged_dm: false,
    },
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

  const layerGroups = {};
  const nodeIndex = new Map();
  const floatIndex = new Map(data.floats.map((entry) => [entry.id, entry]));

  function lonToX(lon) {
    return ((normalizeLon(lon) + 180) / 360) * width;
  }

  function latToY(lat) {
    return ((90 - lat) / 180) * height;
  }

  function normalizeLon(lon) {
    let value = lon;
    while (value > 180) {
      value -= 360;
    }
    while (value < -180) {
      value += 360;
    }
    return value;
  }

  function createSvgNode(tag, attrs) {
    const node = document.createElementNS(ns, tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      node.setAttribute(key, value);
    });
    return node;
  }

  function splitTrajectory(coords) {
    if (!coords || coords.length < 2) {
      return [];
    }
    const segments = [];
    let current = [coords[0]];
    for (let i = 1; i < coords.length; i += 1) {
      const prev = coords[i - 1];
      const next = coords[i];
      if (Math.abs(normalizeLon(next[0]) - normalizeLon(prev[0])) > 180) {
        if (current.length > 1) {
          segments.push(current);
        }
        current = [next];
      } else {
        current.push(next);
      }
    }
    if (current.length > 1) {
      segments.push(current);
    }
    return segments;
  }

  function buildGraticule() {
    const frame = createSvgNode("rect", {
      x: 0,
      y: 0,
      width,
      height,
      class: "map-frame",
      rx: 28,
      ry: 28,
    });
    elements.map.appendChild(frame);

    for (let lat = -60; lat <= 60; lat += 30) {
      const y = latToY(lat);
      elements.map.appendChild(createSvgNode("line", {
        x1: 0,
        y1: y,
        x2: width,
        y2: y,
        class: "graticule",
      }));
      const label = createSvgNode("text", {
        x: 16,
        y: Math.max(18, y - 6),
        class: "graticule-label",
      });
      label.textContent = lat === 0 ? "Equator" : `${Math.abs(lat)}${lat > 0 ? "N" : "S"}`;
      elements.map.appendChild(label);
    }

    for (let lon = -120; lon <= 180; lon += 60) {
      const x = lonToX(lon);
      elements.map.appendChild(createSvgNode("line", {
        x1: x,
        y1: 0,
        x2: x,
        y2: height,
        class: "graticule",
      }));
      const label = createSvgNode("text", {
        x: Math.min(width - 40, Math.max(14, x + 8)),
        y: height - 14,
        class: "graticule-label",
      });
      if (lon === 0) {
        label.textContent = "0";
      } else {
        label.textContent = `${Math.abs(lon)}${lon > 0 ? "E" : "W"}`;
      }
      elements.map.appendChild(label);
    }
  }

  function renderTrajectories() {
    categoryOrder.forEach((category) => {
      const group = createSvgNode("g", { "data-category": category });
      layerGroups[category] = group;
      elements.map.appendChild(group);
    });

    data.floats.forEach((entry) => {
      const group = createSvgNode("g", {
        "data-id": entry.id,
        "data-category": entry.category,
      });

      splitTrajectory(entry.trajectory).forEach((segment) => {
        const points = segment
          .map(([lon, lat]) => `${lonToX(lon).toFixed(2)},${latToY(lat).toFixed(2)}`)
          .join(" ");
        const polyline = createSvgNode("polyline", {
          points,
          class: `trajectory ${entry.category}`,
        });
        polyline.addEventListener("click", () => selectFloat(entry.id));
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
        endpoint.addEventListener("click", () => selectFloat(entry.id));
        group.appendChild(endpoint);
      }

      layerGroups[entry.category].appendChild(group);
      nodeIndex.set(entry.id, group);
    });
  }

  function updateLayers() {
    categoryOrder.forEach((category) => {
      const visible = !!state.filters[category];
      if (layerGroups[category]) {
        layerGroups[category].classList.toggle("hidden-layer", !visible);
      }
    });
    const visibleCount = data.floats.filter((entry) => state.filters[entry.category]).length;
    elements.totals.textContent = `${visibleCount} visible trajectories`;
  }

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
    if (!entry) {
      return;
    }
    if (!state.filters[entry.category]) {
      state.filters[entry.category] = true;
      const checkbox = document.querySelector(`[data-filter="${entry.category}"]`);
      if (checkbox) {
        checkbox.checked = true;
      }
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
      .map((value) => `<span class="header-tag">${escapeHtml(value)}</span>`)
      .join("");
    const modes = (entry.data_modes || []).length ? entry.data_modes.join(", ") : "n/a";
    const reasonBlock = entry.screening_reason
      ? `<div class="meta-card"><strong>Flag Reason</strong><span>${escapeHtml(entry.screening_reason)}</span></div>`
      : "";
    const gallery = entry.figures.length
      ? entry.figures.map(figureCard).join("")
      : '<div class="empty-state"><p>No figures found for this float yet.</p></div>';

    elements.detail.innerHTML = `
      <div class="detail-heading">
        <div>
          <p class="card-kicker">${escapeHtml(entry.root_label)}</p>
          <h2>${escapeHtml(entry.wmo)}</h2>
        </div>
        <span class="chip ${escapeHtml(entry.category)}">${escapeHtml(entry.category_label)}</span>
      </div>
      <div class="detail-links">
        <a href="${entry.nc_path}" target="_blank" rel="noopener noreferrer">Open NetCDF</a>
        ${entry.screening_path ? `<a href="${entry.screening_path}" target="_blank" rel="noopener noreferrer">Open Screening Note</a>` : ""}
      </div>
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
      <p>${escapeHtml(entry.source_path)}</p>
      <h3 class="gallery-title">Time Series and Scatter Figures</h3>
      <div class="gallery-grid">${gallery}</div>
    `;
    elements.searchCount.textContent = `${entry.wmo} selected`;
  }

  function searchMatches(term) {
    const normalized = term.trim().toLowerCase();
    if (!normalized) {
      return [];
    }
    return data.floats.filter((entry) =>
      entry.wmo.toLowerCase().includes(normalized) ||
      entry.combo.toLowerCase().includes(normalized) ||
      entry.category_label.toLowerCase().includes(normalized)
    );
  }

  function renderSearchResults(matches) {
    elements.searchResults.innerHTML = "";
    if (!matches.length) {
      elements.searchCount.textContent = "";
      return;
    }

    elements.searchCount.textContent = `${matches.length} match${matches.length > 1 ? "es" : ""}`;
    matches.slice(0, 8).forEach((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.innerHTML = `<strong>${entry.wmo}</strong> • ${entry.category_label} • ${entry.combo}`;
      button.addEventListener("click", () => {
        selectFloat(entry.id);
        elements.searchResults.innerHTML = "";
      });
      elements.searchResults.appendChild(button);
    });
  }

  function bindControls() {
    document.querySelectorAll("[data-filter]").forEach((checkbox) => {
      checkbox.addEventListener("change", (event) => {
        state.filters[event.target.dataset.filter] = event.target.checked;
        updateLayers();
      });
    });

    elements.search.addEventListener("input", () => {
      renderSearchResults(searchMatches(elements.search.value));
    });

    document.getElementById("search-button").addEventListener("click", () => {
      const matches = searchMatches(elements.search.value);
      if (matches.length) {
        selectFloat(matches[0].id);
      }
    });

    const firstDm = data.floats.find((entry) => entry.category === "dm");
    if (firstDm) {
      selectFloat(firstDm.id);
    }
  }

  function bootstrap() {
    elements.map.setAttribute("viewBox", `0 0 ${width} ${height}`);
    buildGraticule();
    renderTrajectories();
    updateLayers();
    bindControls();
  }

  bootstrap();
})();
