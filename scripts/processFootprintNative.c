#include <libproc.h>
#include <sys/resource.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char *end; long pid = strtol(argv[1], &end, 10);
  if (*end || pid <= 0 || pid > 2147483647) return 2;
  struct rusage_info_v2 usage = {0};
  if (proc_pid_rusage((int)pid, RUSAGE_INFO_V2, (rusage_info_t *)&usage)) {
    fprintf(stderr, "proc_pid_rusage errno=%d\n", errno); return 3;
  }
  printf("{\"pid\":%ld,\"physical_footprint_gib\":%.12f,\"start_abstime\":%llu}\n",
    pid, (double)usage.ri_phys_footprint / 1073741824.0,
    (unsigned long long)usage.ri_proc_start_abstime);
  return 0;
}
