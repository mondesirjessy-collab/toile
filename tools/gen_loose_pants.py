#!/usr/bin/env python3
"""
Extract the graded men's loose-pants pattern from the supplied layered A0 PDF.

The PDF contains one optional-content layer per waist size.  This script turns
on one size at a time, converts the two tiled pages to SVG, joins the original
vector cut-line fragments, and emits editable DraftPiece geometry in metres.
No visual tracing or scale estimation is involved: 1 PDF point = 1/72 inch.
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

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, NameObject


SIZES = ["26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "38", "40", "42", "44", "46"]
PT_TO_M = 0.0254 / 72
PAGE_WIDTH_PT = 2298.96
PAD_M = 0.005

SIZE_CHART = {
    "26": ("XXS", 42, "66–71", "81–86"),
    "27": ("XXS", 42, "66–71", "81–86"),
    "28": ("XS", 44, "71–76", "86–91"),
    "29": ("XS", 44, "71–76", "86–91"),
    "30": ("S", 46, "76–81", "91–96"),
    "31": ("S", 46, "76–81", "91–96"),
    "32": ("M", 48, "81–86", "97–102"),
    "33": ("M", 48, "81–86", "97–102"),
    "34": ("L", 50, "86–91", "102–107"),
    "35": ("L", 50, "86–91", "102–107"),
    "36": ("XL", 52, "91–96", "107–112"),
    "38": ("XXL", 54, "97–102", "112–117"),
    "40": ("3XL", 56, "102–107", "117–122"),
    "42": ("4XL", 58, "107–112", "122–127"),
    "44": ("5XL", 60, "112–117", "127–132"),
    "46": ("5XL", 60, "112–117", "127–132"),
}


Point = tuple[float, float]


@dataclass
class VectorPath:
    index: int
    points: list[Point]

    @property
    def length(self) -> float:
        return sum(math.dist(self.points[i - 1], self.points[i]) for i in range(1, len(self.points)))

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        xs = [p[0] for p in self.points]
        ys = [p[1] for p in self.points]
        return min(xs), min(ys), max(xs), max(ys)

    @property
    def width(self) -> float:
        a, _, c, _ = self.bbox
        return c - a

    @property
    def height(self) -> float:
        _, b, _, d = self.bbox
        return d - b


def filter_layer(source: Path, layer: str, output: Path) -> None:
    reader = PdfReader(source)
    if reader.is_encrypted:
        reader.decrypt("")
    ocprops = reader.trailer["/Root"]["/OCProperties"]
    groups = list(ocprops["/OCGs"])
    selected = [group for group in groups if group.get_object().get("/Name") == layer]
    if len(selected) != 1:
        raise ValueError(f"Missing or duplicate size layer {layer}")
    defaults = ocprops["/D"]
    defaults[NameObject("/ON")] = ArrayObject(selected)
    defaults[NameObject("/OFF")] = ArrayObject([group for group in groups if group not in selected])
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    with output.open("wb") as target:
        writer.write(target)


def parse_matrix(value: str | None) -> tuple[float, float, float, float, float, float]:
    if not value:
        return (1, 0, 0, 1, 0, 0)
    match = re.fullmatch(r"matrix\(([^)]+)\)", value)
    if not match:
        raise ValueError(f"Unsupported SVG transform: {value}")
    values = tuple(float(v.strip()) for v in match.group(1).split(","))
    if len(values) != 6:
        raise ValueError(f"Invalid SVG matrix: {value}")
    return values  # type: ignore[return-value]


def parse_subpaths(d: str, matrix: tuple[float, float, float, float, float, float]) -> list[list[Point]]:
    tokens = re.findall(r"[MLZ]|-?\d*\.?\d+(?:[eE][+-]?\d+)?", d)
    a, b, c, dd, e, f = matrix
    result: list[list[Point]] = []
    current: list[Point] = []
    command = ""
    i = 0

    def tx(x: float, y: float) -> Point:
        return a * x + c * y + e, b * x + dd * y + f

    while i < len(tokens):
        token = tokens[i]
        if token in ("M", "L", "Z"):
            command = token
            i += 1
            if token == "Z":
                if current and math.dist(current[0], current[-1]) > 1e-6:
                    current.append(current[0])
                continue
        if command in ("M", "L"):
            x, y = float(tokens[i]), float(tokens[i + 1])
            i += 2
            if command == "M":
                if current:
                    result.append(current)
                current = [tx(x, y)]
                command = "L"
            else:
                current.append(tx(x, y))
    if current:
        result.append(current)
    return result


def read_svg(path: Path) -> list[VectorPath]:
    tree = ET.parse(path)
    result: list[VectorPath] = []
    for element in tree.getroot().iter("{http://www.w3.org/2000/svg}path"):
        for points in parse_subpaths(element.attrib["d"], parse_matrix(element.attrib.get("transform"))):
            if len(points) >= 2:
                result.append(VectorPath(len(result), points))
    return result


def join_paths(paths: list[VectorPath], *, max_gap: float = 55) -> list[Point]:
    """Join cut-line fragments by their nearest ends, retaining every source point."""
    if not paths:
        raise ValueError("No vector paths to join")
    # Illustrator leaves an 18 pt grading tail after some exact junctions.
    # When an endpoint-adjacent point already coincides with another fragment,
    # trim the dangling tail instead of bridging back across it (which would
    # create a tiny self-intersection at the size transition).
    raw = [p.points[:] for p in paths]
    unused: list[list[Point]] = []
    for i, points in enumerate(raw):
        start = 0
        end = len(points) - 1
        others = [
            q
            for j, other in enumerate(raw)
            if j != i
            for q in (other[:4] + other[-4:])
        ]
        for k in range(min(4, len(points))):
            if any(math.dist(points[k], q) <= 0.5 for q in others):
                start = k
                break
        for k in range(len(points) - 1, max(-1, len(points) - 5), -1):
            if any(math.dist(points[k], q) <= 0.5 for q in others):
                end = k
                break
        unused.append(points[start : end + 1])
    chain = unused.pop(0)
    while unused:
        options: list[tuple[float, int, str]] = []
        for i, candidate in enumerate(unused):
            options.extend(
                [
                    (math.dist(chain[-1], candidate[0]), i, "append"),
                    (math.dist(chain[-1], candidate[-1]), i, "append-reverse"),
                    (math.dist(chain[0], candidate[-1]), i, "prepend"),
                    (math.dist(chain[0], candidate[0]), i, "prepend-reverse"),
                ]
            )
        gap, index, mode = min(options)
        if gap > max_gap:
            raise ValueError(f"Cut-line gap {gap:.1f} pt exceeds {max_gap:.1f} pt")
        candidate = unused.pop(index)
        if mode == "append":
            chain.extend(candidate)
        elif mode == "append-reverse":
            chain.extend(reversed(candidate))
        elif mode == "prepend":
            chain = candidate + chain
        else:
            chain = list(reversed(candidate)) + chain
    if math.dist(chain[-1], chain[0]) > max_gap:
        raise ValueError(f"Closing gap {math.dist(chain[-1], chain[0]):.1f} pt exceeds {max_gap:.1f} pt")
    if math.dist(chain[-1], chain[0]) > 1e-6:
        chain.append(chain[0])
    return dedup(chain)


def dedup(points: list[Point], epsilon: float = 0.08) -> list[Point]:
    result: list[Point] = []
    for point in points:
        if not result or math.dist(result[-1], point) > epsilon:
            result.append(point)
    if len(result) > 1 and math.dist(result[0], result[-1]) <= epsilon:
        result.pop()
    return result


def find(paths: list[VectorPath], predicate, description: str, count: int) -> list[VectorPath]:
    matches = [path for path in paths if predicate(path)]
    if len(matches) != count:
        found = ", ".join(f"#{p.index} L={p.length:.0f} {p.bbox}" for p in matches)
        raise ValueError(f"{description}: expected {count}, found {len(matches)} ({found})")
    return matches


def path_ids(paths: list[VectorPath], *ids: int) -> list[VectorPath]:
    by_id = {path.index: path for path in paths}
    missing = [index for index in ids if index not in by_id]
    if missing:
        raise ValueError(f"Missing SVG path ids: {missing}")
    return [by_id[index] for index in ids]


def signed_area(points: list[Point]) -> float:
    return 0.5 * sum(
        points[i][0] * points[(i + 1) % len(points)][1]
        - points[(i + 1) % len(points)][0] * points[i][1]
        for i in range(len(points))
    )


def segments_cross(a: Point, b: Point, c: Point, d: Point) -> bool:
    def orient(p: Point, q: Point, r: Point) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    o1, o2, o3, o4 = orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)
    return (o1 > 1e-6) != (o2 > 1e-6) and (o3 > 1e-6) != (o4 > 1e-6)


def self_intersects(points: list[Point]) -> bool:
    for i in range(len(points)):
        a, b = points[i], points[(i + 1) % len(points)]
        for j in range(i + 1, len(points)):
            if j == i or (j + 1) % len(points) == i or (i + 1) % len(points) == j:
                continue
            c, d = points[j], points[(j + 1) % len(points)]
            if segments_cross(a, b, c, d):
                return True
    return False


def normalise(points: list[Point], *, rotate_back: bool = False) -> dict:
    if rotate_back:
        max_x = max(p[0] for p in points)
        points = [(p[1], max_x - p[0]) for p in points]
    if signed_area(points) < 0:
        points = list(reversed(points))
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    min_x, min_y, max_x, max_y = min(xs), min(ys), max(xs), max(ys)
    cut_w = (max_x - min_x) * PT_TO_M
    cut_h = (max_y - min_y) * PT_TO_M
    width = cut_w + 2 * PAD_M
    height = cut_h + 2 * PAD_M
    outline = [
        [
            round((PAD_M + (x - min_x) * PT_TO_M) / width, 6),
            round((PAD_M + (y - min_y) * PT_TO_M) / height, 6),
        ]
        for x, y in points
    ]
    uv_points = [(p[0], p[1]) for p in outline]
    if len(outline) > 128:
        raise ValueError(f"Outline contains {len(outline)} vertices (Draft limit is 128)")
    if self_intersects(uv_points):
        raise ValueError("Joined outline self-intersects")
    return {
        "outline": outline,
        "width": round(width, 6),
        "height": round(height, 6),
        "cutWidthCm": round(cut_w * 100, 2),
        "cutHeightCm": round(cut_h * 100, 2),
    }


def extract_size(page1: list[VectorPath], page2: list[VectorPath]) -> dict[str, dict]:
    # At the largest sizes Cairo emits four leading page-clip rectangles before
    # the real page-2 paths.  Anchor the indices on the unmistakable 80+ point
    # pocket-bag curve so the extraction stays stable.
    pocket_anchor = find(
        page2,
        lambda p: len(p.points) > 80
        and p.length > 2300
        and p.bbox[0] < 100
        and p.bbox[1] < 150
        and 900 < p.width < 1100
        and 1000 < p.height < 1300,
        "page-2 pocket-bag anchor",
        1,
    )[0]
    p2 = pocket_anchor.index - 55

    # Main FRONT: centre-front/crotch, waist, outseam, hem and inseam.
    front = join_paths(path_ids(page2, *(index + p2 for index in (85, 87, 88, 89, 90, 91, 94))))

    # Main BACK crosses the two tiled A0 pages.  Page-2 path #78 is continued
    # in global sheet coordinates before it is joined to the page-1 fragments.
    back_cont_source = page2[78 + p2]
    back_cont = VectorPath(78, [(x + PAGE_WIDTH_PT, y) for x, y in back_cont_source.points])
    back = join_paths(path_ids(page1, 150, 152, 153, 154, 155) + [back_cont])

    # Waistband outer cut line; path #29 is the internal fold line.
    waistband = join_paths(path_ids(page1, 27, 28, 30, 31, 32))

    # Back pocket CUT 2.  The separate rounded rectangle at x≈53 is the
    # top-stitch template and is intentionally not emitted as a cut piece.
    back_pocket = join_paths(path_ids(page1, 102, 104, 105))

    facing_paths = find(
        page1,
        lambda p: 1450 < p.bbox[0] < 2050
        and 1150 < p.bbox[1] < 1750
        and (
            (p.length > 900 and p.width > 450 and p.height > 450)
            or (80 < p.length < 110 and p.width < 25 and 70 < p.height < 100)
            or (650 < p.length < 850 and 350 < p.width < 450 and 350 < p.height < 450)
        ),
        "front pocket facing",
        3,
    )
    facing = join_paths(facing_paths)

    pocket_bag = join_paths(path_ids(page2, *(index + p2 for index in (53, 54, 55))))
    fly = join_paths(path_ids(page2, *(index + p2 for index in (0, 1, 2))))

    shield_paths = find(
        page1,
        lambda p: 1700 < p.bbox[0] < 2150
        and 0 < p.bbox[1] < 800
        and (
            (350 < p.length < 500 and 290 < p.width < 350 and 70 < p.height < 120)
            or (650 < p.length < 850 and p.width < 55 and p.height > 600)
            or (750 < p.length < 1000 and 250 < p.width < 330 and p.height > 500)
        ),
        "fly shield",
        3,
    )
    fly_shield = join_paths(shield_paths)

    return {
        "front": normalise(front),
        "back": normalise(back, rotate_back=True),
        "backPocket": normalise(back_pocket),
        "pocketFacing": normalise(facing),
        "pocketBag": normalise(pocket_bag),
        "fly": normalise(fly),
        "flyShield": normalise(fly_shield),
        "waistband": normalise(waistband),
    }


def typescript(data: dict[str, dict]) -> str:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"""/* eslint-disable */
// GENERATED by tools/gen_loose_pants.py from MENSLOSSE-A0.pdf.
// Exact vector extraction at PDF scale (1 pt = 1/72 in); 1.25 cm seam
// allowances are already included in the source pattern.
import type {{ UV }} from './Draft';

