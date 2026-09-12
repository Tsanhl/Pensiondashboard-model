// The OS boundary is installed before Node discovers/imports any test or helper.
// Child processes inherit Seatbelt restrictions, including reads through symlinks.
import { mkdtempSync, readdirSync, realpathSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
  throw new Error('Development tests require the tested macOS read-isolation boundary; no unsandboxed fallback.');
}
const output = mkdtempSync(join(tmpdir(), 'pension-development-tests-'));
const secret = join(output, 'protected-sentinel');
writeFileSync(secret, 'SYNTHETIC PROTECTED CONTENT - MUST NOT BE OPENED');
const alias = join(output, 'sentinel-alias');
symlinkSync(secret, alias);
const roots = ['training', 'training 2', 'Log', 'Logging', '01-question-set-review-revision-v2', 'Pensiondashboard-model-failclosed-20260902', 'test/formal']
  .map(p => resolve(root, p));
const protectedDraft = resolve(root, 'answering/training-scenarios-draft.jsonl');
const denied = [...new Set([...roots, ...roots.filter(existsSync).map(p => realpathSync(p)), protectedDraft, secret, realpathSync(secret)])];
const quote = value => JSON.stringify(value);
const profile = `(version 1)\n(allow default)\n(deny file-read-data\n${denied.map(p => `  (subpath ${quote(p)})`).join('\n')}\n)\n`;
const profilePath = join(output, 'development.sb');
writeFileSync(profilePath, profile);
// Inventory names only. Never recursively discover the excluded formal directory.
const allTests = readdirSync(join(root, 'test'), { withFileTypes:true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map(entry => join(root, 'test', entry.name)).sort();
const requested=[...new Set(process.argv.slice(2))];
const tests=requested.length?allTests.filter(path=>requested.includes(path.slice(path.lastIndexOf('/')+1))):allTests;
if(requested.length&&tests.length!==requested.length)throw Error('Only exact existing top-level development test filenames may be selected');
const receipt = { scope:'DEVELOPMENT_ONLY', protected_banks_opened:false, tests, excluded:[
  {path:'test/formal/chat-rag-fixture-audit.test.mjs',reason:'Protected visible-bank content audit'},
  {path:'test/formal/replacement-identity.test.mjs',reason:'Protected suite identity audit'},
  {path:'test/formal/pinned-preflight.test.mjs',reason:'Qualification input hash/cardinality audit'},
  {path:'test/formal/stage-child-watchdog.test.mjs',reason:'Installs a separate stage OS sandbox; run by qualification:test'},
  {path:'test/formal/reviewer-os-profile.test.mjs',reason:'Separate OS sandbox smoke check; macOS forbids nested sandbox installation; run by qualification:test'}
], denied_paths:denied, output };
writeFileSync(join(output, 'inventory.json'), JSON.stringify(receipt, null, 2));
console.log(`Development test boundary and inventory: ${output}`);
const result = spawnSync('/usr/bin/sandbox-exec', ['-f', profilePath, process.execPath, '--test', '--test-concurrency=1', ...tests], {
  cwd:root, stdio:'inherit', env:{ ...process.env, PENSIONS_DB_PATH:join(output, 'tests.sqlite'),
    DEVELOPMENT_PROTECTED_SENTINEL:secret, DEVELOPMENT_PROTECTED_ALIAS:alias }
});
writeFileSync(join(output, 'result.json'), JSON.stringify({ ...receipt, exit_code:result.status, signal:result.signal, error:result.error?.message }, null, 2));
process.exitCode = result.status ?? 1;
