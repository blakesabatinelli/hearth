#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { LiveHAAdapter } from '../packages/ha-adapter/dist/src/index.js';
import { parseCsvRecords, preserveManualReview } from './device-review-csv.mjs';

const runtimeRoot = process.env.HEARTH_RUNTIME_ROOT
  ?? join(homedir(), 'Library', 'Application Support', 'Hearth');
const secretDir = process.env.HEARTH_SECRET_DIR ?? join(runtimeRoot, 'secrets');
const outputPath = process.env.HEARTH_DEVICE_REVIEW_PATH ?? join(runtimeRoot, 'device-review.csv');
const allowlistPath = process.env.HEARTH_ACTUATION_ALLOWLIST_PATH ?? join(secretDir, 'hearth-actuation-allowlist');
const baseUrl = process.env.HEARTH_HA_URL ?? 'http://127.0.0.1:8123';
const token = process.env.HEARTH_HA_TOKEN ?? (await readFile(join(secretDir, 'home-assistant-token'), 'utf8')).trim();
if (!token) throw new Error('Home Assistant token is empty');
const actuationAllowlist = new Set((process.env.HEARTH_HA_ACTUATION_ALLOWLIST ?? '')
  .split(',').map((entityId) => entityId.trim()).filter(Boolean));
if (actuationAllowlist.size === 0 && process.env.HEARTH_ALLOW_EMPTY_DEVICE_ALLOWLIST !== '1') {
  throw new Error('HEARTH_HA_ACTUATION_ALLOWLIST is empty; set it explicitly or set HEARTH_ALLOW_EMPTY_DEVICE_ALLOWLIST=1');
}
for (const entityId of actuationAllowlist) {
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entityId)) throw new Error('allowlist contains an invalid Home Assistant entity ID');
}

let previousReview = [];
try {
  previousReview = parseCsvRecords(await readFile(outputPath, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const adapter = new LiveHAAdapter({ base_url: baseUrl, token, actuation_allowlist: actuationAllowlist });
await adapter.probe();
const [devices, rooms] = await Promise.all([adapter.listDevices(), adapter.listRooms()]);
const roomNames = new Map(rooms.map((room) => [String(room.room_id), room.name]));
const nameCounts = new Map();
const physicalCounts = new Map();
for (const device of devices) {
  const name = device.friendly_name.trim().toLocaleLowerCase();
  nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  const route = device.provider_ids.find((id) => id.kind === 'ha');
  if (route?.kind === 'ha' && route.device_id) physicalCounts.set(route.device_id, (physicalCounts.get(route.device_id) ?? 0) + 1);
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = await fn(items[index]); }
      catch (error) { results[index] = error; }
    }
  }));
  return results;
}

const stateResults = await mapConcurrent(devices, 4, (device) => adapter.getState(device.canonical_id));
const columns = [
  'canonical_id', 'friendly_name', 'room', 'load_type', 'capabilities', 'aliases',
  'control_enabled', 'allowed_roles', 'ha_entity_id', 'ha_device_id', 'ha_device_name',
  'ha_integration', 'ha_unique_id', 'manufacturer', 'model', 'entity_category',
  'entities_on_same_ha_device', 'same_friendly_name_routes', 'state_values', 'state_observed_at',
  'physical_identity_verified', 'load_type_verified', 'route_verified', 'feedback_policy_verified', 'review_notes',
];

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

const rows = [columns];
for (const [index, device] of devices.entries()) {
  const route = device.provider_ids.find((id) => id.kind === 'ha');
  const state = stateResults[index];
  rows.push([
    device.canonical_id,
    device.friendly_name,
    device.room_id ? roomNames.get(String(device.room_id)) ?? '' : '',
    device.load_type,
    device.capabilities.join('|'),
    device.aliases.join('|'),
    device.allowed_actors.length > 0,
    device.allowed_actors.join('|'),
    route?.kind === 'ha' ? route.entity_id : '',
    route?.kind === 'ha' ? route.device_id ?? '' : '',
    route?.kind === 'ha' ? route.device_name ?? '' : '',
    route?.kind === 'ha' ? route.platform ?? '' : '',
    route?.kind === 'ha' ? route.unique_id ?? '' : '',
    route?.kind === 'ha' ? route.manufacturer ?? '' : '',
    route?.kind === 'ha' ? route.model ?? '' : '',
    route?.kind === 'ha' ? route.entity_category ?? '' : '',
    route?.kind === 'ha' && route.device_id ? physicalCounts.get(route.device_id) ?? 1 : 0,
    nameCounts.get(device.friendly_name.trim().toLocaleLowerCase()) ?? 1,
    state instanceof Error ? `unavailable: ${state.message}` : JSON.stringify(state.values),
    state instanceof Error ? '' : state.observed_at,
    '', '', '', '', '',
  ]);
}

preserveManualReview(columns, rows.slice(1), previousReview);

await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
await mkdir(secretDir, { recursive: true, mode: 0o700 });
await writeFile(outputPath, `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`, { mode: 0o600 });
await chmod(outputPath, 0o600);
await writeFile(allowlistPath, `${[...actuationAllowlist].join(',')}\n`, { mode: 0o600 });
await chmod(allowlistPath, 0o600);
console.log(`Wrote a private review sheet for ${devices.length} Home Assistant entities and persisted ${actuationAllowlist.size} enabled routes.`);
