#!/usr/bin/env python3
"""Return a Darwin process executable and boundary-preserving argv via KERN_PROCARGS2."""

from __future__ import annotations

import ctypes
import json
import struct
import sys


def main() -> None:
    if sys.platform != "darwin" or not (sys.flags.isolated and sys.flags.no_user_site and sys.flags.ignore_environment and sys.flags.safe_path):
        raise SystemExit("process argv probe requires Darwin and Python -I")
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        raise SystemExit("usage: processArgvDarwin.py PID")
    pid = int(sys.argv[1])
    libc = ctypes.CDLL(None, use_errno=True)
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2, pid
    size = ctypes.c_size_t()
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:
        raise OSError(ctypes.get_errno(), "KERN_PROCARGS2 size query failed")
    buffer = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
        raise OSError(ctypes.get_errno(), "KERN_PROCARGS2 read failed")
    data = buffer.raw[:size.value]
    argc = struct.unpack_from("i", data, 0)[0]
    offset = struct.calcsize("i")
    executable_end = data.index(b"\0", offset)
    executable = data[offset:executable_end].decode("utf-8", "surrogateescape")
    offset = executable_end + 1
    while offset < len(data) and data[offset] == 0:
        offset += 1
    argv = []
    for _ in range(argc):
        end = data.index(b"\0", offset)
        argv.append(data[offset:end].decode("utf-8", "surrogateescape"))
        offset = end + 1
    print(json.dumps({"pid": pid, "executable": executable, "argv": argv}, separators=(",", ":")))


if __name__ == "__main__":
    main()
