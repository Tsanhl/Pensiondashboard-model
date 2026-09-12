import { auditTrainingDataset } from "./lib/trainingEvidenceIntegrity.mjs";
const paths = process.argv.slice(2);
if (!paths.length) throw new Error("Pass approved training dataset directories; do not pass gold or unseen sets.");
const datasets = paths.map(auditTrainingDataset);
console.log(JSON.stringify({ generated_at:new Date().toISOString(), status:datasets.every((x) => x.passed) ? "passed_exact_echo_check_only" : "blocked_answer_in_input", unseen_accessed:false, datasets }, null, 2));
if (!datasets.every((x) => x.passed)) process.exitCode = 1;
