"""Generate a static HTML viewer for BGC-Argo DM / RT / flagged-DM floats.

Standalone version — no dependency on the bgc-argo-pipeline Python package.
Reads per-float NetCDFs from DM / RT roots, collects their figure galleries,
and writes an `index.html` + `viewer_data.js` + `assets/` bundle that can be
opened directly in a browser or served as a static site.

Usage:
    python build_viewer.py \\
        --dm-root   /data/rd_exchange/amignot/BGC_Argo/WEEKLY_UPDATE/FLOATS_DM \\
        --rt-root   /data/rd_exchange/amignot/BGC_Argo/WEEKLY_UPDATE/FLOATS_RT \\
        --output-dir ./output \\
        --link-figures

If --link-figures is set, figure PNGs are symlinked (or copied when symlinks
fail) under ``<output-dir>/figures/<category>/<wmo>/`` so the generated site
is self-contained and shippable. Otherwise the HTML points at the absolute
paths on disk (only viewable from a host that can read them).

A YAML config (``config.yaml`` in the repo root, or --config) can supply the
same options; CLI flags override config values.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

import netCDF4
import numpy as np


FIGURE_LABELS = {
    "physical": "Physical Time Series",
    "bio_optics": "Bio-optics Time Series",
    "bio_optics_total": "Bio-optics Total",
    "poc": "POC Time Series",
    "oxygen_canyon": "Oxygen and CANYON",
    "validation": "Validation Scatter",
    "multiobs_light": "MULTIOBS Light Matchups",
    "carbonate": "Carbonate System",
}

FIGURE_ORDER = [
    "physical",
    "bio_optics",
    "bio_optics_total",
    "poc",
    "oxygen_canyon",
    "carbonate",
    "validation",
    "multiobs_light",
]

CATEGORY_META = {
    "dm": {"label": "DM", "root_label": "FLOATS_DM"},
    "rt": {"label": "RT", "root_label": "FLOATS_RT"},
    "flagged_dm": {"label": "Flagged DM", "root_label": "FLAGGED_DM"},
}

KNOWN_VARIABLES = [
    "BBP700", "BBP700_SMALL", "BBP700_LARGE",
    "CHLA_CALIBRATED", "DOXY", "NITRATE", "PH_IN_SITU_TOTAL",
    "POC_TOTAL", "POC_SMALL", "POC_LARGE",
]

FILL = 99999.0
MAX_TRAJECTORY_POINTS = 80
ARGO_EPOCH = datetime(1950, 1, 1, tzinfo=timezone.utc)

REPO_ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = REPO_ROOT / "config.yaml"
DEFAULT_OUTPUT = REPO_ROOT / "output"
ASSETS_SRC = REPO_ROOT / "viewer" / "assets"


def juld_to_datetime(juld):
    return ARGO_EPOCH + timedelta(days=float(juld))


def _normalize_lon(values):
    arr = np.asarray(values, dtype=np.float64)
    arr = np.where(arr > 180.0, arr - 360.0, arr)
    arr = np.where(arr < -180.0, arr + 360.0, arr)
    return arr


def _safe_array(var):
    arr = np.asarray(var[:], dtype=np.float64)
    if hasattr(var[:], "mask"):
        arr[var[:].mask] = np.nan
    arr[np.abs(arr) >= FILL] = np.nan
    return arr


def _simplify(points, max_points=MAX_TRAJECTORY_POINTS):
    if len(points) <= max_points:
        return points
    step = max(1, int(np.ceil(len(points) / max_points)))
    reduced = points[::step]
    if reduced[-1] != points[-1]:
        reduced.append(points[-1])
    return reduced


def _figure_key(path):
    stem = Path(path).stem
    suffix = stem.split("_", 1)[1] if "_" in stem else stem
    try:
        idx = FIGURE_ORDER.index(suffix)
    except ValueError:
        idx = len(FIGURE_ORDER)
    return idx, suffix


def _figure_label(path):
    stem = Path(path).stem
    suffix = stem.split("_", 1)[1] if "_" in stem else stem
    return FIGURE_LABELS.get(suffix, suffix.replace("_", " ").title())


def _load_config(path):
    if not path or not Path(path).exists():
        return {}
    try:
        import yaml
    except ImportError:
        raise SystemExit("pyyaml required for --config; install with `pip install pyyaml`")
    with open(path) as fh:
        return yaml.safe_load(fh) or {}


def _iter_float_files(dm_root, rt_root):
    if dm_root and dm_root.exists():
        for combo_dir in sorted(dm_root.iterdir()):
            if not combo_dir.is_dir() or combo_dir.name == "FLAGGED":
                continue
            for nc_path in sorted(combo_dir.glob("*.nc")):
                yield "dm", combo_dir.name, nc_path

        flagged_root = dm_root / "FLAGGED"
        if flagged_root.exists():
            for combo_dir in sorted(flagged_root.iterdir()):
                if not combo_dir.is_dir() or combo_dir.name in {"figures", "screening"}:
                    continue
                for nc_path in sorted(combo_dir.glob("*.nc")):
                    yield "flagged_dm", combo_dir.name, nc_path

    if rt_root and rt_root.exists():
        for combo_dir in sorted(rt_root.iterdir()):
            if not combo_dir.is_dir():
                continue
            for nc_path in sorted(combo_dir.glob("*.nc")):
                yield "rt", combo_dir.name, nc_path


def _figure_dir(dm_root, rt_root, category, combo, wmo):
    if category == "flagged_dm":
        return dm_root / "FLAGGED" / "figures" / wmo
    base = dm_root if category == "dm" else rt_root
    return base / combo / "figures" / wmo


def _screening_path(dm_root, wmo):
    candidate = dm_root / "FLAGGED" / "screening" / f"{wmo}.txt"
    return candidate if candidate.exists() else None


def _link_or_copy(src, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() or dst.is_symlink():
        return
    try:
        dst.symlink_to(src)
    except OSError:
        shutil.copy2(src, dst)


def _recompress_figure(src, dst, max_width, quality):
    """Resize+JPEG-encode src into dst (skipped if dst is fresher)."""
    from PIL import Image
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        im = im.convert("RGB")
        if im.width > max_width:
            ratio = max_width / im.width
            im = im.resize((max_width, int(im.height * ratio)), Image.LANCZOS)
        im.save(dst, "JPEG", quality=quality, optimize=True, progressive=True)


def _figure_entry(fig_path, output_dir, category, wmo, link_figures,
                  recompress=False, max_width=1200, quality=78):
    label = _figure_label(fig_path)
    if recompress:
        local = output_dir / "figures" / category / wmo / (fig_path.stem + ".jpg")
        try:
            _recompress_figure(fig_path, local, max_width, quality)
        except Exception as exc:
            print(f"  ! recompress {fig_path.name}: {exc}")
            return None
        rel = local.relative_to(output_dir).as_posix()
        return {"label": label, "path": rel, "file_name": local.name}
    if link_figures:
        local = output_dir / "figures" / category / wmo / fig_path.name
        _link_or_copy(fig_path, local)
        rel = local.relative_to(output_dir).as_posix()
    else:
        rel = fig_path.as_posix()
    return {"label": label, "path": rel, "file_name": fig_path.name}


def _nc_rel(nc_path, output_dir, category, wmo, link_figures):
    if link_figures:
        local = output_dir / "netcdf" / category / wmo / nc_path.name
        _link_or_copy(nc_path, local)
        return local.relative_to(output_dir).as_posix()
    return nc_path.as_posix()


def _scan_float_file(nc_path, dm_root, rt_root, category, combo, output_dir,
                     link_figures, include_figures=True, recompress=False,
                     max_width=1200, quality=78, drop_netcdf=False):
    with netCDF4.Dataset(str(nc_path), "r") as nc:
        lon = _normalize_lon(_safe_array(nc.variables["LONGITUDE"]))
        lat = _safe_array(nc.variables["LATITUDE"])
        juld = _safe_array(nc.variables["JULD"])
        cycles = np.asarray(nc.variables["CYCLE_NUMBER"][:]).astype(int)

        mask = np.isfinite(lon) & np.isfinite(lat)
        trajectory = [(float(lo), float(la)) for lo, la in zip(lon[mask], lat[mask])]
        trajectory = _simplify(trajectory)

        finite_juld = juld[np.isfinite(juld)]
        start_date = end_date = "n/a"
        if finite_juld.size:
            start_date = juld_to_datetime(float(np.nanmin(finite_juld))).strftime("%Y-%m-%d")
            end_date = juld_to_datetime(float(np.nanmax(finite_juld))).strftime("%Y-%m-%d")

        data_modes = set()
        for name in nc.variables:
            if not name.endswith("_DATA_MODE"):
                continue
            raw = nc.variables[name][:]
            values = np.asarray(raw).astype("U1").ravel()
            data_modes.update(value.strip() for value in values if value.strip())

        present_vars = [name for name in KNOWN_VARIABLES if name in nc.variables]

    wmo = nc_path.stem
    figures = []
    if include_figures:
        fig_dir = _figure_dir(dm_root, rt_root, category, combo, wmo)
        if fig_dir.exists():
            for fig_path in sorted(fig_dir.glob("*.png"), key=_figure_key):
                entry = _figure_entry(fig_path, output_dir, category, wmo,
                                      link_figures, recompress=recompress,
                                      max_width=max_width, quality=quality)
                if entry is not None:
                    figures.append(entry)

    screening_src = _screening_path(dm_root, wmo) if category == "flagged_dm" else None
    screening_reason = None
    screening_rel = None
    if screening_src is not None:
        screening_reason = screening_src.read_text().strip().replace("\n", " | ")
        if link_figures:
            local = output_dir / "screening" / f"{wmo}.txt"
            _link_or_copy(screening_src, local)
            screening_rel = local.relative_to(output_dir).as_posix()
        else:
            screening_rel = screening_src.as_posix()

    return {
        "id": f"{category}:{wmo}",
        "wmo": wmo,
        "category": category,
        "category_label": CATEGORY_META[category]["label"],
        "root_label": CATEGORY_META[category]["root_label"],
        "combo": combo,
        "source_path": str(nc_path),
        "nc_path": None if drop_netcdf or not include_figures
                       else _nc_rel(nc_path, output_dir, category, wmo, link_figures),
        "screening_path": screening_rel,
        "screening_reason": screening_reason,
        "n_profiles": int(len(cycles)),
        "cycle_min": int(np.min(cycles)) if len(cycles) else 0,
        "cycle_max": int(np.max(cycles)) if len(cycles) else 0,
        "start_date": start_date,
        "end_date": end_date,
        "data_modes": sorted(data_modes),
        "variables": present_vars,
        "figures": figures,
        "trajectory": trajectory,
    }


def _build_payload(dm_root, rt_root, output_dir, link_figures,
                   include_figures=True, recompress=False,
                   max_width=1200, quality=78, drop_netcdf=False):
    floats = []
    counts = {"dm": 0, "rt": 0, "flagged_dm": 0}
    for category, combo, nc_path in _iter_float_files(dm_root, rt_root):
        try:
            entry = _scan_float_file(nc_path, dm_root, rt_root, category, combo,
                                     output_dir, link_figures, include_figures,
                                     recompress=recompress, max_width=max_width,
                                     quality=quality, drop_netcdf=drop_netcdf)
        except Exception as exc:
            print(f"  ! skip {nc_path}: {exc}")
            continue
        floats.append(entry)
        counts[category] += 1

    floats.sort(key=lambda item: (item["category"], item["wmo"]))
    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "counts": counts,
        "sources": {
            "dm_root": str(dm_root) if dm_root else "",
            "rt_root": str(rt_root) if rt_root else "",
            "viewer_dir": str(output_dir),
        },
        "floats": floats,
    }


def _html_index(payload):
    counts = payload["counts"]
    total = sum(counts.values())
    sources = payload["sources"]
    generated = html.escape(payload["generated_at"])
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BGC-Argo Float Viewer</title>
  <link rel="stylesheet" href="assets/viewer.css">
</head>
<body>
  <header class="header">
    <div class="header-inner">
      <div class="header-grid">
        <div>
          <p class="eyebrow">BGC-Argo Float Viewer</p>
          <h1>Trajectories, figures, and quick diagnostics.</h1>
          <p class="header-lead">
            Explore delayed-mode, real-time, and flagged delayed-mode floats on one global view.
            Click a trajectory to open the full time-series and scatter-plot gallery for that float.
          </p>
          <div class="header-tags">
            <span class="header-tag">Default map: DM trajectories</span>
            <span class="header-tag">Selectable RT and flagged DM layers</span>
            <span class="header-tag">Standalone static site</span>
          </div>
        </div>
        <aside class="header-card">
          <p class="eyebrow header-card-kicker">Viewer Snapshot</p>
          <div class="header-stats">
            <div class="header-stat"><strong>{total}</strong><span>Total floats indexed</span></div>
            <div class="header-stat"><strong>{counts['dm']}</strong><span>DM floats</span></div>
            <div class="header-stat"><strong>{counts['rt']}</strong><span>RT floats</span></div>
            <div class="header-stat"><strong>{counts['flagged_dm']}</strong><span>Flagged DM floats</span></div>
          </div>
        </aside>
      </div>
    </div>
  </header>

  <main class="container">
    <section class="overview-card">
      <div>
        <p class="section-kicker">Coverage</p>
        <p>
          The viewer reads per-float NetCDFs and their figure galleries produced by the bgc-argo-pipeline.
          DM, RT, and flagged DM sources stay separate in the interface, while sharing one searchable world view.
        </p>
        <div class="source-list">
          <div class="source-card">
            <strong>DM source</strong>
            <code>{html.escape(sources['dm_root'])}</code>
          </div>
          <div class="source-card">
            <strong>RT source</strong>
            <code>{html.escape(sources['rt_root'])}</code>
          </div>
          <div class="source-card">
            <strong>Viewer output</strong>
            <code>{html.escape(sources['viewer_dir'])}</code>
          </div>
        </div>
      </div>
      <div>
        <p class="section-kicker">How To Use It</p>
        <p>
          Keep DM checked for the default global overview, switch on RT or flagged DM when needed,
          then search by WMO or click directly on a trajectory endpoint to open its figures.
        </p>
        <div class="source-list">
          <div class="source-card">
            <strong>Generated</strong>
            <code>{generated}</code>
          </div>
          <div class="source-card">
            <strong>Figures</strong>
            <code>Time series + validation scatter plots</code>
          </div>
        </div>
      </div>
    </section>

    <section class="viewer-grid">
      <section class="panel">
        <div class="map-toolbar">
          <div class="toolbar-row">
            <div>
              <p class="card-kicker">Global Map</p>
              <div class="map-summary" id="map-summary">Loading trajectories...</div>
            </div>
            <div class="search-wrap">
              <input id="float-search" type="search" placeholder="Search WMO, combo, or layer">
              <button id="search-button" type="button">Select Float</button>
            </div>
          </div>
          <div class="toolbar-row compact">
            <div class="toggle-row">
              <label class="toggle dm"><input type="checkbox" data-filter="dm" checked><span class="swatch"></span><span>DM</span></label>
              <label class="toggle rt"><input type="checkbox" data-filter="rt"><span class="swatch"></span><span>RT</span></label>
              <label class="toggle flagged_dm"><input type="checkbox" data-filter="flagged_dm"><span class="swatch"></span><span>Flagged DM</span></label>
            </div>
            <div class="map-summary" id="search-count"></div>
          </div>
          <div class="search-results" id="search-results"></div>
        </div>
        <div class="map-shell">
          <svg id="trajectory-map" aria-label="Global float trajectories"></svg>
        </div>
      </section>

      <aside class="detail-panel">
        <div id="detail-empty" class="empty-state">
          <div>
            <p class="card-kicker">Float Detail</p>
            <p>Select a trajectory to open its figures, NetCDF, and screening notes.</p>
          </div>
        </div>
        <div id="detail-content" hidden></div>
      </aside>
    </section>
  </main>

  <footer class="footer">
    Viewer assets: <code>assets/viewer.css</code>, <code>assets/viewer.js</code>, <code>viewer_data.js</code>.
  </footer>

  <script src="viewer_data.js"></script>
  <script src="assets/viewer.js"></script>
</body>
</html>
"""


