"""Regenerate the welcome logo's text frames from its PNG (requires Pillow).

Run from any directory: python scripts/generate-tether-ascii.py
Only generation needs Pillow; the app plays the baked frames with CSS.
"""

import json
import math
from pathlib import Path

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
COLUMNS, ROWS, FRAMES = 44, 26, 48
SAMPLE = 4
RAMP = " .:-=+*#%@"


def generate():
    source = Image.open(ROOT / "src/renderer/assets/logo.png").convert("RGBA")
    source = source.crop(source.getbbox())
    # A monospace cell is ~0.6 times as wide as its line height.
    height = (ROWS - 4) * SAMPLE
    width = round(height * source.width / source.height / 0.6)
    source = source.resize((width, height), Image.Resampling.LANCZOS)
    alpha = source.getchannel("A")
    face = ImageOps.grayscale(source)
    frames = []

    for index in range(FRAMES):
        angle = index * math.tau / FRAMES
        cosine, sine = math.cos(angle), math.sin(angle)
        projected_width = max(1, round(width * abs(cosine)))
        projected_alpha = alpha.resize((projected_width, height), Image.Resampling.LANCZOS)
        projected_face = face.resize((projected_width, height), Image.Resampling.LANCZOS)
        if cosine < 0:
            projected_alpha = ImageOps.mirror(projected_alpha)
            projected_face = ImageOps.mirror(projected_face)

        canvas = Image.new("L", (COLUMNS * SAMPLE, ROWS * SAMPLE))
        left = (canvas.width - projected_width) / 2
        top = (canvas.height - height) // 2
        # Stack slices of the silhouette to give the rotating mark a thin edge.
        for slice_index in range(13):
            depth = (slice_index - 6) * SAMPLE / 3
            offset = round(left + depth * sine)
            canvas.paste(100, (offset, top), projected_alpha)

        lighting = 0.65 + 0.35 * max(0, abs(cosine) - 0.3 * sine)
        projected_face = projected_face.point(lambda value: round(value * lighting))
        face_depth = 2 * SAMPLE * (1 if cosine >= 0 else -1)
        canvas.paste(projected_face, (round(left + face_depth * sine), top), projected_alpha)
        cells = canvas.resize((COLUMNS, ROWS), Image.Resampling.BOX)
        lines = [
            "".join(RAMP[min(len(RAMP) - 1, round(cells.getpixel((x, y)) / 255 * (len(RAMP) - 1)))]
                    for x in range(COLUMNS))
            for y in range(ROWS)
        ]
        frames.append("\n".join(lines))

    destination = ROOT / "src/renderer/assets/tether-ascii.json"
    destination.write_text(json.dumps({"columns": COLUMNS, "rows": ROWS, "frames": frames}, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {FRAMES} ASCII frames in {destination}")


if __name__ == "__main__":
    generate()
