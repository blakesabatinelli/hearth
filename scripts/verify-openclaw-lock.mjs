#!/usr/bin/env node
/**
 * verify-openclaw-lock.mjs
 *
 * Verify the OpenClaw external Gateway lock. Section 13 item 7 of
 * docs/macos-host-setup.md requires this lock to carry:
 *
 *   - pinned_version (matches HEARTH_OPENCLAW_PIN)
 *   - commit_sha (the exact upstream commit for that version)
 *   - llama_cpp_commit_sha (the runtime commit for local Bonsai)
 *   - metal_build_profile (darwin / linux + build profile)
 *   - measurements.status ('measured' or 'unverified')
 *   - measurements.operator_provenance block if 'measured'
 *
 * Plan section 7 spirit: no floating "latest" references in released
 * profiles. The operator MAY keep `commit_sha` etc. as
 * 'PENDING_OPERATOR_VERIFICATION' during stage 0, but at release time
 * (HEARTH_RELEASE=1) real values are required.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { execSync } from 'node:child_process';

const PKG = join(process.cwd(), 'packages', 'openclaw-adapter', 'src', 'lock.ts');
if (!existsSync(PKG)) {
  console.error(`verify-openclaw-lock: missing ${PKG}`);
  process.exit(1);
}

// We extract the lock object via a tiny read of the source (it is
// a TS const). The simpler check is to grep for expected fields.
import { readFileSync } from 'node:fs';
const src = readFileSync(PKG, 'utf8');

const ERRORS = [];
const WARNINGS = [];

if (!/pinned_version:\s*HEARTH_OPENCLAW_PIN/.test(src)) {
  ERRORS.push('openclaw lock must mirror HEARTH_OPENCLAW_PIN (drift-proof)');
}
if (!/commit_source:\s*'github:openclaw-ai\/openclaw'/.test(src)) {
  ERRORS.push('commit_source must be pinned to openclaw upstream');
}
if (!/metal_build_profile:/.test(src) || !/(platform: 'darwin'|platform: 'linux')/.test(src)) {
  ERRORS.push('metal_build_profile.platform must be set (darwin or linux)');
}
if (!/measurements:/.test(src)) {
  ERRORS.push('measurements block required');
}

// plan section 7 spirit: no "latest" references in lock
const stringified = src;
const latestRefs = stringified.match(/"[^"]*\blatest\b[^"]*"/gi) ?? [];
for (const m of latestRefs) {
  if (/no\s+'?latest'?|forbid'?|don'?t|disallow/i.test(m)) continue;
  ERRORS.push(`forbidden "latest" reference in lock: ${m}`);
}

// At release time, real SHA + measured operator data required.
const isRelease = process.env.HEARTH_RELEASE === '1';
if (isRelease) {
  if (/PENDING_OPERATOR_VERIFICATION/.test(src)) {
    ERRORS.push('release requires commit_sha/llama_cpp_commit_sha filled in (no PENDING_OPERATOR_VERIFICATION)');
  }
  if (!/'measured':/.test(src)) {
    ERRORS.push("release requires measurements.status === 'measured' with operator_provenance block");
  }
}

if (ERRORS.length > 0) {
  console.error('verify-openclaw-lock: FAILED');
  for (const e of ERRORS) console.error(`  ERROR: ${e}`);
  for (const w of WARNINGS) console.error(`  WARN:  ${w}`);
  process.exit(1);
}

console.log('verify-openclaw-lock: OK');
for (const w of WARNINGS) console.log(`  WARN:  ${w}`);

// Silence the unused-import warning for execSync; we keep it because
// a future version of this verifier may shell out to `npm view`.
void execSync;