export const LOOSE_PANTS_SIZES = {json.dumps(SIZES)} as const;
export type LoosePantsSize = (typeof LOOSE_PANTS_SIZES)[number];

export interface LoosePantsPieceData {{
  outline: UV[];
  width: number;
  height: number;
  cutWidthCm: number;
  cutHeightCm: number;
}}

export interface LoosePantsSizeData {{
  alpha: string;
  eu: number;
  waistRangeCm: string;
  hipRangeCm: string;
  nominalWaistCm: number;
  pieces: {{
    front: LoosePantsPieceData;
    back: LoosePantsPieceData;
    backPocket: LoosePantsPieceData;
    pocketFacing: LoosePantsPieceData;
    pocketBag: LoosePantsPieceData;
    fly: LoosePantsPieceData;
    flyShield: LoosePantsPieceData;
    waistband: LoosePantsPieceData;
  }};
}}

export const LOOSE_PANTS_DATA: Record<LoosePantsSize, LoosePantsSizeData> = {payload};
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="Layered MENSLOSSE-A0.pdf")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("src/engine/pattern/loosePantsData.ts"),
    )
    args = parser.parse_args()

    generated: dict[str, dict] = {}
    with tempfile.TemporaryDirectory(prefix="toile-loose-pants-") as tmp:
        tmpdir = Path(tmp)
        for size in SIZES:
            filtered = tmpdir / f"pants-{size}.pdf"
            filter_layer(args.source, size, filtered)
            svgs = []
            for page in (1, 2):
                svg = tmpdir / f"pants-{size}-p{page}.svg"
                subprocess.run(
                    ["pdftocairo", "-svg", "-f", str(page), "-l", str(page), str(filtered), str(svg)],
                    check=True,
                )
                svgs.append(svg)
            pieces = extract_size(read_svg(svgs[0]), read_svg(svgs[1]))
            alpha, eu, waist_range, hip_range = SIZE_CHART[size]
            generated[size] = {
                "alpha": alpha,
                "eu": eu,
                "waistRangeCm": waist_range,
                "hipRangeCm": hip_range,
                "nominalWaistCm": round(int(size) * 2.54, 1),
                "pieces": pieces,
            }
            dims = pieces["front"]["cutWidthCm"], pieces["front"]["cutHeightCm"]
            print(f"{size}: front {dims[0]:.1f} × {dims[1]:.1f} cm; {sum(len(p['outline']) for p in pieces.values())} vertices")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(typescript(generated))
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
