/**
 * Build the ExtractionSchema fed to GLiNER2. The schema is derived from
 * the registry + the supported command categories. Plan section 7 and
 * ADR-2026-09-24-gliner2-required.
 *
 * Schema-driven extraction is what makes GLiNER2 fast and accurate:
 * passing a tight schema constrains the model to the command types Hearth
 * actually supports, with the device alias list as known_aliases.
 */

import type {
  CanonicalId,
  DeviceRecord,
  ExtractionEntityType,
  ExtractionLabel,
  ExtractionRelation,
  ExtractionSchema,
} from '@hearth/contracts';
import type { GrammarRegistry } from './grammar.js';

export function buildExtractionSchema(
  registry: GrammarRegistry,
  opts: { readonly schema_version?: string } = {},
): ExtractionSchema {
  const state = registry.snapshot?.() ?? null;
  const devices: ReadonlyArray<DeviceRecord> = state ? state.devices : [];
  const known_aliases = devices.map((d: DeviceRecord) => ({
    canonical_id: d.canonical_id as CanonicalId,
    aliases: [d.friendly_name, ...d.aliases],
  }));

  const entity_types: ReadonlyArray<ExtractionEntityType> = [
    'device_target',
    'room',
    'group',
    'exclusion',
    'time_expression',
    'value_expression',
  ];

  const classification_labels: ReadonlyArray<ExtractionLabel> = [
    'on',
    'off',
    'set_brightness',
    'dim_by',
    'set_scene',
    'hold_until',
    'routine_trigger',
    'query_state',
  ];

  const relations: ReadonlyArray<ExtractionRelation> = [
    { kind: 'target_of', from: 'device_target', to: 'device_target' },
    { kind: 'modifies', from: 'set_brightness', to: 'value_expression' },
    { kind: 'modifies', from: 'dim_by', to: 'value_expression' },
    { kind: 'modifies', from: 'hold_until', to: 'time_expression' },
  ];

  return {
    schema_version: opts.schema_version ?? '1',
    entity_types,
    classification_labels,
    relations,
    known_aliases,
  };
}