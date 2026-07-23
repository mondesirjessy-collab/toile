#!/usr/bin/env python3
"""
Extract the seven graded Lucas Hoodie sizes from the supplied two-page A0 PDF.

The source was authored in Illustrator.  Cairo exposes each graded cut line as
one closed SVG path, including the original notches.  This generator applies
the SVG matrices and converts PDF points at their exact physical scale
(1 point = 1/72 inch); it does not trace a raster image or infer a scale.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path


PT_TO_M = 0.0254 / 72
PAD_M = 0.005
SVG_NS = "{http://www.w3.org/2000/svg}"

SIZE_COLORS = {
    "XS": "rgb(100%, 59.999084%, 79.998779%)",
    "S": "rgb(39.99939%, 59.999084%, 100%)",
    "M": "rgb(100%, 39.99939%, 0%)",
    "L": "rgb(19.999695%, 79.998779%, 19.999695%)",
    "XL": "rgb(59.999084%, 0%, 79.998779%)",
    "XXL": "rgb(100%, 0%, 100%)",
    "XXXL": "rgb(0%, 0%, 100%)",
}

SIZE_CHART = {
    "XS": (92, 78, 94, 70.1, 88.9, 119.9),
    "S": (96, 82, 98, 71.1, 89.9, 125.0),
    "M": (100, 86, 102, 71.9, 90.7, 130.0),
    "L": (106, 92, 108, 72.9, 91.7, 134.9),
    "XL": (111, 97, 113, 73.9, 92.7, 140.0),
    "XXL": (116, 107, 118, 74.9, 93.5, 145.0),
    "XXXL": (121, 112, 123, 75.9, 94.5, 150.1),
}

# Exact construction landmarks on each extracted cut-line.  They are kept in
# the generated data instead of rediscovered from extrema at runtime: graded
# sizes do not all contain the same number of sampled curve points, and the
# closing SVG edge belongs to the armscye/underarm on the back and sleeve.
LANDMARKS = {
    "XS": (42, 75, 65, 31, 13, 58),
    "S": (42, 78, 66, 31, 13, 58),
    "M": (44, 73, 67, 32, 13, 58),
    "L": (46, 72, 67, 32, 12, 57),
    "XL": (45, 73, 71, 33, 13, 59),
    "XXL": (46, 72, 71, 32, 13, 60),
    "XXXL": (49, 70, 71, 32, 13, 61),
}

Point = tuple[float, float]


@dataclass
class VectorPath:
    points: list[Point]

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        xs = [point[0] for point in self.points]
        ys = [point[1] for point in self.points]
        return min(xs), min(ys), max(xs), max(ys)

    @property
    def width(self) -> float:
        left, _, right, _ = self.bbox
        return right - left

    @property
    def height(self) -> float:
        _, top, _, bottom = self.bbox
        return bottom - top


def parse_matrix(value: str | None) -> tuple[float, float, float, float, float, float]:
    if not value:
        return 1, 0, 0, 1, 0, 0
    match = re.fullmatch(r"matrix\(([^)]+)\)", value)
    if not match:
        raise ValueError(f"Unsupported SVG transform: {value}")
    values = tuple(float(part.strip()) for part in match.group(1).split(","))
    if len(values) != 6:
        raise ValueError(f"Invalid SVG matrix: {value}")
    return values  # type: ignore[return-value]


def parse_path(
    data: str,
    matrix: tuple[float, float, float, float, float, float],
) -> list[Point]:
    tokens = re.findall(r"[MLZ]|-?\d*\.?\d+(?:[eE][+-]?\d+)?", data)
    a, b, c, d, e, f = matrix
    result: list[Point] = []
    command = ""
    index = 0

    def transform(x: float, y: float) -> Point:
        return a * x + c * y + e, b * x + d * y + f

    while index < len(tokens):
        token = tokens[index]
        if token in ("M", "L", "Z"):
            command = token
            index += 1
            if token == "Z":
                continue
        if command not in ("M", "L"):
            raise ValueError(f"Unsupported cut-line command {command!r}")
        x = float(tokens[index])
        y = float(tokens[index + 1])
        index += 2
        result.append(transform(x, y))
        command = "L"

    if len(result) > 1 and math.dist(result[0], result[-1]) <= 1e-5:
        result.pop()
    return result


def read_colored_paths(path: Path) -> dict[str, list[VectorPath]]:
    wanted = set(SIZE_COLORS.values())
    result = {color: [] for color in wanted}
    root = ET.parse(path).getroot()
    for element in root.iter(f"{SVG_NS}path"):
        color = element.attrib.get("stroke")
        if color not in wanted:
            continue
        points = parse_path(
            element.attrib["d"],
            parse_matrix(element.attrib.get("transform")),
        )
        if len(points) >= 3:
            result[color].append(VectorPath(points))
    return result


def classify_page1(paths: list[VectorPath]) -> dict[str, VectorPath]:
    if len(paths) != 4:
        raise ValueError(f"Expected four graded page-1 paths, found {len(paths)}")
    body = [path for path in paths if path.height > 1000]
    bands = [path for path in paths if path.height <= 1000]
    if len(body) != 2 or len(bands) != 2:
        raise ValueError("Could not separate page-1 body pieces and bands")
    body.sort(key=lambda path: path.bbox[0])
    bands.sort(key=lambda path: path.width, reverse=True)
    return {
        "back": body[0],
        "front": body[1],
        "waistband": bands[0],
        "cuff": bands[1],
    }


def classify_page2(paths: list[VectorPath]) -> dict[str, VectorPath]:
    # Page 2 repeats the waistband because that on-fold rectangle crosses the
    # registration boundary.  The other three paths are unique to this sheet.
    candidates = [path for path in paths if path.height > 700]
    if len(candidates) != 3:
        raise ValueError(
            f"Expected sleeve, hood and pocket on page 2, found {len(candidates)}"
        )
    sleeve = min(candidates, key=lambda path: path.bbox[1])
    lower = [path for path in candidates if path is not sleeve]
    lower.sort(key=lambda path: path.bbox[0])
    return {"sleeve": sleeve, "hood": lower[0], "pocket": lower[1]}


def signed_area(points: list[Point]) -> float:
    return 0.5 * sum(
        points[index][0] * points[(index + 1) % len(points)][1]
        - points[(index + 1) % len(points)][0] * points[index][1]
        for index in range(len(points))
    )


def normalise(path: VectorPath) -> dict[str, object]:
    points = path.points
    if signed_area(points) < 0:
        points = list(reversed(points))
    left, top, right, bottom = path.bbox
    cut_width = (right - left) * PT_TO_M
    cut_height = (bottom - top) * PT_TO_M
    width = cut_width + 2 * PAD_M
    height = cut_height + 2 * PAD_M
    outline = [
        [
            round((PAD_M + (x - left) * PT_TO_M) / width, 6),
            round((PAD_M + (y - top) * PT_TO_M) / height, 6),
        ]
        for x, y in points
    ]
    if len(outline) > 128:
        raise ValueError(f"Draft outline limit exceeded ({len(outline)} vertices)")
    return {
        "outline": outline,
        "width": round(width, 6),
        "height": round(height, 6),
        "cutWidthCm": round(cut_width * 100, 2),
        "cutHeightCm": round(cut_height * 100, 2),
    }


def convert_pdf(source: Path, folder: Path) -> tuple[Path, Path]:
    page1 = folder / "lucas-a0-1.svg"
    page2 = folder / "lucas-a0-2.svg"
    # Some Poppler builds overwrite a multi-page SVG target instead of adding
    # suffixes, so convert each page explicitly.
    for page, target in ((1, page1), (2, page2)):
        subprocess.run(
            [
                "pdftocairo",
                "-svg",
                "-f",
                str(page),
                "-l",
                str(page),
                str(source),
                str(target),
            ],
            check=True,
        )
    return page1, page2


def generate(page1: Path, page2: Path) -> dict[str, object]:
    first = read_colored_paths(page1)
    second = read_colored_paths(page2)
    result: dict[str, object] = {}
    for size, color in SIZE_COLORS.items():
        pieces = classify_page1(first[color]) | classify_page2(second[color])
        chest, waist, hip, length, sleeve, finished_chest = SIZE_CHART[size]
        result[size] = {
            "bodyChestCm": chest,
            "bodyWaistCm": waist,
            "bodyHipCm": hip,
            "finishedLengthCm": length,
            "finishedSleeveCm": sleeve,
            "finishedChestCm": finished_chest,
            "pieces": {
                name: normalise(pieces[name])
                for name in (
                    "front",
                    "back",
                    "sleeve",
                    "hood",
                    "pocket",
                    "cuff",
                    "waistband",
                )
            },
        }
    return result


def render_typescript(data: dict[str, object]) -> str:
    payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    sizes = json.dumps(list(SIZE_COLORS), separators=(",", ":"))
    landmarks = json.dumps(
        {
            size: {
                "frontArmholeEnd": values[0],
                "backArmholeStart": values[1],
                "sleeveCapEnd": values[2],
                "sleeveCapTop": values[3],
                "hoodCrownFront": values[4],
                "hoodCenterBackNeck": values[5],
            }
            for size, values in LANDMARKS.items()
        },
        separators=(",", ":"),
    )
    return f"""/* eslint-disable */
