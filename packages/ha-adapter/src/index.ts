/**
 * @hearth/ha-adapter
 *
 * Home Assistant adapter for Hearth. Two surfaces:
 *   - FakeHAAdapter / HAConnectionPool / loadDefaultFixture: the
 *     in-memory synthetic fixture used by tests and demo mode.
 *   - LiveHAAdapter: the real Home Assistant REST + WebSocket adapter
 *     for live deployment. Activated by HEARTH_FIXTURE_MODE=0 in
 *     apps/control/src/main.ts.
 *
 * Both implement HomeAssistantAdapter from @hearth/contracts.
 */

export {
  FakeHAAdapter,
  HAConnectionPool,
  loadDefaultFixture,
  type FixtureSeed,
  type ProviderKey,
} from './adapter.js';

export { LiveHAAdapter, type LiveHAOptions } from './live.js';
