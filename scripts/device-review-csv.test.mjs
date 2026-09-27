import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCsvRecords, preserveManualReview } from './device-review-csv.mjs';

test('parses escaped quotes, commas, and line breaks in quoted fields', () => {
  assert.deepEqual(parseCsvRecords('ha_entity_id,review_notes\n"light.a","lamp, said ""ready""\nverified"\n'), [
    ['ha_entity_id', 'review_notes'],
    ['light.a', 'lamp, said "ready"\nverified'],
  ]);
});

test('keeps human verification and notes by HA entity ID across refreshed inventory rows', () => {
  const columns = ['ha_entity_id', 'physical_identity_verified', 'load_type_verified', 'review_notes', 'state_values'];
  const prior = parseCsvRecords([
    'ha_entity_id,physical_identity_verified,load_type_verified,review_notes,state_values',
    'light.a,true,true,"same physical lamp, route checked",{"on":true}',
  ].join('\n'));
  const current = [
    ['light.a', '', '', '', '{"on":false}'],
    ['light.b', '', '', '', '{"on":true}'],
  ];

  preserveManualReview(columns, current, prior);
  assert.deepEqual(current[0], ['light.a', 'true', 'true', 'same physical lamp, route checked', '{"on":false}']);
  assert.deepEqual(current[1], ['light.b', '', '', '', '{"on":true}']);
});

test('rejects malformed existing review sheets instead of discarding annotations', () => {
  assert.throws(() => parseCsvRecords('ha_entity_id,review_notes\n"light.a,unfinished'), /unterminated quoted CSV field/);
});
