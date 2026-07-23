#!/usr/bin/env python3
"""Create a PDF with exactly one optional-content (OCG) layer enabled."""

from __future__ import annotations

import argparse
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, NameObject


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("layer")
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--hide-static",
        action="store_true",
        help="Hide non-numeric instruction layers as well as the other sizes.",
    )
    args = parser.parse_args()

    reader = PdfReader(args.source)
    if reader.is_encrypted:
        reader.decrypt("")

    root = reader.trailer["/Root"]
    ocprops = root["/OCProperties"]
    groups = list(ocprops["/OCGs"])
    selected = [group for group in groups if group.get_object().get("/Name") == args.layer]
    if not selected:
        names = ", ".join(str(group.get_object().get("/Name")) for group in groups)
        raise SystemExit(f"Layer {args.layer!r} not found. Available: {names}")

    # Keep structural/instruction layers visible and enable only the requested
    # graded-size layer among the numeric layers.
    numeric = [group for group in groups if str(group.get_object().get("/Name", "")).isdigit()]
    always_on = [] if args.hide_static else [group for group in groups if group not in numeric]
    defaults = ocprops["/D"]
    defaults[NameObject("/ON")] = ArrayObject(always_on + selected)
    defaults[NameObject("/OFF")] = ArrayObject(
        [
            group
            for group in groups
            if group not in selected and (args.hide_static or group in numeric)
        ]
    )

    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("wb") as target:
        writer.write(target)


if __name__ == "__main__":
    main()