// GENERATED by tools/gen_lucas_hoodie.py from LucasHoodieA0.pdf.
// Exact vector extraction at PDF scale (1 pt = 1/72 in). The original 1 cm
// seam allowance and every cut-line notch are retained.
import type {{ UV }} from './Draft';

export const LUCAS_HOODIE_SIZES = {sizes} as const;
export type LucasHoodieSize = (typeof LUCAS_HOODIE_SIZES)[number];

export interface LucasHoodiePieceData {{
  outline: UV[];
  width: number;
  height: number;
  cutWidthCm: number;
  cutHeightCm: number;
}}

export interface LucasHoodieSizeData {{
  bodyChestCm: number;
  bodyWaistCm: number;
  bodyHipCm: number;
  finishedLengthCm: number;
  finishedSleeveCm: number;
  finishedChestCm: number;
  pieces: {{
    front: LucasHoodiePieceData;
    back: LucasHoodiePieceData;
    sleeve: LucasHoodiePieceData;
    hood: LucasHoodiePieceData;
    pocket: LucasHoodiePieceData;
    cuff: LucasHoodiePieceData;
    waistband: LucasHoodiePieceData;
  }};
}}

export interface LucasHoodieLandmarks {{
  frontArmholeEnd: number;
  backArmholeStart: number;
  sleeveCapEnd: number;
  sleeveCapTop: number;
  hoodCrownFront: number;
  hoodCenterBackNeck: number;
}}

export const LUCAS_HOODIE_DATA: Record<LucasHoodieSize, LucasHoodieSizeData> = {payload};
export const LUCAS_HOODIE_LANDMARKS: Record<LucasHoodieSize, LucasHoodieLandmarks> = {landmarks};
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="lucas-hoodie-") as temporary:
        page1, page2 = convert_pdf(args.source, Path(temporary))
        data = generate(page1, page2)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render_typescript(data), encoding="utf-8")


if __name__ == "__main__":
    main()
