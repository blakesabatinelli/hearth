#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { loadDefaultFixture } from '../packages/ha-adapter/dist/src/index.js';
import { RegistryOverlay } from '../packages/registry/dist/src/index.js';
import { GrammarParser, Interpreter } from '../packages/interpreter/dist/src/index.js';
import { HearthExtractHttpClient } from '../packages/extractor/dist/src/index.js';
import { OpenClawBonsaiProvider } from '../packages/openclaw-adapter/dist/src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corpusPath = resolve(root, 'eval/commands/stage3-corpus.jsonl');
const reportDir = resolve(root, 'eval/reports');
const mode = process.argv[2] ?? 'grammar';
if (!['grammar', 'gliner2', 'bonsai', 'combined'].includes(mode)) {
  throw new Error('usage: node scripts/evaluate-stage3.mjs grammar|gliner2|bonsai|combined');
}

const corpus = (await readFile(corpusPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
if (corpus.length !== 200) throw new Error(`expected 200 cases, got ${corpus.length}`);
const fixture = loadDefaultFixture();
const registry = new RegistryOverlay({ devices: fixture.devices, rooms: fixture.rooms, entity_version: 1, scene_versions: {} });
const snapshot = registry.snapshot();
const roomById = new Map(snapshot.rooms.map((room) => [String(room.room_id), room.name]));
const context = {
  known_devices: snapshot.devices.map((device) => ({
    canonical_id: device.canonical_id,
    friendly_name: device.friendly_name,
    aliases: device.aliases,
    room_name: device.room_id ? (roomById.get(String(device.room_id)) ?? null) : null,
  })),
  known_scenes: [],
  recent_fresh_state: [],
};

let glinerCalls = 0;
let bonsaiCalls = 0;
const extractUrl = process.env.HEARTH_EXTRACT_URL ?? '';
const openclawUrl = process.env.HEARTH_OPENCLAW_URL ?? '';
const gatewayToken = process.env.HEARTH_GATEWAY_TOKEN ?? '';
const bonsaiTimeoutMs = Number(process.env.HEARTH_BONSAI_TIMEOUT_MS ?? 300_000);
if (!Number.isSafeInteger(bonsaiTimeoutMs) || bonsaiTimeoutMs < 1) {
  throw new Error('HEARTH_BONSAI_TIMEOUT_MS must be a positive integer');
}
const extractor = mode === 'gliner2' || mode === 'combined'
  ? new HearthExtractHttpClient({ base_url: extractUrl, timeout_ms: 30_000 })
  : null;
const bonsai = mode === 'bonsai' || mode === 'combined'
  ? new OpenClawBonsaiProvider({ base_url: openclawUrl, token: gatewayToken, timeout_ms: bonsaiTimeoutMs })
  : null;
if (extractor) {
  if (!extractUrl) throw new Error('HEARTH_EXTRACT_URL is required for this path');
  const health = await extractor.health();
  if (!health.ready) throw new Error('GLiNER2 sidecar is not ready');
}
if (bonsai && (!openclawUrl || !gatewayToken)) throw new Error('HEARTH_OPENCLAW_URL and HEARTH_GATEWAY_TOKEN are required for this path');

const countedExtractor = extractor ? {
  health: (...args) => extractor.health(...args),
  extract: (...args) => { glinerCalls++; return extractor.extract(...args); },
} : null;
const countedBonsai = bonsai ? {
  validateProposal: (raw) => bonsai.validateProposal(raw),
  propose: (request) => { bonsaiCalls++; return bonsai.propose(request); },
} : null;

const grammar = new GrammarParser({ registry });
const interpreter = mode === 'gliner2' || mode === 'combined'
  ? new Interpreter({ registry, gliner2: countedExtractor, bonsai: mode === 'combined' ? countedBonsai : null })
  : mode === 'bonsai'
    ? new Interpreter({ registry, gliner2: null, bonsai: null })
    : null;

const control = await import(pathToFileURL(resolve(root, 'apps/control/dist/src/contract-builder.js')).href);
const registryAdapter = await import(pathToFileURL(resolve(root, 'apps/control/dist/src/registry-adapter.js')).href);
const executorRegistry = new registryAdapter.HearthToExecutorRegistry(registry);
const allAuthorizedLights = snapshot.devices.filter((device) => device.load_type === 'light'
  && device.capabilities.includes('on-off') && device.allowed_actors.includes('admin'));

async function propose(item) {
  const request_id = `stage3-${mode}-${item.id}`;
  if (mode === 'grammar') {
    const result = await grammar.parse(item.utterance, request_id);
    return result.ok ? result.proposal : null;
  }
  if (mode === 'bonsai') {
    try {
      return await countedBonsai.propose({ request_id, utterance: item.utterance, context });
    } catch { return null; }
  }
  try {
    const decision = await interpreter.interpret(item.utterance, request_id);
    return decision.outcome === 'ready_for_contract' ? decision.proposal : null;
  } catch { return null; }
}

async function resolvePhrase(phrase, proposal) {
  if (phrase.trim().toLocaleLowerCase() === 'everything'
    && proposal.intent_family === 'set-state' && proposal.desired_values.on === false) {
    return allAuthorizedLights.map((device) => ({ canonical_id: device.canonical_id }));
  }
  return (await registry.resolve(phrase)).map((hit) => ({ canonical_id: hit.device.canonical_id }));
}

async function inspectAdmission(proposal, request_id) {
  if (!proposal) return null;
  try {
    const { contract } = await control.buildContract({
      actor: { actor_id: 'stage3-evaluator', role: 'admin', session_id: 'stage3-session' },
      request_id,
      idempotency_key: request_id,
      proposal,
      registry: executorRegistry,
      resolve_phrase: (phrase) => resolvePhrase(phrase, proposal),
      now: () => new Date('2026-09-27T12:00:00.000Z'),
      observed_state: async () => 1,
    });
    return contract;
  } catch {
    return null;
  }
}

function sorted(values = []) { return [...values].sort(); }
function sameValues(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
const byCategory = new Map();
const sampleFailures = [];
let supported = 0;
let exact = 0;
let wrongTarget = 0;
let unauthorized = 0;
let droppedExclusions = 0;
let admitted = 0;
let clarification = 0;
let elapsed = 0;
let peakRss = process.memoryUsage().rss;

for (const [index, item] of corpus.entries()) {
  const started = performance.now();
  const request_id = `stage3-${mode}-${item.id}`;
  const proposal = await propose(item);
  const contract = await inspectAdmission(proposal, request_id);
  const ms = performance.now() - started;
  elapsed += ms;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const targetIds = contract ? sorted(contract.targets.map((target) => target.canonical_id)) : [];
  const exclusionIds = [];
  if (proposal) {
    for (const phrase of proposal.exclusions ?? []) {
      try { exclusionIds.push(...(await resolvePhrase(phrase, proposal)).map((hit) => hit.canonical_id)); }
      catch { /* unresolved exclusion is measured as a dropped exclusion */ }
    }
  }
  const gotAdmission = contract !== null;
  if (gotAdmission) admitted++;
  if (item.expected.supported_unambiguous) supported++;
  if (!gotAdmission && item.expected.supported_unambiguous) clarification++;

  const targetExact = sameValues(targetIds, sorted(item.expected.targets ?? []));
  const familyExact = !item.expected.intent_family || proposal?.intent_family === item.expected.intent_family;
  const valuesExact = !item.expected.desired_values || sameValues(proposal?.desired_values ?? null, item.expected.desired_values);
  const exclusionsExact = sameValues(sorted(exclusionIds), sorted(item.expected.excluded_targets ?? []));
  const exactCase = item.expected.admit
    ? gotAdmission && targetExact && familyExact && valuesExact && exclusionsExact
    : !gotAdmission;

  if (item.expected.admit && gotAdmission && !targetExact) wrongTarget++;
  if (!item.expected.admit && gotAdmission) unauthorized++;
  if ((item.expected.excluded_targets ?? []).length > 0 && proposal && (!exclusionsExact || (contract && item.expected.excluded_targets.some((id) => Object.hasOwn(contract.per_target_evidence, id))))) {
    droppedExclusions++;
  }
  if (item.expected.supported_unambiguous && exactCase) exact++;

  const row = byCategory.get(item.category) ?? { count: 0, exact: 0, admitted: 0, wrong_target: 0, unauthorized: 0, dropped_exclusions: 0 };
  row.count++;
  if (exactCase) row.exact++;
  if (gotAdmission) row.admitted++;
  if (item.expected.admit && gotAdmission && !targetExact) row.wrong_target++;
  if (!item.expected.admit && gotAdmission) row.unauthorized++;
  if ((item.expected.excluded_targets ?? []).length > 0 && proposal && (!exclusionsExact || (contract && item.expected.excluded_targets.some((id) => Object.hasOwn(contract.per_target_evidence, id)))) ) row.dropped_exclusions++;
  byCategory.set(item.category, row);

  if (!exactCase && sampleFailures.length < 40) sampleFailures.push({ id: item.id, category: item.category, utterance: item.utterance, proposal: proposal ? { intent_family: proposal.intent_family, target_phrases: proposal.target_phrases, exclusions: proposal.exclusions, desired_values: proposal.desired_values } : null, admitted: gotAdmission, target_ids: targetIds });
  if ((index + 1) % 10 === 0) console.error(`[stage3:${mode}] ${index + 1}/${corpus.length}`);
}

const report = {
  schema_version: 1,
  evaluated_at: new Date().toISOString(),
  mode,
  corpus_cases: corpus.length,
  supported_unambiguous_cases: supported,
  exact_supported: exact,
  exact_supported_rate: supported === 0 ? null : exact / supported,
  wrong_target_admitted: wrongTarget,
  unauthorized_admitted: unauthorized,
  dropped_exclusions: droppedExclusions,
  admitted_total: admitted,
  clarification_supported: clarification,
  gliner2_invocations: glinerCalls,
  bonsai_invocations: bonsaiCalls,
  bonsai_invocation_rate: corpus.length === 0 ? null : bonsaiCalls / corpus.length,
  mean_latency_ms: Number((elapsed / corpus.length).toFixed(2)),
  peak_rss_bytes: peakRss,
  by_category: Object.fromEntries(byCategory),
  sample_failures: sampleFailures,
};
await mkdir(reportDir, { recursive: true });
const reportPath = resolve(reportDir, `stage3-${mode}-latest.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  mode: report.mode,
  cases: report.corpus_cases,
  supported: report.supported_unambiguous_cases,
  exact_supported_rate: report.exact_supported_rate,
  wrong_target_admitted: report.wrong_target_admitted,
  unauthorized_admitted: report.unauthorized_admitted,
  dropped_exclusions: report.dropped_exclusions,
  gliner2_invocations: report.gliner2_invocations,
  bonsai_invocations: report.bonsai_invocations,
  mean_latency_ms: report.mean_latency_ms,
  report: reportPath.replace(root + '/', ''),
}, null, 2));
