# bgc-argo-float-viewer

Static HTML viewer for per-float BGC-Argo NetCDFs (DM, RT, flagged-DM)
produced by the [`bgc-argo-pipeline`](../bgc-argo-pipeline) per-float stage.

Design follows the **oceanbgcbench** report aesthetic: navy gradient header,
card grid, compact tables, monochrome accents. No iframe, no tab — this
is its own standalone site.

## Layout

```
bgc-argo-float-viewer/
├── build_viewer.py        # site generator (no pipeline dependency)
├── config.yaml            # default DM/RT/output paths
├── viewer/assets/         # viewer.css + viewer.js (template)
└── output/                # generated site (gitignored)
    ├── index.html
    ├── viewer_data.js
    ├── assets/{viewer.css, viewer.js}
    ├── figures/<category>/<wmo>/*.png   # symlinked from FLOATS_DM/RT
    └── netcdf/<category>/<wmo>/*.nc
```

## Build

```bash
# Uses paths from config.yaml
python build_viewer.py

# Override paths
python build_viewer.py \
    --dm-root /path/to/FLOATS_DM \
    --rt-root /path/to/FLOATS_RT \
    --output-dir ./output \
    --link-figures
```

When `--link-figures` is set (the default) figure PNGs and per-float NetCDFs
are symlinked into `output/`, so the bundle is self-contained and can be
served as a static site or rsync'd to a webserver. Pass `--no-link-figures`
to keep absolute paths instead (only viewable from the originating host).

Open `output/index.html` in a browser to use the viewer.

## Requirements

- Python 3.9+
- `netCDF4`, `numpy`
- `pyyaml` (only if you use `--config`)

## Inputs

The viewer expects per-float NetCDFs laid out as:

```
FLOATS_DM/
  BBP700_CHLA_DOXY_NO3/
    5904479.nc
    figures/5904479/{wmo}_physical.png
                    {wmo}_bio_optics.png
                    ...
  FLAGGED/
    BBP700_CHLA/<wmo>.nc
    figures/<wmo>/*.png
    screening/<wmo>.txt
FLOATS_RT/
  BBP700_CHLA/<wmo>.nc
```

Each NetCDF must carry `LONGITUDE`, `LATITUDE`, `JULD`, `CYCLE_NUMBER`,
the standard BGC variables, and per-variable `*_DATA_MODE` arrays.
