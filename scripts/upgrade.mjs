#!/usr/bin/env node
// upgrade.mjs - upgrade Hearth to the latest pinned release.
//
// Steps:
//   1. Run `pnpm install --frozen-lockfile` to pick up the new lockfile.
//   2. Run `pnpm -r build`.
//   3. Run `pnpm -r test` to verify.
//   4. Run `node scripts/doctor.sh` to verify health.
//   5. Print a summary; exit non-zero on any failure.
//
// `scripts/rollback.sh` reverses this.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function run(cmd, args, opts = {}) {
  console.log(`\n>>> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  return r.status ?? 1;
}

const steps = [
  ['pnpm', ['install', '--frozen-lockfile']],
  ['pnpm', ['-r', 'build']],
  ['pnpm', ['-r', '--filter=./packages/*', '--filter=./apps/*', 'test']],
];

let exit = 0;
for (const [cmd, args] of steps) {
  const code = run(cmd, args);
  if (code !== 0) { exit = code; break; }
}

if (exit === 0) {
  const doctor = path.join(root, 'scripts/doctor.sh');
  if (existsSync(doctor)) {
    console.log('\n>>> running scripts/doctor.sh');
    const r = spawnSync('bash', [doctor], { cwd: root, stdio: 'inherit' });
    if ((r.status ?? 1) !== 0) exit = r.status ?? 1;
  }
}

console.log(`\n>>> upgrade ${exit === 0 ? 'success' : 'FAILED'}`);
process.exit(exit);
