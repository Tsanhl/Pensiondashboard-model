#!/usr/bin/env python3
"""Emit a content fingerprint for a pinned Python runtime and dependency closure."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import site
import sys

try:
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name
except ImportError as error:
    raise SystemExit(f"packaging is required to fingerprint the Python environment: {error}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_sha256(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def import_tree_fingerprint(raw_root: str) -> dict[str, object]:
    root = Path(raw_root).resolve()
    if not root.exists():
        return {"root": str(root), "type": "missing", "entries": 0, "records_sha256": canonical_sha256([])}
    if root.is_file():
        record = {"path": ".", "type": "file", "size": root.stat().st_size, "sha256": sha256_file(root)}
        return {"root": str(root), "type": "file", "entries": 1, "records_sha256": canonical_sha256([record])}
    if not root.is_dir():
        raise SystemExit(f"Unsupported Python import root: {root}")

    rows: list[dict[str, object]] = []

    def walk(current: Path) -> None:
        for path in sorted(current.iterdir(), key=lambda item: os.fsencode(item.name)):
            relative = str(path.relative_to(root))
            if path.is_symlink():
                target = path.resolve(strict=True)
                if target.is_dir():
                    raise SystemExit(f"Directory symlinks are forbidden in pinned Python import trees: {path}")
                if not target.is_file():
                    raise SystemExit(f"Unsupported Python import-tree symlink target: {path}")
                rows.append({
                    "path": relative,
                    "type": "symlink",
                    "link_target": os.readlink(path),
                    "target_realpath": str(target),
                    "size": target.stat().st_size,
                    "sha256": sha256_file(target),
                })
            elif path.is_dir():
                rows.append({"path": relative, "type": "directory"})
                walk(path)
            elif path.is_file():
                rows.append({"path": relative, "type": "file", "size": path.stat().st_size, "sha256": sha256_file(path)})
            else:
                raise SystemExit(f"Unsupported Python import-tree entry: {path}")

    walk(root)
    rows.sort(key=lambda row: os.fsencode(str(row["path"])))
    return {"root": str(root), "type": "directory", "entries": len(rows), "records_sha256": canonical_sha256(rows)}


def installed_distributions() -> dict[str, importlib.metadata.Distribution]:
    found: dict[str, importlib.metadata.Distribution] = {}
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata.get("Name")
        if name:
            found[canonicalize_name(name)] = distribution
    return found


def dependency_closure(roots: list[str], installed: dict[str, importlib.metadata.Distribution]) -> list[str]:
    pending = [canonicalize_name(name) for name in roots]
    resolved: set[str] = set()
    while pending:
        name = pending.pop()
        if name in resolved:
            continue
        distribution = installed.get(name)
        if distribution is None:
            raise SystemExit(f"Required Python distribution is missing: {name}")
        resolved.add(name)
        for raw in distribution.requires or []:
            try:
                requirement = Requirement(raw)
                if requirement.marker and not requirement.marker.evaluate({"extra": ""}):
                    continue
                dependency = canonicalize_name(requirement.name)
            except Exception:
                match = re.match(r"[A-Za-z0-9_.-]+", raw)
                if not match:
                    raise SystemExit(f"Cannot parse dependency requirement: {raw}")
                dependency = canonicalize_name(match.group(0))
            if dependency in installed and dependency not in resolved:
                pending.append(dependency)
    return sorted(resolved)


def distribution_fingerprint(name: str, distribution: importlib.metadata.Distribution) -> dict[str, object]:
    rows: list[dict[str, object]] = []
    for relative in sorted((str(item) for item in distribution.files or [])):
        if relative.endswith((".pyc", ".pyo")) or "/__pycache__/" in relative:
            continue
        path = Path(distribution.locate_file(relative))
        if not path.exists():
            rows.append({"path": relative, "missing": True})
            continue
        if path.is_symlink():
            rows.append({"path": relative, "symlink": os.readlink(path)})
            path = path.resolve()
        if path.is_file():
            rows.append({"path": relative, "size": path.stat().st_size, "sha256": sha256_file(path)})
    canonical_rows = json.dumps(rows, sort_keys=True, separators=(",", ":")).encode()
    return {
        "name": name,
        "version": distribution.version,
        "files": len(rows),
        "content_sha256": hashlib.sha256(canonical_rows).hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--roots", required=True, help="Comma-separated distribution names")
    args = parser.parse_args()
    roots = sorted({canonicalize_name(value.strip()) for value in args.roots.split(",") if value.strip()})
    installed = installed_distributions()
    closure = dependency_closure(roots, installed)
    executable = Path(sys.executable).resolve()
    payload = {
        "version": "python-environment-fingerprint-v2",
        "python_version": ".".join(map(str, sys.version_info[:3])),
        "executable_realpath": str(executable),
        "executable_sha256": sha256_file(executable),
        "roots": roots,
        "startup_contract": {
            "isolated": bool(sys.flags.isolated),
            "no_user_site": bool(sys.flags.no_user_site),
            "ignore_environment": bool(sys.flags.ignore_environment),
            "safe_path": bool(sys.flags.safe_path),
            "dont_write_bytecode": bool(sys.flags.dont_write_bytecode),
            "user_site_enabled": bool(site.ENABLE_USER_SITE),
            "sys_prefix": str(Path(sys.prefix).resolve()),
            "base_prefix": str(Path(sys.base_prefix).resolve()),
            "sys_path": [str(Path(value).resolve()) for value in sys.path],
        },
        "import_trees": [import_tree_fingerprint(value) for value in sys.path],
        "distributions": [distribution_fingerprint(name, installed[name]) for name in closure],
    }
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
