/**
 * Adapter from `@hearth/registry` RegistryOverlay class to the
 * `@hearth/executor` RegistryOverlay interface.
 *
 * Two registries coexist:
 *  - `@hearth/registry` (class) - handles alias resolution, room grouping,
 *    edit application, snapshotting. Used by the API layer to resolve
 *    phrases from `IntentProposal.target_phrases` into canonical IDs.
 *  - `@hearth/executor` (interface) - what the executor depends on for
 *    device lookup, room lookup, scene scope, attestation. It's the
 *    minimal read-only surface.
 *
 * This adapter gives the executor a view backed by the richer hearth/registry
 * instance.
 */
import type {
  CanonicalId,
  DeviceRecord,
  Room,
  RoomId,
} from '@hearth/contracts';
import type {
  RegistryOverlay as ExecutorRegistryOverlay,
  SceneScopeRecord,
  SceneAttestationRecord,
} from '@hearth/executor';
import type { RegistryOverlay as HearthRegistryOverlay } from '@hearth/registry';

/**
 * Tracks scene scope + attestation records out-of-band, because the
 * `@hearth/registry` class doesn't own those (they're a contract-executor
 * concept: the scene's frozen target/value set + admin attestation).
 *
 * In a fuller implementation these would be persisted alongside the
 * registry; for now an in-process map is correct because all scene edits
 * happen through this server.
 */
export class HearthToExecutorRegistry implements ExecutorRegistryOverlay {
  private readonly hearth: HearthRegistryOverlay;
  private readonly scenes = new Map<string, SceneScopeRecord>();
  private readonly attestations = new Map<string, SceneAttestationRecord>();

  public constructor(hearth: HearthRegistryOverlay) {
    this.hearth = hearth;
  }

  public addSceneScope(scope: SceneScopeRecord): void {
    this.scenes.set(scope.scene_id, scope);
  }

  public addSceneAttestation(att: SceneAttestationRecord): void {
    this.attestations.set(att.scene_id, att);
  }

  public getDevice(canonical_id: CanonicalId): DeviceRecord | null {
    return this.hearth.device(canonical_id);
  }

  public getRoom(room_id: RoomId): Room | null {
    for (const r of this.hearth.rooms()) {
      if (r.room_id === room_id) return r;
    }
    return null;
  }

  public getSceneScope(scene_id: string): SceneScopeRecord | null {
    return this.scenes.get(scene_id) ?? null;
  }

  public getSceneAttestation(scene_id: string): SceneAttestationRecord | null {
    return this.attestations.get(scene_id) ?? null;
  }

  public listDevices(): ReadonlyArray<DeviceRecord> {
    const snap = this.hearth.snapshot();
    return snap.devices;
  }
}