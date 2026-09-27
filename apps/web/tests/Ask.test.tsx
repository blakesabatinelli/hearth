/**
 * Ask screen test.
 *
 * Verifies that submitting the form POSTs /v1/interpret and renders a
 * readable decision summary. Also verifies that a failure surfaces inline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Ask } from '../src/screens/Ask';
import type { HearthApi } from '../src/api';

function makeApi(opts: {
  interpret?: () => Promise<unknown>;
} = {}): HearthApi {
  return {
    interpret: opts.interpret ?? (async () => ({
      request_id: 'req-1',
      decision: {
        outcome: 'ready_for_contract',
        proposal: {
          request_id: 'req-1',
          intent_family: 'set-state',
          target_phrases: ['lamp'],
          exclusions: [],
          desired_values: { on: true },
          temporal: null,
          unresolved_fields: [],
          confidence: 1.0,
          provenance: { source: 'grammar', matched_rule: 'turn-on' },
        },
      },
      actor: { actor_id: 'a', role: 'admin' },
    })),
  } as unknown as HearthApi;
}

describe('Ask screen', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('submits the form and renders a readable routing summary without raw session data', async () => {
    const interpret = vi.fn(async (_u: string) => ({
      request_id: 'req-1',
      decision: {
        outcome: 'ready_for_contract',
        proposal: {
          request_id: 'req-1',
          intent_family: 'set-state',
          target_phrases: ['lamp'],
          exclusions: [],
          desired_values: { on: true },
          temporal: null,
          unresolved_fields: [],
          confidence: 1.0,
          provenance: { source: 'grammar', matched_rule: 'turn-on' },
        },
      },
      actor: { actor_id: 'a', role: 'admin' },
    } as unknown));
    const api = makeApi({ interpret: interpret as unknown as () => Promise<unknown> });
    render(<Ask api={api} />);

    const input = screen.getByTestId('ask-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'turn on the lamp' } });
    fireEvent.click(screen.getByTestId('ask-submit'));

    await waitFor(() => {
      expect(screen.getByText('Decision method: grammar')).toBeTruthy();
      expect(screen.getByText('Turn on lamp')).toBeTruthy();
    });
    expect(screen.queryByTestId('ask-decision-json')).toBeNull();
    expect(interpret).toHaveBeenCalledTimes(1);
    expect(interpret.mock.calls[0]?.[0]).toBe('turn on the lamp');
  });

  it('submits a ready signed action to the executor after one Run with Hearth click', async () => {
    const proposal = {
      request_id: 'req-execute',
      intent_family: 'set-state',
      target_phrases: ['Living Room Lamp'],
      exclusions: [],
      desired_values: { on: true },
      temporal: null,
      unresolved_fields: [],
      confidence: 0.95,
      provenance: { source: 'grammar', matched_rule: 'turn-on' },
    };
    const executeProposal = vi.fn(async () => ({ contract_id: 'contract-1', receipt: { aggregate: 'confirmed' } }));
    const api = {
      interpret: async () => ({
        request_id: 'req-execute',
        decision: { outcome: 'ready_for_contract', proposal, proposal_receipt: 'server-signed-receipt' },
        actor: { actor_id: 'a', role: 'member' },
      }),
      executeProposal,
    } as unknown as HearthApi;
    render(<Ask api={api} />);
    fireEvent.change(screen.getByTestId('ask-input'), { target: { value: 'turn on the lamp' } });
    fireEvent.click(screen.getByTestId('ask-submit'));
    await waitFor(() => expect(executeProposal).toHaveBeenCalledWith('req-execute', proposal, 'server-signed-receipt'));
    expect(await screen.findByText('Home Assistant confirmed the requested state.')).toBeTruthy();
    expect(screen.queryByText(/contract-1/)).toBeNull();
    expect(screen.getByTestId('ask-submit').textContent).toBe('run with Hearth');
  });

  it('explains when the requested device state was already satisfied', async () => {
    const proposal = {
      request_id: 'req-already-on',
      intent_family: 'set-state',
      target_phrases: ['lamp'],
      exclusions: [],
      desired_values: { on: true },
      temporal: null,
      unresolved_fields: [],
      confidence: 1,
      provenance: { source: 'grammar', matched_rule: 'turn-on' },
    };
    const api = {
      interpret: async () => ({
        request_id: 'req-already-on',
        decision: { outcome: 'ready_for_contract', proposal, proposal_receipt: 'server-signed-receipt' },
        actor: { actor_id: 'a', role: 'admin' },
      }),
      executeProposal: async () => ({ contract_id: 'contract-no-op', receipt: { aggregate: 'no-op' } }),
    } as unknown as HearthApi;
    render(<Ask api={api} />);
    fireEvent.change(screen.getByTestId('ask-input'), { target: { value: 'turn on the lamp' } });
    fireEvent.click(screen.getByTestId('ask-submit'));

    expect(await screen.findByText('Already in the requested state. No device command was needed.')).toBeTruthy();
  });

  it('does not submit a ready proposal without a server receipt', async () => {
    const executeProposal = vi.fn();
    const api = {
      interpret: async () => ({
        request_id: 'req-unreceipted',
        decision: {
          outcome: 'ready_for_contract',
          proposal: { intent_family: 'set-state', target_phrases: ['lamp'], desired_values: { on: true } },
        },
        actor: { actor_id: 'a', role: 'admin' },
      }),
      executeProposal,
    } as unknown as HearthApi;
    render(<Ask api={api} />);
    fireEvent.change(screen.getByTestId('ask-input'), { target: { value: 'turn on the lamp' } });
    fireEvent.click(screen.getByTestId('ask-submit'));
    expect(await screen.findByText(/no server receipt/)).toBeTruthy();
    expect(executeProposal).not.toHaveBeenCalled();
  });

  it('does not send a query proposal to the executor', async () => {
    const executeProposal = vi.fn();
    const api = {
      interpret: async () => ({
        request_id: 'req-query',
        decision: {
          outcome: 'ready_for_contract',
          proposal: { intent_family: 'query-state', target_phrases: ['Living Room Lamp'], desired_values: {} },
          proposal_receipt: 'server-signed-receipt',
        },
        actor: { actor_id: 'a', role: 'admin' },
      }),
      executeProposal,
      listDevices: async () => ({
        devices: [{
          canonical_id: 'ha:light.living_room_lamp',
          friendly_name: 'Living Room Lamp',
          load_type: 'light',
          capabilities: ['on-off'],
          aliases: ['light.living_room_lamp', 'Living Room Lamp'],
          room_id: null,
        }],
        rooms: [],
        actor: { actor_id: 'a', role: 'admin' },
      }),
      getDeviceState: async () => ({ state: {
        canonical_id: 'ha:light.living_room_lamp',
        observed_at: '2026-09-25T17:00:00Z',
        source: 'fresh-poll',
        values: { on: true, brightness: 67 },
        state_version: 2,
      } }),
    } as unknown as HearthApi;
    render(<Ask api={api} />);
    fireEvent.change(screen.getByTestId('ask-input'), { target: { value: 'is the lamp on' } });
    fireEvent.click(screen.getByTestId('ask-submit'));
    expect(await screen.findByText('Living Room Lamp is on')).toBeTruthy();
    expect(screen.getByText('Brightness 67%')).toBeTruthy();
    expect(executeProposal).not.toHaveBeenCalled();
  });

  it('explains when a read query has no matching Home Assistant device', async () => {
    const api = {
      interpret: async () => ({
        request_id: 'req-query',
        decision: {
          outcome: 'ready_for_contract',
          proposal: { intent_family: 'query-state', target_phrases: ['lamp'], desired_values: {} },
          proposal_receipt: 'server-signed-receipt',
        },
        actor: { actor_id: 'a', role: 'admin' },
      }),
      executeProposal: vi.fn(),
      listDevices: async () => ({ devices: [], rooms: [], actor: { actor_id: 'a', role: 'admin' } }),
      getDeviceState: vi.fn(),
    } as unknown as HearthApi;
    render(<Ask api={api} />);
    fireEvent.change(screen.getByTestId('ask-input'), { target: { value: 'is the lamp on' } });
    fireEvent.click(screen.getByTestId('ask-submit'));
    expect(await screen.findByText(/no controllable devices available to read/)).toBeTruthy();
    expect(api.executeProposal).not.toHaveBeenCalled();
  });

  it('renders an error when /v1/interpret fails', async () => {
    const api = makeApi({
      interpret: async () => { throw new Error('csrf_invalid'); },
    });
    render(<Ask api={api} />);

    const input = screen.getByTestId('ask-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'turn on the lamp' } });
    fireEvent.click(screen.getByTestId('ask-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('ask-error').textContent).toContain('csrf_invalid');
    });
  });

  it('does not submit when the input is empty', async () => {
    const interpret = vi.fn();
    const api = makeApi({ interpret });
    render(<Ask api={api} />);
    const submit = screen.getByTestId('ask-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(interpret).not.toHaveBeenCalled();
  });
});
