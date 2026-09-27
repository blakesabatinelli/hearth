import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { History } from '../src/screens/History';
import { Routines } from '../src/screens/Routines';
import { Devices } from '../src/screens/Devices';
import { Attention } from '../src/screens/Attention';
import { Home } from '../src/screens/Home';
import type { HearthApi } from '../src/api';

const devicesResponse = {
  devices: [
    { canonical_id: 'ha:light.lamp', friendly_name: 'Bedroom Lamp', load_type: 'light', capabilities: ['on-off'], aliases: ['bedroom lamp'], room_id: 'area.bedroom', control_enabled: true, provider_ids: [{ kind: 'ha', entity_id: 'light.lamp', device_id: 'ha-device-bedroom', platform: 'hue', manufacturer: 'Philips', model: 'Hue Bridge' }], allowed_actors: ['admin'] },
    { canonical_id: 'ha:switch.unknown', friendly_name: 'Mystery Switch', load_type: 'unknown-switch', capabilities: ['on-off'], aliases: ['mystery switch'], room_id: null, control_enabled: false, provider_ids: [{ kind: 'ha', entity_id: 'switch.unknown' }], allowed_actors: [] },
    { canonical_id: 'ha:light.lamp2', friendly_name: 'Bedroom Lamp', load_type: 'light', capabilities: ['on-off'], aliases: [], room_id: 'area.office', control_enabled: false, provider_ids: [{ kind: 'ha', entity_id: 'light.lamp2', device_id: 'ha-device-other', platform: 'smartthings', manufacturer: 'SmartThings', model: 'Bulb' }], allowed_actors: [] },
  ],
  rooms: [{ room_id: 'area.bedroom', name: 'Bedroom' }, { room_id: 'area.office', name: 'Office' }],
  actor: { actor_id: 'a', role: 'admin' },
};

function makeApi(overrides: Record<string, unknown> = {}): HearthApi {
  return {
    listDevices: vi.fn(async () => devicesResponse),
    getDeviceState: vi.fn(async (id: string) => ({ state: { canonical_id: id, observed_at: new Date().toISOString(), source: 'fresh-poll', values: { on: true }, state_version: 1 } })),
    listReceipts: vi.fn(async () => []),
    listRoutines: vi.fn(async () => []),
    createRoutine: vi.fn(async (value) => ({ routine_id: 'r1', name: value.name, cron: '0 8 * * *', time_zone: value.time_zone, intent_family: 'set-state', target_phrases: [value.target_canonical_id], desired_values: { on: value.on }, exclusions: [], enabled: true, recent_fires: [] })),
    setRoutineEnabled: vi.fn(async () => {}),
    deleteRoutine: vi.fn(async () => {}),
    ...overrides,
  } as unknown as HearthApi;
}

describe('iPad household screens', () => {
  it('saves a favorite locally and shows it in the favorites collection', async () => {
    localStorage.clear();
    const api = makeApi();
    const view = render(<Home api={api} title="Rooms" />);
    await screen.findAllByText('Bedroom Lamp');
    fireEvent.click(screen.getAllByRole('button', { name: 'Add Bedroom Lamp to favorites' })[0]!);
    expect(localStorage.getItem('hearth.favorite_device_ids')).toContain('ha:light.lamp');
    view.unmount();
    render(<Home api={api} title="Favorites" favoritesOnly />);
    expect(await screen.findByText('Bedroom Lamp')).toBeTruthy();
    expect(screen.queryByText('Mystery Switch')).toBeNull();
  });

  it('creates a local-time routine only for a controllable light', async () => {
    const api = makeApi();
    render(<Routines api={api} />);
    fireEvent.change(await screen.findByLabelText('Routine name'), { target: { value: 'Wake up' } });
    fireEvent.change(screen.getByLabelText('Every day at'), { target: { value: '08:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save routine' }));
    await waitFor(() => expect(api.createRoutine).toHaveBeenCalledTimes(1));
    expect(api.createRoutine).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Wake up', time_local: '08:30', target_canonical_id: 'ha:light.lamp',
    }));
    expect((api.createRoutine as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].time_zone).toBeTruthy();
  });

  it('renders persisted executor receipts with friendly device names', async () => {
    const api = makeApi({ listReceipts: vi.fn(async () => [{
      receipt_id: 'receipt-1', contract_id: 'contract-1', actor: { actor_id: 'admin-1', role: 'admin' },
      aggregate: 'no-op', created_at: '2026-09-27T12:00:00.000Z',
      per_target: { 'ha:light.lamp': { kind: 'already-satisfied' } },
    }]) });
    render(<History api={api} />);
    expect(await screen.findByText('Already in that state')).toBeTruthy();
    expect(screen.getByText('Bedroom Lamp')).toBeTruthy();
    expect(screen.getByText('Already satisfied, no device call')).toBeTruthy();
  });

  it('shows route collisions and unclassified loads in Attention', async () => {
    render(<Attention api={makeApi()} />);
    expect(await screen.findByText('Names with more than one route')).toBeTruthy();
    expect(screen.getByText('Identify the connected load and its physical location.')).toBeTruthy();
    expect(screen.getByText(/HA device ha-device-bedroom/)).toBeTruthy();
    expect(screen.getByText(/HA device ha-device-other/)).toBeTruthy();
    expect(screen.getByText('Read-only devices')).toBeTruthy();
  });

  it('shows the exact Home Assistant route on the device inventory page', async () => {
    render(<Devices api={makeApi()} />);
    expect(await screen.findByText('Devices')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Identity and access')[0]!);
    expect(screen.getByText('light.lamp')).toBeTruthy();
    expect(screen.getByText('ha-device-bedroom')).toBeTruthy();
    expect(screen.getByText('hue')).toBeTruthy();
    expect(screen.getByText('Philips Hue Bridge')).toBeTruthy();
  });
});
