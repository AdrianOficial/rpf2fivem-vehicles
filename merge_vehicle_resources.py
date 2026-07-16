#!/usr/bin/env python3
"""Merge multiple FiveM vehicle resources into one resource.

Run from the folder that contains the vehicle resource folders:
    python tools/merge_vehicle_resources.py --output merged_vehicles
"""

from __future__ import annotations

import argparse
import copy
import filecmp
import re
import shutil
import sys
from collections import OrderedDict, defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET


DATA_FILE_TYPES = OrderedDict(
    [
        ("vehicles.meta", "VEHICLE_METADATA_FILE"),
        ("handling.meta", "HANDLING_FILE"),
        ("carcols.meta", "CARCOLS_FILE"),
        ("carvariations.meta", "VEHICLE_VARIATION_FILE"),
        ("vehiclelayouts.meta", "VEHICLE_LAYOUTS_FILE"),
        ("dlctext.meta", "TEXTFILE_METAFILE"),
    ]
)

EXPECTED_ROOTS = {
    "vehicles.meta": "CVehicleModelInfo__InitDataList",
    "handling.meta": "CHandlingDataMgr",
    "carcols.meta": "CVehicleModelInfoVarGlobal",
    "carvariations.meta": "CVehicleModelInfoVariation",
    "vehiclelayouts.meta": "CVehicleMetadataMgr",
    "dlctext.meta": "CExtraTextMetaFile",
}

IGNORED_DIRS = {".git", ".agents", ".codex", "tools"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Scan vehicle resource folders and build one merged FiveM resource."
    )
    parser.add_argument(
        "--base",
        type=Path,
        default=Path.cwd(),
        help="Folder containing the vehicle resources. Defaults to the current folder.",
    )
    parser.add_argument(
        "--output",
        default="merged_vehicles",
        help="Name or path of the generated resource folder.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Delete the output folder first if it already exists.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Scan and validate only; do not write the merged resource.",
    )
    return parser.parse_args()


def strip_xml_comments(raw: str) -> str:
    # Some GTA/FiveM meta files contain comments such as <!---text--->,
    # which FiveM accepts but strict XML parsers reject.
    return re.sub(r"<!--[\s\S]*?-->", "", raw)


def parse_meta(path: Path) -> ET.Element:
    raw = path.read_text(encoding="utf-8-sig", errors="replace")
    clean = strip_xml_comments(raw)
    return ET.fromstring(clean)


def clone(element: ET.Element) -> ET.Element:
    return copy.deepcopy(element)


def element_children(element: ET.Element) -> list[ET.Element]:
    return [child for child in list(element) if isinstance(child.tag, str)]


def append_children(target: ET.Element, source: ET.Element) -> int:
    count = 0
    for child in element_children(source):
        target.append(clone(child))
        count += 1
    return count


def ensure_child(parent: ET.Element, tag: str) -> ET.Element:
    child = parent.find(tag)
    if child is None:
        child = ET.SubElement(parent, tag)
    return child


def merge_vehicles(files: list[Path]) -> tuple[ET.Element, int]:
    root = ET.Element("CVehicleModelInfo__InitDataList")
    ET.SubElement(root, "residentTxd").text = "vehshare"
    ET.SubElement(root, "residentAnims")
    init_datas = ET.SubElement(root, "InitDatas")
    txd_relationships = ET.SubElement(root, "txdRelationships")

    count = 0
    for path in files:
        source = parse_meta(path)
        source_init_datas = source.find("InitDatas")
        if source_init_datas is not None:
            count += append_children(init_datas, source_init_datas)

        source_txd_relationships = source.find("txdRelationships")
        if source_txd_relationships is not None:
            append_children(txd_relationships, source_txd_relationships)

    return root, count


def merge_single_container(
    files: list[Path], root_tag: str, container_tag: str
) -> tuple[ET.Element, int]:
    root = ET.Element(root_tag)
    container = ET.SubElement(root, container_tag)

    count = 0
    for path in files:
        source = parse_meta(path)
        source_container = source.find(container_tag)
        if source_container is not None:
            count += append_children(container, source_container)

    return root, count


