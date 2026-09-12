"""Read macOS kernel accounting without suspending the target (unlike vmmap)."""
import ctypes
import json
import sys

class RusageV2(ctypes.Structure):
    # macOS SDK sys/resource.h rusage_info_v2; byte-sized UUID + 18 uint64 fields.
    _fields_ = [('uuid',ctypes.c_uint8*16)] + [(name,ctypes.c_uint64) for name in (
        'user_time','system_time','pkg_idle_wkups','interrupt_wkups','pageins',
        'wired_size','resident_size','phys_footprint','proc_start_abstime',
        'proc_exit_abstime','child_user_time','child_system_time','child_pkg_idle_wkups',
        'child_interrupt_wkups','child_pageins','child_elapsed_abstime',
        'diskio_bytesread','diskio_byteswritten')]

usage=RusageV2()
lib=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)
lib.proc_pid_rusage.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_void_p]
lib.proc_pid_rusage.restype=ctypes.c_int
pid=int(sys.argv[1])
if lib.proc_pid_rusage(pid,2,ctypes.byref(usage)) != 0:
    raise OSError(ctypes.get_errno(),'proc_pid_rusage unavailable')
print(json.dumps({'pid':pid,'physical_footprint_gib':usage.phys_footprint/1024**3,'source':'proc_pid_rusage_v2','start_abstime':usage.proc_start_abstime}))
