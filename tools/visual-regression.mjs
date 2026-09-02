import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "visual-regression", "latest");
const REQUIRED_VIEWS = ["overview", "pensions", "contributions", "target", "insights", "documents", "assistant", "settings"];
const REQUIRED_VARIABLES = ["--content-max", "--page-x", "--space-section", "--fs-top-title", "--fs-page-title", "--fs-card-title", "--fs-body"];

function assert(condition, message, failures) { if (!condition) failures.push(message); }

function extractVariables(css) {
  return Object.fromEntries([...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

async function main() {
  await rm(OUT_DIR, { recursive:true,force:true });
  await mkdir(OUT_DIR, { recursive:true });
  const [html,css,appJs,serverJs,chatService] = await Promise.all([
    readFile(path.join(ROOT, "index.html"), "utf8"),
    readFile(path.join(ROOT, "styles.css"), "utf8"),
    readFile(path.join(ROOT, "app.js"), "utf8"),
    readFile(path.join(ROOT, "server.js"), "utf8"),
    readFile(path.join(ROOT, "server/services/chatService.js"), "utf8")
  ]);
  const failures = [];
  const variables = extractVariables(css);
  for (const view of REQUIRED_VIEWS) {
    assert(new RegExp(`<section\\s+class="view[^>]*id="${view}"|<section\\s+id="${view}"[^>]*class="view`, "i").test(html), `Missing ${view} view section.`, failures);
    assert(new RegExp(`data-view="${view}"`, "i").test(html), `Missing navigation or action for ${view}.`, failures);
  }
  for (const variable of REQUIRED_VARIABLES) assert(Boolean(variables[variable]), `Missing design-system variable ${variable}.`, failures);
  assert(/font-family:\s*"Inter"/.test(css), "Inter should be the single declared UI font.", failures);
  assert(!/Calibri/.test(css), "Do not mix Calibri into the UI.", failures);
  assert(/\.segment-btn\.active[\s\S]*color:\s*#fff/.test(css), "Selected projection tabs must have readable high-contrast text.", failures);
  assert(!/id="investments"|data-view="investments"/.test(html), "Investments page and navigation must be removed.", failures);
  assert(/Qwen3-8B/.test(html), "Assistant should identify Qwen3-8B as its local model.", failures);
  assert(!/data-api-provider|data-api-key|data-api-endpoint/.test(appJs), "Cloud provider/key/endpoint controls must be absent.", failures);
  assert(!/\/api\/test-connection|\/api\/investment-review/.test(serverJs), "Deleted provider testing routes must stay absent.", failures);
  assert(/\/api\/portfolio/.test(serverJs), "Server must expose the verified portfolio endpoint.", failures);
  assert(/handleChatRoute/.test(serverJs) && /attachChatWebSocket/.test(serverJs), "REST and WebSocket chat gateways must be attached.", failures);
  assert(/processQuery/.test(chatService) && /retrieve(?:Knowledge|ForQuery)/.test(chatService) && /validateGroundedAnswer/.test(chatService), "Chat must use query processing, retrieval and grounding validation.", failures);
  assert(/PUBLIC_FILES/.test(serverJs), "Static serving must use an allowlist.", failures);
  const report = {
    generatedAt:new Date().toISOString(),checkedViews:REQUIRED_VIEWS,
    variables:Object.fromEntries(REQUIRED_VARIABLES.map((name) => [name,variables[name] || null])),
    checks:{ localModelUi:/Qwen3-8B/.test(html),investmentsRemoved:!/id="investments"/.test(html),backendPortfolioEndpoint:/\/api\/portfolio/.test(serverJs),groundingPipeline:/validateGroundedAnswer/.test(chatService) },
    failures
  };
  await writeFile(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  if (failures.length) { console.error(failures.map((failure) => `- ${failure}`).join("\n")); process.exitCode=1; }
  else console.log(`Visual/static checks passed. Report written to ${path.relative(ROOT, path.join(OUT_DIR, "report.json"))}.`);
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode=1; });
