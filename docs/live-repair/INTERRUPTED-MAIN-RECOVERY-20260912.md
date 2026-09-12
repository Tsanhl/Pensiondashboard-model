# Interrupted main run: recovery decision

The current user explicitly delegated necessary local training amendments. This
is an implementation decision under that delegation, not a new owner signature.

The free10 main run stopped at 2026-09-12T11:49:52Z with
RESOURCE_METRICS_UNAVAILABLE. The missing field was process footprint; the same
sample reported 25% free memory and 4552.06 MiB swap. A three-second Python
subprocess was launched on every sample and its error details were discarded.
Timeout versus helper failure cannot be distinguished retrospectively. Do not
claim an observed memory-limit violation or fabricate the missing measurement.

Twenty-three updates are confirmed; validation before update24 was interrupted.
Only the step12 adapter is durable. Optimizer state was not saved. Reconstruct
that adapter from unchanged parent104 frozen tensors plus its exact saved56
trainable tensors, preserving the partial original. This is NOT an exact resume.

One bounded weight-only recovery segment may perform24 new updates with fresh
Adam state from the reconstructed step12 weights. It uses the unchanged reviewed
data, loss, four-layer subset, seed and all resource ceilings. No additional
gradient restart is planned. Across both segments there are at most47 confirmed
main updates (23+24), while the final weight lineage contains36 (12+24). The
discarded updates13–23 receive no lineage credit. Candidate lineage counts are
0,12,24,36; there is no checkpoint48. Report the changed study honestly.

Replace the Python-startup metric probe with a compiled native probe against the
same kernel API. Missing measurements still stop execution immediately; retain
exit status, signal, timeout and stderr in the new metrics. Save full adapter and
optimizer state at each recovery update, with receipts. Original source bindings,
failed logs and receipts remain immutable. No sealed access or qualification is
authorized by this recovery.