def merge_grouped_containers(files: list[Path], root_tag: str) -> tuple[ET.Element, int]:
    root = ET.Element(root_tag)
    count = 0

    for path in files:
        source = parse_meta(path)
        for source_container in element_children(source):
            target_container = ensure_child(root, source_container.tag)
            children = element_children(source_container)
            if children:
                for child in children:
                    target_container.append(clone(child))
                    count += 1
            elif len(target_container) == 0 and not target_container.attrib:
                target_container.attrib.update(source_container.attrib)
                target_container.text = source_container.text

    return root, count


def build_dlctext() -> tuple[ET.Element, int]:
    root = ET.Element("CExtraTextMetaFile")
    ET.SubElement(root, "hasGlobalTextFile", {"value": "true"})
    ET.SubElement(root, "hasAdditionalText", {"value": "false"})
    ET.SubElement(root, "isTitleUpdate", {"value": "false"})
    return root, 3


def write_xml(path: Path, root: ET.Element) -> None:
    ET.indent(root, space="  ")
    tree = ET.ElementTree(root)
    tree.write(path, encoding="utf-8", xml_declaration=True, short_empty_elements=True)


def find_resource_dirs(base: Path, output: Path) -> list[Path]:
    output = output.resolve()
    resources: list[Path] = []

    for child in sorted(base.iterdir(), key=lambda item: item.name.casefold()):
        if not child.is_dir():
            continue
        if child.name in IGNORED_DIRS or child.name.startswith("."):
            continue
        if child.resolve() == output:
            continue
        has_data = (child / "data").is_dir()
        has_stream = (child / "stream").is_dir()
        has_manifest = (child / "fxmanifest.lua").is_file() or (child / "__resource.lua").is_file()
        if has_manifest and (has_data or has_stream):
            resources.append(child)

    return resources


def collect_meta_files(resources: list[Path]) -> dict[str, list[Path]]:
    meta_files: dict[str, list[Path]] = {name: [] for name in DATA_FILE_TYPES}

    for resource in resources:
        data_dir = resource / "data"
        if not data_dir.is_dir():
            continue
        for name in DATA_FILE_TYPES:
            path = data_dir / name
            if path.is_file():
                meta_files[name].append(path)

    return meta_files


def validate_meta_files(meta_files: dict[str, list[Path]]) -> list[str]:
    errors: list[str] = []

    for name, files in meta_files.items():
        expected_root = EXPECTED_ROOTS[name]
        if name == "dlctext.meta":
            continue

        for path in files:
            try:
                root = parse_meta(path)
            except ET.ParseError as exc:
                errors.append(f"{path}: XML parse error: {exc}")
                continue
            if root.tag != expected_root:
                errors.append(
                    f"{path}: expected root <{expected_root}> for {name}, found <{root.tag}>"
                )

    return errors


def collect_stream_files(resources: list[Path]) -> tuple[dict[Path, Path], list[str]]:
    copies: dict[Path, Path] = {}
    conflicts: list[str] = []

    for resource in resources:
        stream_dir = resource / "stream"
        if not stream_dir.is_dir():
            continue
        for source in sorted(stream_dir.rglob("*"), key=lambda item: str(item).casefold()):
            if not source.is_file():
                continue
            relative_target = Path("stream") / source.relative_to(stream_dir)
            existing = copies.get(relative_target)
            if existing is None:
                copies[relative_target] = source
                continue
            if not filecmp.cmp(existing, source, shallow=False):
                conflicts.append(
                    f"{relative_target} exists in both {existing.parent.parent.name} and {resource.name}"
                )

    return copies, conflicts


def merge_meta(meta_files: dict[str, list[Path]]) -> dict[str, tuple[ET.Element, int]]:
    merged: dict[str, tuple[ET.Element, int]] = {}

    if meta_files["vehicles.meta"]:
        merged["vehicles.meta"] = merge_vehicles(meta_files["vehicles.meta"])
    if meta_files["handling.meta"]:
        merged["handling.meta"] = merge_single_container(
            meta_files["handling.meta"], "CHandlingDataMgr", "HandlingData"
        )
    if meta_files["carcols.meta"]:
        merged["carcols.meta"] = merge_grouped_containers(
            meta_files["carcols.meta"], "CVehicleModelInfoVarGlobal"
        )
    if meta_files["carvariations.meta"]:
        merged["carvariations.meta"] = merge_single_container(
            meta_files["carvariations.meta"], "CVehicleModelInfoVariation", "variationData"
        )
    if meta_files["vehiclelayouts.meta"]:
        merged["vehiclelayouts.meta"] = merge_grouped_containers(
            meta_files["vehiclelayouts.meta"], "CVehicleMetadataMgr"
        )
    if meta_files["dlctext.meta"]:
        merged["dlctext.meta"] = build_dlctext()

    return merged


