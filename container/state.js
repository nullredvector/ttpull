// Small persistent state that must survive container recreation.
// Lives in STATE_DIR (mount a volume there): session, browser profile, failures.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, 'state');
await fs.mkdir(STATE_DIR, { recursive: true }).catch(() => {});

const FAIL_FILE = path.join(STATE_DIR, 'failures.json');
export const MAX_FAILURES = 3;
let failures = {};
try { failures = JSON.parse(await fs.readFile(FAIL_FILE, 'utf8')); } catch { /* none yet */ }

async function persist() {
  await fs.writeFile(FAIL_FILE, JSON.stringify(failures)).catch(() => {});
}

export function givenUp(kind) {
  return new Set(Object.entries(failures[kind] || {}).filter(([, n]) => n >= MAX_FAILURES).map(([id]) => id));
}

export async function recordFailure(kind, id) {
  failures[kind] ??= {};
  failures[kind][id] = (failures[kind][id] || 0) + 1;
  await persist();
  return failures[kind][id];
}

export async function clearFailure(kind, id) {
  if (failures[kind]?.[id]) { delete failures[kind][id]; await persist(); }
}

// Small persistent flags (alert state), so a restart doesn't repeat alerts.
const FLAG_FILE = path.join(STATE_DIR, 'flags.json');
let flags = {};
try { flags = JSON.parse(await fs.readFile(FLAG_FILE, 'utf8')); } catch { /* none yet */ }

export const getFlag = k => flags[k];
export async function setFlag(k, v) {
  if (v === undefined || v === null || v === false) delete flags[k]; else flags[k] = v;
  await fs.writeFile(FLAG_FILE, JSON.stringify(flags)).catch(() => {});
}
