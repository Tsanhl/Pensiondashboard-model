import { createHash } from "node:crypto";
import { readdir,readFile,writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const directories = [
  resolve("approved-materials","index","legislation"),
  resolve("approved-materials","index","secondary-legislation")
];
const rebuiltAt = new Date().toISOString();
const version = Number(rebuiltAt.slice(0,10).replaceAll("-",""));
const python = process.env.WORKSPACE_PYTHON || "python3";
const requestedIds = new Set(String(process.env.MATERIAL_IDS || "").split(",").map((id)=>id.trim()).filter(Boolean));
let rebuilt = 0;

for (const directory of directories) {
  const metadataFiles = (await readdir(directory)).filter((name)=>name.endsWith("-metadata.json"))
    .filter((name)=>!requestedIds.size||requestedIds.has(name.slice(0,-"-metadata.json".length))).sort();
  for (const filename of metadataFiles) {
    const metadataPath = resolve(directory,filename);
    const metadata = JSON.parse(await readFile(metadataPath,"utf8"));
    const xmlPath = metadata.files.xml.path;
    const textPath = metadata.files.text.path;
    const normalized = spawnSync(python,[resolve("scripts","normalizeLegislation.py"),xmlPath,textPath],{ encoding:"utf8" });
    if (normalized.status !== 0) throw new Error(`Could not rebuild ${metadata.title}: ${normalized.stderr}`);
    const text = await readFile(textPath);
    metadata.version = version;
    metadata.retrieved_at = rebuiltAt;
    metadata.files.text = { path:textPath,bytes:text.length,sha256:createHash("sha256").update(text).digest("hex") };
    metadata.status_note = `${metadata.status_note} Structural text rebuilt with provision numbers and subsection paths on ${rebuiltAt.slice(0,10)}.`;
    await writeFile(metadataPath,`${JSON.stringify(metadata,null,2)}\n`);
    rebuilt += 1;
    console.log(`${metadata.title}: ${Math.round(text.length/1024)} KB structured text`);
  }
}
if(requestedIds.size&&rebuilt!==requestedIds.size)throw new Error("One or more MATERIAL_IDS did not match legislation metadata");
console.log(JSON.stringify({ rebuilt,version },null,2));
