// Publish current source bytes without publishing the private workspace history.
// Default is a dry run. Use --publish only when the user has requested a push.
import {execFileSync} from 'node:child_process';
import {readFileSync, lstatSync, mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = 'https://github.com/Tsanhl/Pensiondashboard-model.git';
const branch = 'main';
const ref = `refs/heads/${branch}`;
const localRef = 'refs/heads/codex/public-latest';
const git = (args, options = {}) => execFileSync('git', args, {cwd:root, encoding:'utf8', ...options}).trim();
if (git(['remote','get-url','origin']) !== target) throw Error('Unexpected origin; refusing publication');
const exact = new Set([
  '.env.example','.gitattributes','.gitignore','app.js','index.html','styles.css','server.js',
  'package.json','package-lock.json','render.yaml','README.md','AGENTS.md',
  'models/base-model-directory-manifest.json','models/retrieval-snapshot-manifest.json','runtime/python-environments.json',
  'evaluation/qualification-review-calibration-v2.json',
  'approved-materials/approved-corpus-manifest.json',
  'approved-materials/approved-corpus-manifest-20260908-repair-v1.json',
  'CHANGELOG_v3.md','MANIFEST_SHA256.json','PACK_CHECK_REPORT.json','PDU50_Questions.md',
  'Pension_Dashboard_Full_Execution_Contract_v3.txt','README_START_HERE.md','START_CODEX.txt',
  'docs/PUBLIC-CODE-SYNC.md','models/model-manifest.json','runtime/runtime-manifest.json',
  'answering/answer-policy-v1.md','answering/source-priority.md','answering/PRIVATE-MATERIAL-ADMISSION.md',
]);
// Filter metadata BEFORE opening content. No protected tree is traversed/read.
const permitted = p => exact.has(p)
  || /^(scripts|server|ml|config|tools|infra)\/.+\.(mjs|js|py|c|json|txt|sql|sh|ya?ml)$/.test(p)
  || /^docs\/[^/]+\.md$/.test(p)
  || (/^docs\/live-repair\/[^/]+\.(md|json)$/.test(p) && !p.endsWith('/LEGAL-TRACE-SUMMARY.json'))
  || /^test\/[^/]+\.(test\.mjs|py)$/.test(p)
  || /^test\/fixtures\/(pinned-worker\.mjs|live-repair\/owner-questions\.json)$/.test(p)
  || /^(evaluation\/pdu50|fixtures|policy)\/[^/]+\.(jsonl?|md|txt)$/.test(p);
const names = [...new Set([...git(['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(permitted),...exact])]
  .filter(p => existsSync(join(root,p))).sort();
const secrets = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b|\bsk-proj-[A-Za-z0-9_-]{30,}\b/;
for (const name of names) {
  const path = join(root,name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 5_000_000) throw Error(`Non-source file rejected: ${name}`);
  const bytes = readFileSync(path);
  // This one reviewed test literal is deliberately incomplete, not a key.
  const inspected = name === 'test/final-release-packaging.test.mjs'
    ? bytes.toString('utf8').replace('-----BEGIN ' + 'PRIVATE KEY-----\\nabc', 'SYNTHETIC_INVALID_KEY_FIXTURE')
    : bytes.toString('utf8');
  if (bytes.includes(0) || secrets.test(inspected)) throw Error(`Content safety check failed: ${name}`);
}
const priorNames = git(['ls-tree','-r','--name-only','origin/main']).split('\n');
const deletions = priorNames.filter(p => !names.includes(p));
console.log(JSON.stringify({target,branch,files:names.length,scope:'Exact public project snapshot; deletions synchronized; no private Git ancestry',deletions,names},null,2));
if (!process.argv.includes('--publish')) process.exit(0);
git(['fetch','origin']);
const remoteBranch = git(['ls-remote','--heads','origin',ref]);
const parent = remoteBranch ? remoteBranch.split(/\s/)[0] : git(['rev-parse','refs/remotes/origin/main']);
const temporary = mkdtempSync(join(tmpdir(),'pension-public-index-'));
try {
  const env = {...process.env,GIT_INDEX_FILE:join(temporary,'index')};
  // An empty temporary index makes remote-only/deleted files disappear from
  // the new snapshot, without deleting files or changing the working index.
  git(['read-tree','--empty'],{env});
  git(['add','--force','--',...names],{env});
  // Preserve hash-bound supplied pack bytes, including its trailing blank line.
  git(['-c','core.whitespace=-blank-at-eof','diff','--cached','--check'],{env});
  const tree = git(['write-tree'],{env});
  const unchanged = tree === git(['rev-parse',`${parent}^{tree}`]);
  const commit = unchanged ? parent : git(['commit-tree',tree,'-p',parent,'-m','Sync latest development code, bounded training recovery and PDU50 integration']);
  // Preserve local main/private working history; push the public snapshot
  // directly to remote main, as an ordinary fast-forward with its existing parent.
  git(['update-ref',localRef,commit]);
  git(['push','origin',`${localRef}:${ref}`]);
  const remoteHead = git(['ls-remote','--heads','origin',ref]).split(/\s/)[0];
  if (remoteHead !== commit) throw Error('Remote verification failed');
  console.log(JSON.stringify({pushed:true,commit,branch,files:names.length,deletions_synchronized:true}));
} finally {
  rmSync(temporary,{recursive:true});
}
