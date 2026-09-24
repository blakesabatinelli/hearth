#!/usr/bin/env node
/**
 * verify-bonsai-lock.mjs
 *
 * Verify models/bonsai.lock.json structure. Plan section 7 lock-file
 * requirements:
 *   - Model family + exact checkpoint revision
 *   - Artifact filenames, SHA-256 digests, source URLs
 *   - License identifiers and notices
 *   - Serving runtime version/source commit and build profile
 *   - Tokenizer/template compatibility
 *   - Context limit, output budget, supported schema mechanism
 *   - Validated host architecture and backend
 *
 * No floating "latest" references. Weights never committed.
 *
 * At Stage 0 many fields are "TBD" because real weights are deferred per
 * Decision 1 (2026-09-24). This script accepts TBD during stage 0 and
 * fails the build when we try to release a versioned tag without filled
 * sha256 + license + backend fields.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const LOCK = join(process.cwd(), 'models', 'bonsai.lock.json');
if (!existsSync(LOCK)) {
  console.error(`verify-bonsai-lock: missing ${LOCK}`);
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
must(lock.model?.family, 'model.family');
must(lock.model?.variant, 'model.variant');
must(lock.model?.primary_source?.url, 'model.primary_source.url');

const isRelease = process.env.HEARTH_RELEASE === '1';
if (isRelease) {
  // Stricter checks at release time.
  for (const a of lock.model?.artifacts ?? []) {
    if (a.sha256 === 'TBD' || !a.sha256) {
      ERRORS.push(`release requires real sha256 on ${a.role}`);
    }
    if (a.filename === 'TBD' || !a.filename) {
      ERRORS.push(`release requires real filename on ${a.role}`);
    }
  }
  if (lock.model.primary_source.license === 'TBD' || !lock.model.primary_source.license) {
    ERRORS.push('release requires real license on primary_source');
  }
  if (lock.model.host.backend === 'TBD' || !lock.model.host.backend) {
    ERRORS.push('release requires pinned host backend');
  }
  if (lock.model.status !== 'pinned') {
    ERRORS.push(`release requires model.status === 'pinned' (current: ${lock.model.status})`);
  }
} else {
  // Stage 0 / development: TBD is OK on weights/runtime fields, but
  // structure must be present.
  if (lock.model.status === 'TBD' || !lock.model.status) {
    WARNINGS.push(`model.status is TBD; acceptable at Stage 0, blocks release`);
  }
}

// Plan section 7: no floating latest references.
// Match "latest" as a JSON value (alone in its string) or as the
// trailing token of a string. A note that *mentions* the rule and quotes
// the word "latest" (e.g. "No 'latest' tag references in released
// profiles") is documentation, not a value - allow it.
const stringified = JSON.stringify(lock);
const latestReferences = stringified.match(/"[^"]*\blatest\b[^"]*"/gi) ?? [];
for (const m of latestReferences) {
  // Documentation pattern: appears in a notes string (mention of the
  // rule itself).
  if (/no\s+'?latest'?|forbid'?|don'?t|disallow/i.test(m)) continue;
  ERRORS.push(`forbidden "latest" reference in lock: ${m}`);
}

// Weights never committed (plan section 11). Just warn that the model
// weights must be downloaded at install time, not committed.
if (lock.model.artifacts?.some((a) => a.role === 'weights' && a.size_bytes !== null && a.size_bytes !== undefined)) {
  WARNINGS.push('weights size_bytes is set; verify weights are NOT actually committed to the repo');
}

if (ERRORS.length > 0) {
  console.error('verify-bonsai-lock: FAILED');
  for (const e of ERRORS) console.error(`  ERROR: ${e}`);
  for (const w of WARNINGS) console.error(`  WARN:  ${w}`);
  process.exit(1);
}

console.log('verify-bonsai-lock: OK');
for (const w of WARNINGS) console.log(`  WARN:  ${w}`);