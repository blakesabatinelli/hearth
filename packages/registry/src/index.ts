/**
 * @hearth/registry
 *
 * The Hearth canonical device/room/scene registry overlay. Plan
 * section 6: Hearth maintains only the alias/identity/permission/route
 * overlay on top of Home Assistant metadata. HA is the metadata
 * source for its entities; Hearth adds cross-provider identity
 * mapping, conceptual groups, scoped scenes, and route preferences.
 *
 * The overlay is *versioned*. Every edit increments the affected
 * record's `version`. Contracts pin a specific `entity_version` so
 * they re-validate against current state at dispatch (plan section 8
 * "Validate versions again at dispatch to avoid target changes
 * between preview and execution").
 */

import type {
  CanonicalId,
  DeviceRecord,
  LoadType,
  Room,
  RoomId,
  ProviderId,
  ActorRole,
} from '@hearth/contracts';

// =============================================================================
// Resolution
// =============================================================================

export type Resolution = {
  readonly device: DeviceRecord;
  /** Other provider IDs that map to the same canonical device. */
  readonly aliases_provider_ids: ReadonlyArray<ProviderId>;
  /** How the match was made (informational; never trust for authority). */
  readonly matched_via: 'exact-id' | 'alias' | 'friendly_name' | 'room' | 'unknown';
};

/**
 * Resolves a free-form phrase (e.g. "the lamp in the living room") to
 * one or more canonical devices. If exactly one match, returns it. If
 * multiple matches, returns all candidates so the caller can prompt
 * for clarification. If no match, returns empty array.
 */
export type Resolver = (phrase: string) => Promise<ReadonlyArray<Resolution>>;

/**
 * Returns all canonical devices whose `allowed_actors` includes the
 * given actor role. Source-of-truth for "is this user allowed to talk to
 * this device" server-side.
 */
export type PermissionGate = (canonical_id: CanonicalId, actor_role: string) => Promise<boolean>;

// =============================================================================
// Registry overlay (in-memory; tests + fixture mode)
// =============================================================================

/**
 * The overlay state. HA-side metadata is imported elsewhere; this
 * keeps only Hearth's per-installation add-ons (aliases, allowlists,
 * route preferences, custom scenes).
 */
export type RegistryOverlayState = {
  readonly devices: ReadonlyArray<DeviceRecord>;
  readonly rooms: ReadonlyArray<Room>;
  readonly entity_version: number;       // bumped on every edit
  readonly scene_versions: Readonly<Record<string, number>>;
};

export class RegistryOverlay {
  private state: RegistryOverlayState;

  constructor(initial: RegistryOverlayState) {
    this.state = initial;
  }

  snapshot(): RegistryOverlayState {
    return this.state;
  }

  entityVersion(): number {
    return this.state.entity_version;
  }

  sceneVersion(scene_id: string): number | null {
    const v = this.state.scene_versions[scene_id];
    return v ?? null;
  }

  device(canonical_id: CanonicalId): DeviceRecord | null {
    return this.state.devices.find((d) => d.canonical_id === canonical_id) ?? null;
  }

  devicesByRoom(room_id: RoomId): ReadonlyArray<DeviceRecord> {
    return this.state.devices.filter((d) => d.room_id === room_id);
  }

  rooms(): ReadonlyArray<Room> {
    return this.state.rooms;
  }

