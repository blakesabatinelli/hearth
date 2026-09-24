#!/usr/bin/env node
/**
 * verify-gliner2-lock.mjs
 *
 * Verify `models/gliner2.lock.json` structure. GLiNER2 is the
 * schema-driven extractor that runs before Bonsai in the
 * natural-language pipeline (ADR-2026-09-24-gliner2-required).
 *
 * Lock file requirements:
 *   - pypi_package and pinned version
 *   - upstream repo URL, tag, commit SHA, license
 *   - runtime constraints (Python version, extras)
 *   - default + alternate checkpoints (Hugging Face hub IDs)
 *   - evaluation metric targets
 *
 * No floating "latest" references. The lock pins the PyPI version,
 * the GitHub tag/commit, and the Hugging Face checkpoint explicitly.
 * No weights committed to the Git repo (plan section 11).
 *
 * At Stage 0, the version is pinned. The checkpoint SHA cannot be
 * pinned locally because the checkpoint downloads at install time
 * from the HF Hub. The installer verifies the SHA from the HF API;
 * this lock records the hub_id + license so the user can see what
 * they are agreeing to install before `hearth install` runs.
 *
 * Usage:
 *   node scripts/verify-gliner2-lock.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const LOCK = join(process.cwd(), 'models', 'gliner2.lock.json');
if (!existsSync(LOCK)) {
  console.error(`verify-gliner2-lock: missing ${LOCK}`);
  process.exit(1);
}

const lock = JSON.parse(readFileSync(LOCK, 'utf8'));

const ERRORS = [];
const WARNINGS = [];

function must(field, path) {
  if (field === undefined || field === null || field === '') {
    ERRORS.push(`missing required field: ${path}`);
  }
}

must(lock.lock_version, 'lock_version');
must(lock.extractor?.family, 'extractor.family');
must(lock.extractor?.pypi_package, 'extractor.pypi_package');
must(lock.extractor?.version, 'extractor.version');
must(lock.extractor?.primary_source?.url, 'extractor.primary_source.url');
must(lock.extractor?.primary_source?.tag, 'extractor.primary_source.tag');
must(lock.extractor?.primary_source?.commit_sha, 'extractor.primary_source.commit_sha');
must(lock.extractor?.primary_source?.license, 'extractor.primary_source.license');
must(lock.extractor?.runtime?.language, 'extractor.runtime.language');
must(lock.extractor?.runtime?.min_version, 'extractor.runtime.min_version');
must(lock.extractor?.runtime?.sidecar_service, 'extractor.runtime.sidecar_service');
must(lock.extractor?.default_checkpoint?.hub_id, 'extractor.default_checkpoint.hub_id');

// Plan section 7 spirit: no floating latest references in released model profile.
const stringified = JSON.stringify(lock);
const latestReferences = stringified.match(/"[^"]*\blatest\b[^"]*"/gi) ?? [];
for (const m of latestReferences) {
  if (/no\s+'?latest'?|forbid'?|don'?t|disallow/i.test(m)) continue;
  ERRORS.push(`forbidden "latest" reference in lock: ${m}`);
}

// Apache-2.0 only (per ADR; no other licenses without re-approval).
const license = lock.extractor.primary_source.license;
if (license !== 'Apache-2.0' && !license.includes('Apache-2.0')) {
  WARNINGS.push(`license is ${license}; ADR-2026-09-24-gliner2-required expects Apache-2.0 family`);
}

const isRelease = process.env.HEARTH_RELEASE === '1';
if (isRelease) {
  if (lock.extractor.pypi?.sha256 === null || !lock.extractor.pypi?.sha256) {
    ERRORS.push('release requires real pypi sha256 (download once and pin)');
  }
  if (lock.extractor.status !== 'pinned') {
    ERRORS.push(`release requires extractor.status === 'pinned' (current: ${lock.extractor.status})`);
  }
}

if (ERRORS.length > 0) {
  console.error('verify-gliner2-lock: FAILED');
  for (const e of ERRORS) console.error(`  ERROR: ${e}`);
  for (const w of WARNINGS) console.error(`  WARN:  ${w}`);
  process.exit(1);
}

console.log('verify-gliner2-lock: OK');
for (const w of WARNINGS) console.log(`  WARN:  ${w}`);