/**
 * Ask screen test.
 *
 * Verifies that submitting the form POSTs /v1/interpret and renders the
 * returned RoutingDecision JSON. Also verifies that a failure surfaces
 * an inline error.
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

  it('submits the form and renders RoutingDecision JSON', async () => {
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
      const pre = screen.getByTestId('ask-decision-json');
      expect(pre.textContent).toContain('ready_for_contract');
      expect(pre.textContent).toContain('set-state');
    });
    expect(interpret).toHaveBeenCalledTimes(1);
    expect(interpret.mock.calls[0]?.[0]).toBe('turn on the lamp');
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
