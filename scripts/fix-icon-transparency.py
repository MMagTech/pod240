"""
Prepare Pod240 master icon for macOS/Windows docks:
1) Edge flood-fill removes opaque light-gray matte (should be transparent).
2) Scales the *solid* artwork to ~86% of the 1024 canvas. The bbox ignores faint
   low-alpha haze (e.g. alpha 119 across a huge area): PIL's default getbbox()
   would include that and scale the wrong region, leaving the real icon tiny.

Run from repo root: python scripts/fix-icon-transparency.py
Then: cd src-tauri && npx tauri icon pod240-icon-1024.png
"""

from __future__ import annotations

from collections import deque
from pathlib import Path

from PIL import Image


def is_background(r: int, g: int, b: int, a: int) -> bool:
    if a < 8:
        return True
    # Opaque off-white / gray matte (AI export, JPEG-like fringe) — not the purple squircle.
    if a > 200 and r > 200 and g > 195 and b > 190:
        spread = max(r, g, b) - min(r, g, b)
        if spread < 55:
            return True
    return False


def flood_clear_edges(im: Image.Image) -> Image.Image:
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()
    seen = [[False] * w for _ in range(h)]
    clear = [[False] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque()

    def push(x: int, y: int) -> None:
        if x < 0 or y < 0 or x >= w or y >= h or seen[y][x]:
            return
        seen[y][x] = True
        r, g, b, a = px[x, y]
        if is_background(r, g, b, a):
            clear[y][x] = True
            q.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)

    while q:
        x, y = q.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if nx < 0 or ny < 0 or nx >= w or ny >= h or seen[ny][nx]:
                continue
            seen[ny][nx] = True
            r, g, b, a = px[nx, ny]
            if is_background(r, g, b, a):
                clear[ny][nx] = True
                q.append((nx, ny))

    out = im.copy()
    opx = out.load()
    for y in range(h):
        for x in range(w):
            if clear[y][x]:
                opx[x, y] = (0, 0, 0, 0)
    return out


def scale_artwork_to_fill_canvas(
    im: Image.Image,
    canvas: int = 1024,
    fill: float = 0.86,
    min_alpha_for_bbox: int = 120,
) -> Image.Image:
    """Crop to bbox of sufficiently opaque pixels, then scale to fill the canvas."""
    im = im.convert("RGBA")
    alpha = im.split()[3]
    # Mask of "real" paint; faint full-frame glow (often alpha just under 120) must
    # not set the bbox or the solid squircle stays small in the dock.
    mask = alpha.point(lambda p: 255 if p >= min_alpha_for_bbox else 0)
    bbox = mask.getbbox()
    if bbox is None:
        bbox = alpha.getbbox()
    if bbox is None:
        return im
    cropped = im.crop(bbox)
    cw, ch = cropped.size
    target_max = int(round(canvas * fill))
    # Already fills the slot (re-runs after a good export).
    if max(cw, ch) >= int(target_max * 0.97):
        return im
    scale = min(target_max / cw, target_max / ch)
    nw = max(1, int(round(cw * scale)))
    nh = max(1, int(round(ch * scale)))
    scaled = cropped.resize((nw, nh), Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    ox = (canvas - nw) // 2
    oy = (canvas - nh) // 2
    out.paste(scaled, (ox, oy), scaled)
    return out


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    src = root / "src-tauri" / "pod240-icon-1024.png"
    if not src.is_file():
        raise SystemExit(f"Missing {src}")
    im = Image.open(src)
    fill = 0.86
    out = flood_clear_edges(im)
    out = scale_artwork_to_fill_canvas(out, canvas=1024, fill=fill)
    out.save(src, optimize=True)
    print(f"Wrote {src} (matte cleared, opaque artwork scaled to ~{int(fill * 100)}% of canvas)")


if __name__ == "__main__":
    main()
