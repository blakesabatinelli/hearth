/**
 * Home screen test.
 *
 * Renders the Home component with a mock api, asserts it shows devices
 * fetched from GET /v1/devices. We also exercise the "click device"
 * path to make sure the state panel opens.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Home } from '../src/screens/Home';
import type { HearthApi } from '../src/api';

function makeApi(overrides: Partial<{
  listDevices: () => Promise<unknown>;
  getDeviceState: (id: string) => Promise<unknown>;
}> = {}): HearthApi {
  return {
    listDevices: overrides.listDevices ?? (async () => ({
      devices: [
        {
          canonical_id: 'lamp.kitchen',
          friendly_name: 'Kitchen Lamp',
          load_type: 'light',
          capabilities: ['on', 'off'],
          aliases: ['kitchen light'],
          room_id: 'room.kitchen',
        },
        {
          canonical_id: 'fan.bedroom',
          friendly_name: 'Bedroom Fan',
          load_type: 'fan',
          capabilities: ['on', 'off'],
          aliases: [],
          room_id: null,
        },
      ],
      rooms: [{ room_id: 'room.kitchen', name: 'Kitchen' }],
      actor: { actor_id: 'a', role: 'admin' },
    })),
    getDeviceState: overrides.getDeviceState ?? (async (id: string) => ({
      state: {
        canonical_id: id,
        observed_at: '2026-09-24T00:00:00.000Z',
        source: 'cached',
        values: { on: true },
        state_version: 1,
      },
    })),
  } as unknown as HearthApi;
}

describe('Home screen', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('renders devices grouped by room from /v1/devices', async () => {
    const api = makeApi();
    render(<Home api={api} />);
    await waitFor(() => {
      expect(screen.getByText('Kitchen Lamp')).toBeTruthy();
    });
    expect(screen.getByText('Bedroom Fan')).toBeTruthy();
    expect(screen.getByText('Kitchen')).toBeTruthy();
    expect(screen.getByText('Unassigned')).toBeTruthy();
  });

  it('shows device state when a device is clicked', async () => {
    const api = makeApi();
    render(<Home api={api} />);
    await waitFor(() => {
      expect(screen.getByText('Kitchen Lamp')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('device-lamp.kitchen'));
    await waitFor(() => {
      const pre = screen.getByTestId('device-state-json');
      expect(pre.textContent).toContain('lamp.kitchen');
      expect(pre.textContent).toContain('"on": true');
    });
  });

  it('renders an error if /v1/devices fails', async () => {
    const api = makeApi({
      listDevices: async () => { throw new Error('boom'); },
    });
    render(<Home api={api} />);
    await waitFor(() => {
      expect(screen.getByText(/failed to load devices: boom/i)).toBeTruthy();
    });
  });
});
