import "../server/loadEnv.js";
import { readdir,readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { upsertPublicFactCollection } from "../server/repositories/publicFactRepository.js";
import { flushDataStore,initialiseDataStore } from "../server/store/userDataStore.js";

const directory = resolve("approved-materials","structured-facts");
await initialiseDataStore();
for (const filename of (await readdir(directory)).filter((name) => name.endsWith(".json")).sort()) {
  const collection = JSON.parse(await readFile(resolve(directory,filename),"utf8"));
  const facts = await upsertPublicFactCollection(collection);
  console.log(`${collection.title}: ${facts.length} dated facts loaded`);
}
await flushDataStore();
