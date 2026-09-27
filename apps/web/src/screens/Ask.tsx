import React from 'react';
import type { DeviceState, HearthApi, InterpretResponse } from '../api';

type SendState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'ok'; readonly data: InterpretResponse }
  | { readonly kind: 'error'; readonly message: string };

type ReadyProposal = {
  readonly proposal: Record<string, unknown>;
  readonly proposal_receipt?: string;
};

function actionSummary(proposal: Record<string, unknown>): string {
  switch (proposal['intent_family']) {
    case 'set-state': {
      const values = proposal['desired_values'];
      if (typeof values === 'object' && values !== null && typeof (values as Record<string, unknown>)['on'] === 'boolean') {
        return (values as Record<string, unknown>)['on'] ? 'Turn on' : 'Turn off';
      }
      return 'Change device state for';
    }
    case 'set-brightness-absolute': {
      const values = proposal['desired_values'];
      const brightness = typeof values === 'object' && values !== null ? (values as Record<string, unknown>)['brightness'] : null;
      return typeof brightness === 'number' ? `Set brightness to ${brightness}% for` : 'Adjust brightness for';
    }
    case 'set-brightness-relative': return 'Adjust brightness for';
    case 'set-scene': return 'Run scene for';
    case 'hold-until': return 'Hold state for';
    case 'routine-trigger': return 'Run routine for';
    case 'query-state': return 'Check the state of';
    default: return 'Requested action for';
  }
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function readyProposal(response: InterpretResponse | null): ReadyProposal | null {
  if (!response || typeof response.decision !== 'object' || response.decision === null) return null;
  const decision = response.decision as Record<string, unknown>;
  if (decision.outcome !== 'ready_for_contract' || typeof decision.proposal !== 'object' || decision.proposal === null) return null;
  return {
    proposal: decision.proposal as Record<string, unknown>,
    ...(typeof decision.proposal_receipt === 'string' ? { proposal_receipt: decision.proposal_receipt } : {}),
  };
}

function isExecutableProposal(proposal: Record<string, unknown>): boolean {
  const family = proposal['intent_family'];
  return family === 'set-state'
    || family === 'set-brightness-absolute'
    || family === 'set-brightness-relative'
    || family === 'set-scene'
    || family === 'hold-until'
    || family === 'routine-trigger';
}

function decisionSource(proposal: Record<string, unknown>): string {
  const provenance = proposal['provenance'];
  if (typeof provenance !== 'object' || provenance === null) return 'not reported';
  const source = (provenance as Record<string, unknown>)['source'];
  switch (source) {
    case 'grammar': return 'grammar';
    case 'gliner2': return 'GLiNER2';
    case 'bonsai': return 'local Bonsai';
    case 'composed-gliner2-bonsai': return 'GLiNER2 + local Bonsai';
    default: return 'not reported';
  }
}

function executorAggregate(receipt: unknown): string | null {
  if (typeof receipt !== 'object' || receipt === null) return null;
  const aggregate = (receipt as Record<string, unknown>)['aggregate'];
  return typeof aggregate === 'string' ? aggregate : null;
}

function executorSummary(receipt: unknown): string {
  switch (executorAggregate(receipt)) {
    case 'no-op': return 'Already in the requested state. No device command was needed.';
    case 'confirmed': return 'Home Assistant confirmed the requested state.';
    case 'partial': return 'Only some targets changed. Review History for the per-device results.';
    case 'sent-unconfirmed': return 'The command was sent, but Home Assistant has not confirmed the state yet.';
    case 'failed': return 'Home Assistant did not confirm the command. Review History for details.';
    case 'expired': return 'The command expired before it could run.';
    case 'cancelled': return 'The command was cancelled before it ran.';
    default: return 'Hearth returned a result. Review History for details.';
  }
}

/**
 * Ask screen.
 *
 * Plain text input + send button. Submits to POST /v1/interpret and
 * summarizes the returned decision and executor result. Errors render
 * inline so the user can see what went wrong.
 */
export function Ask({ api }: { readonly api: HearthApi }): React.ReactElement {
  const [utterance, setUtterance] = React.useState('');
  const [state, setState] = React.useState<SendState>({ kind: 'idle' });
  const [takingLong, setTakingLong] = React.useState(false);
  const [execution, setExecution] = React.useState<
    | { readonly kind: 'idle' }
    | { readonly kind: 'sending' }
    | { readonly kind: 'ok'; readonly receipt: unknown }
    | { readonly kind: 'query_ok'; readonly device_name: string; readonly state: DeviceState['state'] }
    | { readonly kind: 'error'; readonly message: string }
  >({ kind: 'idle' });

  React.useEffect(() => {
    setTakingLong(false);
    if (state.kind !== 'sending') return;
    const timer = window.setTimeout(() => setTakingLong(true), 3000);
    return () => window.clearTimeout(timer);
  }, [state.kind]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = utterance.trim();
    if (trimmed === '') return;
    setState({ kind: 'sending' });
    try {
      const data = await api.interpret(trimmed);
      setState({ kind: 'ok', data });
      setExecution({ kind: 'idle' });
      const ready = readyProposal(data);
      if (ready?.proposal.intent_family === 'query-state') {
        setExecution({ kind: 'sending' });
        try {
          const requested = Array.isArray(ready.proposal['target_phrases'])
            ? (ready.proposal['target_phrases'] as unknown[]).filter((value): value is string => typeof value === 'string')
            : [];
          const devices = await api.listDevices();
          const names = new Set(requested.map(normalizeName));
          const matches = devices.devices.filter((device) =>
            [device.friendly_name, ...device.aliases].some((alias) => names.has(normalizeName(alias))),
          );
          if (matches.length === 1) {
            const device = matches[0]!;
            const result = await api.getDeviceState(device.canonical_id);
            setExecution({ kind: 'query_ok', device_name: device.friendly_name, state: result.state });
          } else if (matches.length === 0) {
            const reason = devices.devices.length === 0
              ? 'Home Assistant has no controllable devices available to read.'
              : `No exact Home Assistant device match for ${requested.join(', ') || 'that target'}.`;
            setExecution({ kind: 'error', message: reason });
          } else {
            setExecution({ kind: 'error', message: `More than one Home Assistant device matches ${requested.join(', ')}. Be more specific.` });
          }
        } catch (err) {
          setExecution({ kind: 'error', message: (err as Error).message });
        }
      } else if (ready?.proposal_receipt && isExecutableProposal(ready.proposal)) {
        setExecution({ kind: 'sending' });
        try {
          const result = await api.executeProposal(data.request_id, ready.proposal, ready.proposal_receipt);
          setExecution({ kind: 'ok', receipt: result.receipt });
        } catch (err) {
          setExecution({ kind: 'error', message: (err as Error).message });
        }
      }
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message });
    }
  };

  return (
    <section aria-label="ask">
      <h2>Ask</h2>
      <form onSubmit={submit} className="ask-form" data-testid="ask-form">
        <input
          type="text"
          value={utterance}
          onChange={(e) => setUtterance(e.target.value)}
          placeholder="turn on the kitchen lamp"
          aria-label="utterance"
          data-testid="ask-input"
          disabled={state.kind === 'sending'}
        />
        <button
          type="submit"
          disabled={state.kind === 'sending' || utterance.trim() === ''}
          data-testid="ask-submit"
        >
          {state.kind === 'sending' ? 'working...' : 'run with Hearth'}
        </button>
      </form>

      {state.kind === 'sending' && (
        <p role="status">
          {takingLong
            ? 'Still interpreting. Hearth tries GLiNER2 first; the local Bonsai fallback can take longer.'
            : 'Interpreting with Hearth...'}
        </p>
      )}

      {state.kind === 'error' && (
        <div className="error" role="alert" data-testid="ask-error">
          {state.message}
        </div>
      )}
      {state.kind === 'ok' && (
        <div className="ask-result" data-testid="ask-result">
          <h3>Hearth understood</h3>
          {(() => {
            const ready = readyProposal(state.data);
            if (!ready) return null;
            const targets = Array.isArray(ready.proposal['target_phrases'])
              ? (ready.proposal['target_phrases'] as unknown[]).filter((value): value is string => typeof value === 'string')
              : [];
            return (
            <section className="proposal-review" aria-label="proposal execution">
              <p>Decision method: {decisionSource(ready.proposal)}</p>
              <p><strong>{actionSummary(ready.proposal)} {targets.join(', ') || 'no matching device'}</strong></p>
              {!ready.proposal_receipt && isExecutableProposal(ready.proposal) && <p className="muted">This proposal has no server receipt, so it cannot be sent to the executor.</p>}
              {ready.proposal.intent_family === 'query-state' && execution.kind === 'sending' && <p role="status">reading Home Assistant state...</p>}
              {ready.proposal.intent_family !== 'query-state' && !isExecutableProposal(ready.proposal) && <p className="muted">This request does not require device control.</p>}
              {execution.kind === 'sending' && ready.proposal.intent_family !== 'query-state' && <p role="status">sending to executor...</p>}
              {execution.kind === 'error' && <p className="error" role="alert">request could not be completed: {execution.message}</p>}
              {execution.kind === 'query_ok' && (
                <div role="status">
                  <p>{execution.device_name}{typeof execution.state.values['on'] === 'boolean' ? ` is ${execution.state.values['on'] ? 'on' : 'off'}` : ''}</p>
                  {typeof execution.state.values['brightness'] === 'number' && <p>Brightness {execution.state.values['brightness']}%</p>}
                  <p className="muted">Observed at {execution.state.observed_at}</p>
                </div>
              )}
              {execution.kind === 'ok' && (
                <div role="status">
                  <p role={executorAggregate(execution.receipt) === 'failed' ? 'alert' : 'status'}>
                    {executorSummary(execution.receipt)}
                  </p>
                </div>
              )}
            </section>
            );
          })()}
        </div>
      )}
    </section>
  );
}
