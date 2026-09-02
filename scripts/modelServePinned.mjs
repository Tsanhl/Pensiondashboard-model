import { resolve } from "node:path";
import { createPinnedModelServer } from "../server/services/pinnedModelServer.js";

const checkpoint = resolve(process.env.PENSION_CHECKPOINT_PATH || "training/evaluation-cycle-v2/02-wave-3-execution/training/cumulative-lora-v1/checkpoint-selection.json");
const service = createPinnedModelServer({
  command: resolve(".training-venv/bin/python"),
  args: ["-u", resolve("ml/pinned_mlx_worker.py"), checkpoint],
  // Evaluation clients retain their own 120-second case timeout. The slightly
  // longer supervisor window permits one non-scored system-prefix warm-up on
  // slower 16 GB Macs; a client timeout/disconnect still cancels immediately.
  deadlineMs: Number(process.env.PINNED_MODEL_DEADLINE_MS || 180_000),
  startupMs: Number(process.env.PINNED_MODEL_STARTUP_MS || 120_000),
});
service.server.listen(Number(process.env.PINNED_MODEL_PORT || 8080), "127.0.0.1", () => console.log("Local pinned MLX service starting (not a production server)"));
service.server.on("error", async (error) => { console.error(error.message); await service.stop(); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await service.stop(); });
