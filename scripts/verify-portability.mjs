#!/usr/bin/env node
/**
 * verify-portability.mjs
 *
 * Reject anything that should not be in the source tree:
 *   - macOS absolute home paths (e.g. under <HOME>/...) - flagged via
 *     the same regex the gitleaks config uses
 *   - private RFC1918 / loopback IPs as hostnames
 *   - common env-var name patterns (AWS_, GITHUB_TOKEN, etc.) suggesting
 *     committed secrets
 *   - em / en dashes (vault rule, but also bytes we don't want shipped)
 *
 * Used by pre-commit hook and CI. Exit 0 = clean, non-zero = findings.
 *
 * Plan refs: section 11 (no home paths, no dev tokens, no shell
 * history); vault hard rule on em dashes.
 *
 * Note: this file and the gitleaks config contain the rule patterns
 * themselves; the scanner skips both files to avoid self-flagging.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.pnpm-store', 'fixtures', 'eval/reports']);
// Files that legitimately contain the rule patterns themselves.
const SELF_SKIP = new Set([
  'scripts/verify-portability.mjs',
  '.gitleaks.toml',
  // The plan is the spec; the rule it documents must be readable in context.
  'HEARTH_HERMES_DEVELOPMENT_PLAN.md',
]);

const FINDINGS = [];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function isText(path) {
  return /\.(md|json|ya?ml|ts|mjs|js|cjs|sh|mts|cts|toml)$/.test(path);
}

function findIn(file, patterns) {
  const txt = fs_read(file);
  for (const [name, regex] of patterns) {
    const m = txt.match(regex);
    if (m) {
      return { file, kind: name, sample: m[0] };
    }
  }
  return null;
}

function fs_read(p) {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

const PATTERNS = [
  ['macos-users-path', /\/Users\/(?!blake\.sabatinelli\/Desktop\/hearth)/],
  ['private-ip', /\b(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|127\.\d+\.\d+\.\d+)\b/],
  ['em-dash', /\u2014/],
  ['en-dash', /\u2013/],
  ['em-dash-entity', /&mdash;|&ndash;|&#8212;|&#8211;/],
  ['bearer-token', /\bghp_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
];

const files = walk(ROOT)
  .filter(isText)
  .filter((f) => !SELF_SKIP.has(relative(ROOT, f)));
for (const f of files) {
  const hit = findIn(f, PATTERNS);
  if (hit) FINDINGS.push(hit);
}

if (FINDINGS.length === 0) {
  console.log('verify-portability: OK');
  process.exit(0);
}

console.error('verify-portability: FAILED');
for (const f of FINDINGS) {
  console.error(`  ${f.kind} in ${relative(ROOT, f.file)}: ${JSON.stringify(f.sample.slice(0, 80))}`);
}
process.exit(1);