  /**
   * Resolve a phrase to candidate canonical devices. Used by the
   * grammar parser and by GLiNER2/Bonsai fallback paths.
   *
   * The match priority (most specific first):
   *   1. Exact canonical ID
   *   2. Exact alias
   *   3. Friendly-name exact match
   *   4. Friendly-name substring (case-insensitive, word-boundary)
   *   5. Room name match (returns all devices in that room)
   *   6. Empty if nothing matches
   */
  async resolve(phrase: string): Promise<ReadonlyArray<Resolution>> {
    const normalized = phrase.trim().toLowerCase();
    if (!normalized) return [];
    const out: Resolution[] = [];
    const seen = new Set<string>();

    for (const d of this.state.devices) {
      const idMatch = d.canonical_id === phrase;
      const aliasMatch = d.aliases.some((a) => a.toLowerCase() === normalized);
      const friendlyExact = d.friendly_name.toLowerCase() === normalized;
      const friendlySubstring = wordBoundaryContains(d.friendly_name.toLowerCase(), normalized);

      if (idMatch || aliasMatch || friendlyExact || friendlySubstring) {
        const key = String(d.canonical_id);
        if (!seen.has(key)) {
          seen.add(key);
          out.push({
            device: d,
            aliases_provider_ids: d.provider_ids,
            matched_via: idMatch
              ? 'exact-id'
              : aliasMatch
                ? 'alias'
                : friendlyExact
                  ? 'friendly_name'
                  : 'friendly_name',
          });
        }
      }
    }

    // Room-name matches: append devices in that room, but only if
    // nothing was found by name/alias (room matches are noisier).
    if (out.length === 0) {
      const matchingRoom = this.state.rooms.find((r) => r.name.toLowerCase() === normalized);
      if (matchingRoom) {
        for (const d of this.devicesByRoom(matchingRoom.room_id)) {
          const key = String(d.canonical_id);
          if (!seen.has(key)) {
            seen.add(key);
            out.push({
              device: d,
              aliases_provider_ids: d.provider_ids,
              matched_via: 'room',
            });
          }
        }
      }
    }

    return out;
  }

  async allowed(canonical_id: CanonicalId, actor_role: string): Promise<boolean> {
    const d = this.device(canonical_id);
    if (!d) return false;
    // Admin always has access; otherwise the device's allowed_actors
    // must explicitly list the actor's role.
    if (actor_role === 'admin') return true;
    return d.allowed_actors.includes(actor_role as ActorRole);
  }

  /**
   * Apply an edit (used by future admin API; placeholder so the
   * overlay has an explicit mutation surface that bumps versions).
   */
  applyEdit(next: RegistryOverlayState): void {
    if (next.entity_version <= this.state.entity_version) {
      throw new Error(
        `registry overlay edit must bump entity_version (current ${this.state.entity_version}, next ${next.entity_version})`,
      );
    }
    this.state = next;
  }

  /** Loads a default empty overlay (used by tests / fresh installs). */
  static empty(): RegistryOverlay {
    return new RegistryOverlay({
      devices: [],
      rooms: [],
      entity_version: 1,
      scene_versions: {},
    });
  }
}

// =============================================================================
// Helpers
// =============================================================================

function wordBoundaryContains(haystack: string, needle: string): boolean {
  if (needle.length < 3) return false; // avoid noise on tiny tokens
  const tokens = haystack.split(/[\s,]+/);
  return tokens.some((t) => t === needle);
}

/**
 * Detect devices that share provider IDs (two HA entities pointing to
 * the same canonical device, or two routes to one physical load).
 * Plan section 6: duplicate physical identity does not block but
 * raises a flag for the admin to disambiguate.
 */
export function findDuplicateProviderIds(
  state: RegistryOverlayState,
): ReadonlyArray<{ readonly provider_id: ProviderId; readonly canonical_ids: ReadonlyArray<CanonicalId> }> {
  const map = new Map<string, { pid: ProviderId; ids: Set<CanonicalId> }>();
  for (const d of state.devices) {
    for (const pid of d.provider_ids) {
      const key = `${pid.kind}::${'entity_id' in pid ? pid.entity_id : ('hue_id' in pid ? pid.hue_id : ('device_id' in pid ? pid.device_id : ('topic' in pid ? pid.topic : pid.node_id)))}`;
      const entry = map.get(key) ?? { pid, ids: new Set() };
      entry.ids.add(d.canonical_id);
      map.set(key, entry);
    }
  }
  const out: { provider_id: ProviderId; canonical_ids: ReadonlyArray<CanonicalId> }[] = [];
  for (const { pid, ids } of map.values()) {
    if (ids.size > 1) out.push({ provider_id: pid, canonical_ids: [...ids] });
  }
  return out;
}

/** Find devices whose load_type is not yet classified (plan section 3 Deferred). */
export function findUnclassifiedLoads(
  state: RegistryOverlayState,
): ReadonlyArray<{ readonly canonical_id: CanonicalId; readonly load_type: LoadType }> {
  return state.devices
    .filter((d) => d.load_type === 'unknown-switch')
    .map((d) => ({ canonical_id: d.canonical_id, load_type: d.load_type }));
}