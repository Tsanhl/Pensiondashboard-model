import { createInterface } from "node:readline";
console.log(JSON.stringify({ type: "ready", identity: { id: "test-pinned", adapter_sha256: "test-adapter", base_sha256: "test-base" } }));
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.messages[0].content === "hang") return;
  console.log(JSON.stringify({ type: "result", id: request.id, content: '{"answer":"ok","citation_ids":[]}', finish_reason: "stop", usage: { total_tokens: 2 } }));
});
