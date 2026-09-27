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
import type { DirectControlResponse, HearthApi } from '../src/api';

function makeApi(overrides: Partial<{
  listDevices: () => Promise<unknown>;
  getDeviceState: (id: string) => Promise<unknown>;
  controlDevice: (id: string, on: boolean) => Promise<unknown>;
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
          control_enabled: true,
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
    controlDevice: overrides.controlDevice ?? (async () => ({ contract_id: 'c1', receipt: { aggregate: 'confirmed' } } as DirectControlResponse)),
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
    expect(screen.getAllByText('Kitchen').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Unassigned').length).toBeGreaterThan(0);
  });

  it('explains when live Home Assistant has no supported devices', async () => {
    const api = makeApi({ listDevices: async () => ({ devices: [], rooms: [], actor: { actor_id: 'a', role: 'member' } }) });
    render(<Home api={api} />);
    expect((await screen.findByRole('status')).textContent).toMatch(/no supported devices were found/i);
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

  it('runs an enabled light action through the API and reports executor confirmation', async () => {
    const controlDevice = vi.fn(async () => ({ contract_id: 'c1', receipt: { aggregate: 'confirmed' } }));
    const api = makeApi({ controlDevice });
    render(<Home api={api} />);
    const toggle = await screen.findByRole('button', { name: 'Turn off Kitchen Lamp' });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(controlDevice).toHaveBeenCalledWith('lamp.kitchen', false);
      expect(screen.getByTestId('control-result-lamp.kitchen').textContent).toBe('Confirmed by Home Assistant.');
    });
  });

  it('does not replay a tap after a network failure and requires a fresh state before retry', async () => {
    const controlDevice = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const api = makeApi({ controlDevice });
    render(<Home api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off Kitchen Lamp' }));

    expect(await screen.findByText(/tap was not retried; refresh device state before retrying/i)).toBeTruthy();
    expect(controlDevice).toHaveBeenCalledTimes(1);
    const unavailableToggle = screen.getByRole('button', { name: 'Turn on Kitchen Lamp' });
    expect((unavailableToggle as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('device-lamp.kitchen'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Turn off Kitchen Lamp' }) as HTMLButtonElement).disabled).toBe(false));
    expect(controlDevice).toHaveBeenCalledTimes(1);
  });

  it('does not offer direct controls for discovery-only devices', async () => {
    const api = makeApi();
    render(<Home api={api} />);
    await screen.findByText('Bedroom Fan');
    expect(screen.queryByTestId('control-fan.bedroom')).toBeNull();
  });

  it('renders an error if /v1/devices fails', async () => {
    const api = makeApi({
      listDevices: async () => { throw new Error('boom'); },
    });
    render(<Home api={api} />);
    await waitFor(() => {
      expect(screen.getByText(/could not load Home Assistant devices: boom/i)).toBeTruthy();
    });
  });
});
