import React from 'react';
import type { HearthApi, InterpretResponse } from '../api';

type SendState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'ok'; readonly data: InterpretResponse }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Ask screen.
 *
 * Plain text input + send button. Submits to POST /v1/interpret and
 * renders the returned RoutingDecision JSON. Errors render inline so
 * the user can see what went wrong (no toast library in scope yet).
 */
export function Ask({ api }: { readonly api: HearthApi }): React.ReactElement {
  const [utterance, setUtterance] = React.useState('');
  const [state, setState] = React.useState<SendState>({ kind: 'idle' });

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmed = utterance.trim();
    if (trimmed === '') return;
    setState({ kind: 'sending' });
    try {
      const data = await api.interpret(trimmed);
      setState({ kind: 'ok', data });
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
          {state.kind === 'sending' ? 'sending...' : 'send'}
        </button>
      </form>

      {state.kind === 'error' && (
        <div className="error" role="alert" data-testid="ask-error">
          {state.message}
        </div>
      )}
      {state.kind === 'ok' && (
        <div className="ask-result" data-testid="ask-result">
          <h3>routing decision</h3>
          <pre data-testid="ask-decision-json">
            {JSON.stringify(state.data, null, 2)}
          </pre>
        </div>
      )}
    </section>
  );
}
