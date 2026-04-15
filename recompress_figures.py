"""Parallel pre-pass that resizes+re-encodes float figures to JPEG.

After this finishes, run `build_viewer.py --recompress --output-dir docs ...`
which will detect the already-fresh JPEGs (mtime check) and skip them, only
emitting the JSON payload + assets.
"""

from __future__ import annotations

import argparse
import os
from multiprocessing import Pool, cpu_count
from pathlib import Path

from PIL import Image


def _recompress_one(args):
    src, dst, max_width, quality = args
    try:
        if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            return "skip"
        dst.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(src) as im:
            im = im.convert("RGB")
            if im.width > max_width:
                ratio = max_width / im.width
                im = im.resize((max_width, int(im.height * ratio)), Image.LANCZOS)
            im.save(dst, "JPEG", quality=quality, optimize=True, progressive=True)
        return "done"
    except Exception as exc:
        return f"err:{src}:{exc}"


def _iter_pairs(dm_root, rt_root, output_dir):
    figures_root = output_dir / "figures"

    def _walk_combos(root, category, skip_dirs=()):
        if not root.exists():
            return
        for combo_dir in sorted(root.iterdir()):
            if not combo_dir.is_dir() or combo_dir.name in skip_dirs:
                continue
            for nc_path in sorted(combo_dir.glob("*.nc")):
                wmo = nc_path.stem
                fig_dir = combo_dir / "figures" / wmo
                if not fig_dir.exists():
                    continue
                for fig_path in sorted(fig_dir.glob("*.png")):
                    dst = figures_root / category / wmo / (fig_path.stem + ".jpg")
                    yield (fig_path, dst)

    yield from _walk_combos(dm_root, "dm", skip_dirs={"FLAGGED"})
    flagged = dm_root / "FLAGGED" if dm_root else None
    if flagged and flagged.exists():
        for combo_dir in sorted(flagged.iterdir()):
            if not combo_dir.is_dir() or combo_dir.name in {"figures", "screening"}:
                continue
            for nc_path in sorted(combo_dir.glob("*.nc")):
                wmo = nc_path.stem
                fig_dir = flagged / "figures" / wmo
                if not fig_dir.exists():
                    continue
                for fig_path in sorted(fig_dir.glob("*.png")):
                    dst = figures_root / "flagged_dm" / wmo / (fig_path.stem + ".jpg")
                    yield (fig_path, dst)
    yield from _walk_combos(rt_root, "rt")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dm-root", required=True)
    p.add_argument("--rt-root", required=True)
    p.add_argument("--output-dir", required=True)
    p.add_argument("--max-width", type=int, default=1200)
    p.add_argument("--quality", type=int, default=78)
    p.add_argument("--workers", type=int, default=max(1, cpu_count() - 1))
    args = p.parse_args()

    dm_root = Path(args.dm_root)
    rt_root = Path(args.rt_root)
    output_dir = Path(args.output_dir)

    pairs = [(src, dst, args.max_width, args.quality)
             for src, dst in _iter_pairs(dm_root, rt_root, output_dir)]
    print(f"[recompress] pairs={len(pairs)} workers={args.workers}")

    done = skipped = errors = 0
    with Pool(args.workers) as pool:
        for i, status in enumerate(
                pool.imap_unordered(_recompress_one, pairs, chunksize=64), start=1):
            if status == "done":
                done += 1
            elif status == "skip":
                skipped += 1
            else:
                errors += 1
                if errors <= 10:
                    print(f"  ! {status}")
            if i % 500 == 0:
                print(f"  processed {i}/{len(pairs)}  done={done} skip={skipped} err={errors}")

    print(f"[recompress] DONE done={done} skip={skipped} err={errors} total={len(pairs)}")


if __name__ == "__main__":
    main()
