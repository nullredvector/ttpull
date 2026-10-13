// Every container source file must at least parse. Some modules (the scheduler, the browser sync,
// the server) pull in the browser library and aren't loaded by the other tests, so a typo in them
// would otherwise only show up when the container fails to start.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const file of readdirSync(root).filter(f => f.endsWith('.js')).sort()) {
  test(`${file} parses`, () => {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' }));
  });
}
