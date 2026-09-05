#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] || "Log/qualification-worker");
const status = resolve(root, "STATUS.md");
const state = resolve(root, "worker-state.json");
if (existsSync(status)) process.stdout.write(readFileSync(status, "utf8"));
else if (existsSync(state)) process.stdout.write(readFileSync(state, "utf8"));
else process.stdout.write("Qualification worker has not started.\n");
