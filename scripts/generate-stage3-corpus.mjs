#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'eval/commands/stage3-corpus.jsonl');
const lights = [
  { id: 'dev-living-room-lamp', aliases: ['living room lamp', 'main lamp'] },
  { id: 'dev-kitchen-lights', aliases: ['kitchen lights', 'main lights'] },
  { id: 'dev-bedroom-overhead', aliases: ['bedroom overhead', 'overhead'] },
];
const devices = [
  ...lights,
  { id: 'dev-bedroom-fan', aliases: ['bedroom fan', 'the fan'] },
];
const cases = [];
function add(category, utterance, expected) {
  cases.push({
    id: `stage3-${String(cases.length + 1).padStart(3, '0')}`,
    category,
    utterance,
    expected: { supported_unambiguous: false, admit: false, ...expected },
  });
}

for (const device of devices) {
  for (const on of [true, false]) {
    const verb = on ? 'on' : 'off';
    for (const alias of device.aliases) {
      for (const make of [
        (target) => `turn ${verb} ${target}`,
        (target) => `switch ${verb} ${target}`,
        (target) => `turn ${target} ${verb}`,
        (target) => `switch ${target} ${verb}`,
        (target) => `${target} ${verb}`,
      ]) {
        add('set-state', make(alias), {
          supported_unambiguous: true, admit: true, intent_family: 'set-state',
          targets: [device.id], desired_values: { on }, excluded_targets: [],
        });
      }
    }
  }
}

for (const device of lights) {
  for (const brightness of [10, 25, 40, 65, 90]) {
    add('brightness-absolute', `set ${device.aliases[0]} to ${brightness} percent`, {
      supported_unambiguous: true, admit: true, intent_family: 'set-brightness-absolute',
      targets: [device.id], desired_values: { brightness }, excluded_targets: [],
    });
    add('brightness-absolute', `${device.aliases[1]} at ${brightness}%`, {
      supported_unambiguous: true, admit: true, intent_family: 'set-brightness-absolute',
      targets: [device.id], desired_values: { brightness }, excluded_targets: [],
    });
  }
}

const relative = [];
for (const device of lights) {
  for (const amount of [5, 10, 15, 20]) {
    relative.push({ utterance: `dim ${device.aliases[0]} by ${amount}%`, device, delta: -amount });
    relative.push({ utterance: `brighten ${device.aliases[1]} by ${amount} percent`, device, delta: amount });
  }
}
for (const item of relative.slice(0, 20)) {
  add('brightness-relative', item.utterance, {
    supported_unambiguous: true, admit: true, intent_family: 'set-brightness-relative',
    targets: [item.device.id], desired_values: { brightness_delta: item.delta }, excluded_targets: [],
  });
}

const exclusionForms = [
  (target) => `turn off everything except ${target}`,
  (target) => `all off except ${target}`,
  (target) => `everything off except ${target}`,
  (target) => `turn off everything except the ${target}`,
  (target) => `all off except the ${target}`,
];
for (let i = 0; i < 20; i++) {
  const excluded = lights[i % lights.length];
  const alias = excluded.aliases[Math.floor(i / lights.length) % excluded.aliases.length];
  add('single-exclusion', exclusionForms[i % exclusionForms.length](alias), {
    supported_unambiguous: true, admit: true, intent_family: 'set-state',
    targets: lights.filter((device) => device.id !== excluded.id).map((device) => device.id).sort(),
    desired_values: { on: false }, excluded_targets: [excluded.id],
  });
}

for (let i = 0; i < 8; i++) {
  const alias = ['mystery switch', 'the mystery switch'][i % 2];
  add('unclassified-load', `${i % 2 ? 'switch off' : 'turn on'} ${alias}`, {
    reason: 'unclassified load must never be admitted', targets: ['dev-unknown-switch'],
  });
}
for (let i = 0; i < 8; i++) {
  const first = lights[i % lights.length];
  const second = lights[(i + 1) % lights.length];
  const a = first.aliases[i % 2];
  const b = second.aliases[(i + 1) % 2];
  add('compound-action', `turn on ${a} and turn off ${b}`, {
    reason: 'multiple actions must not be reduced to one action', targets: [first.id, second.id].sort(),
  });
}
for (let i = 0; i < 8; i++) {
  const first = lights[i % lights.length];
  const second = lights[(i + 1) % lights.length];
  const lead = ['turn off everything except', 'all off except'][i % 2];
  add('multiple-exclusions', `${lead} ${first.aliases[i % 2]} and ${second.aliases[(i + 1) % 2]}`, {
    reason: 'both exclusions must be honored or the request must be rejected',
    targets: lights.map((device) => device.id).sort(), excluded_targets: [first.id, second.id].sort(),
  });
}
for (let i = 0; i < 8; i++) {
  const typo = ['kitchin lite', 'bedrom overhed', 'livng room lamp', 'the dinner room light'][i % 4];
  add('speech-or-unknown-target', `${i % 2 ? 'switch off' : 'turn on'} ${typo}`, {
    reason: 'speech errors and unknown target phrases must not be guessed into a command', targets: [],
  });
}
for (const utterance of [
  'turn on the light', 'turn off all the lights', 'turn on the lamps', 'switch the lights on',
  'turn off the bedroom lights', 'make the lights brighter', 'turn on the room lights', 'switch off all lamps',
]) add('ambiguous-target', utterance, {
  reason: 'target is ambiguous or expands beyond a verified room scope', targets: [],
});
for (const utterance of [
  'unlock the front door', 'turn on the kitchen movie scene', 'run the evening routine',
  'turn on the living room lamp until sunrise', 'turn on the bedroom fan and dim it',
  'turn off the kitchen lights every weekday at seven', 'turn on the bedroom overhead, but not the fan',
  'turn off everything except the bedroom fan', 'set the kitchen lights to party mode', 'make the mystery switch brighter',
]) add('unsupported-or-policy-boundary', utterance, {
  reason: 'unsupported semantics require clarification and must not reach actuation', targets: [],
});

if (cases.length !== 200) throw new Error(`Stage 3 corpus must contain 200 cases, got ${cases.length}`);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, cases.map((item) => JSON.stringify(item)).join('\n') + '\n');
console.log(`Wrote ${cases.length} synthetic Stage 3 cases to ${output}`);
