/**
 * @hearth/ha-adapter
 *
 * Fake-HA adapter for Hearth. In-memory only: no network, no client
 * library, no credentials. Real HA is a future config switch, not a code
 * change (plan section 13 Stage 1 gate).
 *
 * Exports the fake-HA adapter, a connection pool that wires only the fake
 * today, and the default synthetic household fixture used by tests and
 * demo mode.
 */

export {
  FakeHAAdapter,
  HAConnectionPool,
  loadDefaultFixture,
  type FakeHADispatchAck,
  type FixtureSeed,
  type ProviderKey,
} from './adapter.js';
