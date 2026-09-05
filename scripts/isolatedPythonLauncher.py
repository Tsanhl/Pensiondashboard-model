#!/usr/bin/env python3
"""Run one pinned script or module with an explicit import root under Python -I."""

from __future__ import annotations

from pathlib import Path
import importlib.util
import runpy
import sys


def main() -> None:
    if not (sys.flags.isolated and sys.flags.no_user_site and sys.flags.ignore_environment and sys.flags.safe_path and sys.flags.dont_write_bytecode):
        raise SystemExit("Pinned Python launcher requires -I -B isolated startup")
    if len(sys.argv) < 5 or sys.argv[1] != "--root":
        raise SystemExit("usage: isolatedPythonLauncher.py --root PATH [--verify-module NAME=PATH ...] (--script PATH|--module NAME) [args...]")
    root = Path(sys.argv[2]).resolve(strict=True)
    cursor = 3
    expected_modules: list[tuple[str, Path]] = []
    while cursor < len(sys.argv) and sys.argv[cursor] == "--verify-module":
        if cursor + 1 >= len(sys.argv) or "=" not in sys.argv[cursor + 1]:
            raise SystemExit("--verify-module requires NAME=PATH")
        name, raw_path = sys.argv[cursor + 1].split("=", 1)
        if not name or any(part.startswith("_") or not part.replace("_", "a").isalnum() for part in name.split(".")):
            raise SystemExit("Pinned project module name is invalid")
        expected_modules.append((name, Path(raw_path).resolve(strict=True)))
        cursor += 2
    if cursor + 1 >= len(sys.argv) or sys.argv[cursor] not in {"--script", "--module"}:
        raise SystemExit("Pinned Python launcher mode is missing")
    mode, target, rest = sys.argv[cursor], sys.argv[cursor + 1], sys.argv[cursor + 2:]
    # Keep verified site-packages ahead of project code so a writable project
    # file cannot shadow a pinned third-party dependency such as uvicorn.
    sys.path.append(str(root))
    for name, expected_path in expected_modules:
        spec = importlib.util.find_spec(name)
        origin = Path(spec.origin).resolve(strict=True) if spec and spec.origin not in {None, "built-in", "frozen"} else None
        if origin != expected_path:
            raise SystemExit(f"Pinned project module {name} resolved outside its bound path")
    if mode == "--script":
        script = Path(target).resolve(strict=True)
        if script.parent != root:
            raise SystemExit("Pinned script must be an immediate child of its declared import root")
        sys.argv = [str(script), *rest]
        runpy.run_path(str(script), run_name="__main__")
    else:
        if not target or any(part.startswith("_") or not part.replace("_", "a").isalnum() for part in target.split(".")):
            raise SystemExit("Pinned module name is invalid")
        sys.argv = [target, *rest]
        runpy.run_module(target, run_name="__main__", alter_sys=False)


if __name__ == "__main__":
    main()
