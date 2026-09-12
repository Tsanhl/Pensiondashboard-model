import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

test('OS development boundary denies sentinel reads directly, through aliases and in child processes', () => {
  const paths = [process.env.DEVELOPMENT_PROTECTED_SENTINEL, process.env.DEVELOPMENT_PROTECTED_ALIAS];
  assert.ok(paths.every(Boolean), 'Use npm test: boundary must exist before imports');
  for (const path of paths) {
    assert.throws(() => readFileSync(path), error => ['EPERM','EACCES'].includes(error.code));
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import {readFileSync} from "node:fs"; try {readFileSync(process.argv[1]); process.exit(2)} catch(e) {process.exit(["EPERM","EACCES"].includes(e.code)?0:3)}', path],
      { encoding:'utf8', env:{} });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '');
  }
});