def write_manifest(path: Path, resource_name: str, meta_names: list[str]) -> None:
    file_lines = "\n".join(f"  'data/{name}'," for name in meta_names)
    data_lines = "\n".join(
        f"data_file '{DATA_FILE_TYPES[name]}' 'data/{name}'" for name in meta_names
    )
    content = f"""fx_version 'cerulean'
game 'gta5'

name '{resource_name}'
author 'generated by tools/merge_vehicle_resources.py'

files {{
{file_lines}
}}

{data_lines}
"""
    path.write_text(content, encoding="utf-8")


def write_source_report(path: Path, resources: list[Path], meta_files: dict[str, list[Path]]) -> None:
    lines = [
        "Merged vehicle resources",
        "========================",
        "",
        "Included resources:",
    ]
    lines.extend(f"- {resource.name}" for resource in resources)
    lines.append("")
    lines.append("Meta inputs:")
    for name, files in meta_files.items():
        lines.append(f"- {name}: {len(files)}")
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def write_resource(
    output: Path,
    resources: list[Path],
    meta_files: dict[str, list[Path]],
    stream_copies: dict[Path, Path],
    merged_meta: dict[str, tuple[ET.Element, int]],
    force: bool,
) -> None:
    if output.exists():
        if not force:
            raise RuntimeError(f"{output} already exists. Use --force to rebuild it.")
        shutil.rmtree(output)

    data_dir = output / "data"
    data_dir.mkdir(parents=True)
    (output / "stream").mkdir()

    meta_names = [name for name in DATA_FILE_TYPES if name in merged_meta]
    for name in meta_names:
        root, _ = merged_meta[name]
        write_xml(data_dir / name, root)

    for relative_target, source in sorted(stream_copies.items(), key=lambda item: str(item[0]).casefold()):
        target = output / relative_target
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    write_manifest(output / "fxmanifest.lua", output.name, meta_names)
    write_source_report(output / "MERGED_SOURCES.txt", resources, meta_files)


def print_summary(
    resources: list[Path],
    meta_files: dict[str, list[Path]],
    stream_copies: dict[Path, Path],
    merged_meta: dict[str, tuple[ET.Element, int]],
    output: Path,
    dry_run: bool,
) -> None:
    action = "Would write" if dry_run else "Wrote"
    print(f"{action}: {output}")
    print(f"Resources: {len(resources)}")
    print(f"Stream files: {len(stream_copies)}")

    print("Meta files:")
    for name in DATA_FILE_TYPES:
        inputs = len(meta_files[name])
        if name in merged_meta:
            _, entries = merged_meta[name]
            print(f"  {name}: {inputs} input files, {entries} merged entries")
        else:
            print(f"  {name}: {inputs} input files, skipped")


def main() -> int:
    args = parse_args()
    base = args.base.resolve()
    output = Path(args.output)
    if not output.is_absolute():
        output = base / output
    output = output.resolve()

    if not base.is_dir():
        print(f"Base folder does not exist: {base}", file=sys.stderr)
        return 1

    resources = find_resource_dirs(base, output)
    if not resources:
        print(f"No vehicle resources found in {base}", file=sys.stderr)
        return 1

    meta_files = collect_meta_files(resources)
    errors = validate_meta_files(meta_files)
    stream_copies, stream_conflicts = collect_stream_files(resources)
    errors.extend(stream_conflicts)

    if errors:
        print("Cannot build merged resource:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    merged_meta = merge_meta(meta_files)

    if not args.dry_run:
        try:
            write_resource(output, resources, meta_files, stream_copies, merged_meta, args.force)
        except RuntimeError as exc:
            print(str(exc), file=sys.stderr)
            return 1

    print_summary(resources, meta_files, stream_copies, merged_meta, output, args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