def _copy_assets(output_dir):
    asset_dir = output_dir / "assets"
    asset_dir.mkdir(parents=True, exist_ok=True)
    for name in ("viewer.css", "viewer.js"):
        shutil.copy2(ASSETS_SRC / name, asset_dir / name)


def main():
    parser = argparse.ArgumentParser(description="Build a static BGC-Argo float HTML viewer.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG),
                        help="YAML config with dm_root / rt_root / output_dir keys")
    parser.add_argument("--dm-root", help="Directory of per-float DM NetCDFs (combo-grouped)")
    parser.add_argument("--rt-root", help="Directory of per-float RT NetCDFs")
    parser.add_argument("--output-dir", help="Where to write the static site")
    parser.add_argument("--link-figures", action="store_true",
                        help="Symlink/copy figures into output/figures so the site is portable")
    parser.add_argument("--no-link-figures", dest="link_figures", action="store_false")
    parser.set_defaults(link_figures=None)
    parser.add_argument("--recompress", action="store_true",
                        help="Resize+re-encode figures to JPEG (web-optimized) instead of linking")
    parser.add_argument("--max-width", type=int, default=1200,
                        help="Max image width for --recompress (default 1200 px)")
    parser.add_argument("--quality", type=int, default=78,
                        help="JPEG quality for --recompress (default 78)")
    parser.add_argument("--drop-netcdf", action="store_true",
                        help="Do not include per-float .nc files in the bundle")
    args = parser.parse_args()

    cfg = _load_config(args.config)
    dm_root = Path(args.dm_root or cfg.get("dm_root") or "").expanduser()
    rt_root = Path(args.rt_root or cfg.get("rt_root") or "").expanduser()
    output_dir = Path(args.output_dir or cfg.get("output_dir") or DEFAULT_OUTPUT).expanduser()
    link_figures = args.link_figures if args.link_figures is not None \
        else bool(cfg.get("link_figures", True))

    if not dm_root.as_posix() and not rt_root.as_posix():
        raise SystemExit("Need dm_root and/or rt_root (via --config or CLI flags)")

    output_dir.mkdir(parents=True, exist_ok=True)
    print(f"[viewer] dm_root     = {dm_root}")
    print(f"[viewer] rt_root     = {rt_root}")
    print(f"[viewer] output_dir  = {output_dir}")
    print(f"[viewer] link_figures= {link_figures}")

    payload = _build_payload(
        dm_root if dm_root.as_posix() else None,
        rt_root if rt_root.as_posix() else None,
        output_dir, link_figures,
        recompress=args.recompress,
        max_width=args.max_width,
        quality=args.quality,
        drop_netcdf=args.drop_netcdf,
    )
    _copy_assets(output_dir)

    (output_dir / "viewer_data.js").write_text(
        "window.FLOAT_VIEWER_DATA = " + json.dumps(payload, separators=(",", ":")) + ";\n"
    )
    (output_dir / "index.html").write_text(_html_index(payload))

    print(f"[viewer] floats      = {len(payload['floats'])}")
    for key, val in payload["counts"].items():
        print(f"[viewer]   {key:10s}= {val}")
    print(f"[viewer] open        : {output_dir / 'index.html'}")


if __name__ == "__main__":
    main()
