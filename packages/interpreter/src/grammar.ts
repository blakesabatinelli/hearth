/**
 * Grammar parser for Hearth natural-language interpretation.
 *
 * Plan section 7: the grammar is the cheapest path. It MUST consume the
 * WHOLE utterance. Unknown trailing clauses, unsupported conjunctions,
 * multiple exclusions, negation, pronouns without context, or unresolved
 * time language reject the fast path. The grammar never extracts a
 * recognized prefix and silently discards the rest.
 *
 * The parser is pure and deterministic. No I/O. No model calls. It
 * resolves device phrases against the injected RegistryOverlay. Pronouns
 * ("it", "that one") resolve against recent fresh state supplied by
 * the caller; without it, the parser rejects.
 */

import type {
  CanonicalId,
  DeviceRecord,
  IntentFamily,
  IntentProposal,
  LoadType,
  ProposalProvenance,
  ProviderId,
  TemporalClause,
} from '@hearth/contracts';
// Re-export so consumers can import the canonical types through
// interpreter if they want.
export type { DeviceRecord, LoadType, CanonicalId };

/**
 * Structural type for the RegistryOverlay consumed by the grammar. The
 * canonical class lives in @hearth/registry. We declare the minimum
 * shape here so the interpreter has no compile-time coupling to that
 * package's dist layout (it is consumed as an injected dependency).
 *
 * At runtime, the consumer's RegistryOverlay instance is checked
 * structurally: anything with these methods satisfies the grammar. The
 * real @hearth/registry RegistryOverlay class satisfies it.
 */
export type GrammarRegistry = {
  resolve(phrase: string): Promise<ReadonlyArray<GrammarResolution>>;
  device(canonical_id: CanonicalId): DeviceRecord | null;
  /**
   * Optional. The real @hearth/registry RegistryOverlay exposes
   * `snapshot()` returning the full overlay state. Schema builders may
   * read it; if absent, the schema is built without device hints.
   */
  snapshot?(): GrammarRegistrySnapshot;
};

export type GrammarRegistrySnapshot = {
  readonly devices: ReadonlyArray<DeviceRecord>;
  readonly rooms: ReadonlyArray<{
    readonly room_id: string;
    readonly name: string;
    readonly device_ids: ReadonlyArray<CanonicalId>;
  }>;
  readonly entity_version: number;
  readonly scene_versions: Readonly<Record<string, number>>;
};

export type GrammarResolution = {
  readonly device: DeviceRecord;
  readonly aliases_provider_ids: ReadonlyArray<ProviderId>;
  readonly matched_via: 'exact-id' | 'alias' | 'friendly_name' | 'room' | 'unknown';
};

// =============================================================================
// Public types
// =============================================================================

/**
 * Pronoun resolution context. The caller (interpreter) injects recent
 * fresh state so "turn it off" can be bound to the last-mentioned
 * canonical device. Without this, the grammar rejects.
 */
export type PronounResolution = {
  readonly last_device: CanonicalId | null;
  readonly has_recent_fresh_state: boolean;
};

export type GrammarParseOptions = {
  /**
   * Pronoun binding source. Defaults to "no context" so the grammar
   * rejects pronouns unless the interpreter has fed it fresh state.
   */
  readonly pronoun_resolution?: PronounResolution;
};

export type GrammarMatchResult =
  | { readonly ok: true; readonly proposal: IntentProposal }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly residual_utterance: string;
    };

/** Pronouns that must be resolved against recent fresh state. */
export const PRONOUNS = ['it', 'that one', 'that', 'this one', 'this'] as const;

/** Speech-error / non-standard tokens that must reject the fast path. */
const SPEECH_ERROR_TOKENS = [
  'lumens', // lights
  'lam', // lamp
  'lite', // light
  'litez',
  'swich', // switch
  'swtich',
  'brigthness', // brightness
  'brigthen',
] as const;

// =============================================================================
// Internal types
// =============================================================================

type DeviceMatch = {
  readonly canonical_id: CanonicalId;
  readonly friendly_name: string;
  readonly load_type: LoadType;
};

// =============================================================================
// GrammarParser
// =============================================================================

export class GrammarParser {
  private readonly registry: GrammarRegistry;

  public constructor(opts: { registry: GrammarRegistry }) {
    if (!opts || !opts.registry) {
      throw new Error('GrammarParser requires a registry');
    }
    this.registry = opts.registry;
  }

  /**
   * Parse an utterance. Returns a successful proposal ONLY if the entire
   * utterance was consumed, all targets resolved, all values explicit, and
   * no unresolved fields remain.
   */
  public async parse(
    utterance: string,
    request_id: string,
    options: GrammarParseOptions = {},
  ): Promise<GrammarMatchResult> {
    if (typeof utterance !== 'string') {
      return { ok: false, reason: 'utterance is not a string', residual_utterance: '' };
    }
    const trimmed = utterance.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: 'empty utterance', residual_utterance: '' };
    }

    const pronoun_resolution = options.pronoun_resolution ?? {
      last_device: null,
      has_recent_fresh_state: false,
    };

    const normalized = trimmed.toLowerCase();
    const tokens = normalized.split(/\s+/).filter(Boolean);

    // 1) Speech-error guard: reject the fast path so the model can handle
    //    "lumens" / "lam" / etc. Never coerce silently.
    for (const tok of tokens) {
      const cleaned = tok.replace(/[^a-z]/g, '');
      if ((SPEECH_ERROR_TOKENS as ReadonlyArray<string>).includes(cleaned)) {
        return {
          ok: false,
          reason: `speech-error token "${cleaned}" requires model fallback`,
          residual_utterance: trimmed,
        };
      }
    }

    // 2) Negation guard: any "do not", "don't", "no", "neither", "not" in
    //    the utterance rejects the fast path. Plan section 7: negation
    //    forces Bonsai/clarification.
    if (containsNegation(normalized)) {
      return {
        ok: false,
        reason: 'negation in utterance requires model or clarification',
        residual_utterance: trimmed,
      };
    }

    // 3) Pronoun guard: detect pronouns before any rule attempt so we
    //    don't bind them to the wrong target.
    const pronounToken = findPronoun(tokens);
    if (pronounToken && !pronoun_resolution.has_recent_fresh_state) {
      return {
        ok: false,
        reason: `pronoun "${pronounToken}" requires recent fresh state context`,
        residual_utterance: trimmed,
      };
    }

    // 4) Conjunction guard: count distinct action verbs. "turn on X and
    //    dim Y" is two actions; per plan section 7 this rejects the fast
    //    path. We split on conjunction markers and inspect the halves.
    const halves = splitOnConjunction(normalized);
    if (halves.length > 1) {
      // Multiple halves. Probe each half with the single-clause parser.
      // If two or more halves parse successfully -> multi-action reject.
      // If one parses and the rest have only connector noise -> accept.
      // If one parses and another has substantive content (verb or
      // noun phrase) that the grammar couldn't parse -> reject as a
      // dropped clause.
      let successes = 0;
      const subResults: Array<{ half: string; result: GrammarMatchResult }> = [];
      for (const half of halves) {
        const sub = await this.parseSingle(half.trim(), request_id, pronoun_resolution);
        subResults.push({ half, result: sub });
        if (sub.ok) successes += 1;
      }
      if (successes > 1) {
        return {
          ok: false,
          reason: 'multiple actions in one utterance',
          residual_utterance: trimmed,
        };
      }
      // One (or zero) successes. Find the first success.
      const firstSuccess = subResults.find((s) => s.result.ok);
      if (!firstSuccess) {
        return {
          ok: false,
          reason: 'no supported pattern matched',
          residual_utterance: trimmed,
        };
      }
      // Check the remaining halves: if any has substantive content,
      // reject as multiple actions (the grammar could not honor all of
      // them in one pass). If all others are empty / connector-only,
      // return the single successful parse.
      for (const sub of subResults) {
        if (sub.result.ok) continue;
        const h = sub.half.trim();
        if (h.length === 0) continue;
        if (isConjunctionNoise(h)) continue;
        // The other half has substantive content the grammar couldn't
        // parse in isolation. That's a multi-action utterance.
        if (looksLikeIndependentClause(h)) {
          return {
            ok: false,
            reason: 'multiple actions in one utterance',
            residual_utterance: trimmed,
          };
        }
        // Single-clause parse failed but no independent verb either.
        // Treat as trailing dropped clause.
        return {
          ok: false,
          reason: 'trailing clause could not be honored',
          residual_utterance: trimmed,
        };
      }
      return firstSuccess.result;
    }

    // 5) Single-clause parse. If the utterance has no conjunction, parse
    //    it directly. If it had a conjunction but only one half parses,
    //    try each half and pick the first success.
    if (halves.length === 1) {
      return this.parseSingle(normalized, request_id, pronoun_resolution);
    }
    for (const half of halves) {
      const r = await this.parseSingle(half.trim(), request_id, pronoun_resolution);
      if (r.ok) {
        // Even though only one half parsed, we must verify the others
        // were empty or noise; otherwise we'd be silently dropping a
        // clause. We require the other halves to be empty / connector
        // words only. If any half has meaningful content that didn't
        // parse, reject.
        for (const other of halves) {
          if (other === half) continue;
          if (other.trim().length === 0) continue;
          if (isConjunctionNoise(other.trim())) continue;
          // The other half has content the grammar couldn't honor.
          return {
            ok: false,
            reason: 'trailing clause could not be honored',
            residual_utterance: trimmed,
          };
        }
        return r;
      }
    }
    return {
      ok: false,
      reason: 'no supported pattern matched',
      residual_utterance: trimmed,
    };
  }

  /**
   * Parse a single-clause utterance (no conjunction). Exposed for the
   * conjunction splitter to probe sub-fragments.
   */
  private async parseSingle(
    normalized: string,
    request_id: string,
    pronoun_resolution: PronounResolution,
  ): Promise<GrammarMatchResult> {
    // Order matters: more specific patterns first.

    // (i) "turn X until {midnight,sunrise,sunset}" -> hold-until. This
    //     must run before trySetState because trySetState would
    //     otherwise capture "turn on the lamp until midnight" with the
    //     entire "the lamp until midnight" as the target phrase.
    {
      const hold = await this.tryHoldUntil(normalized, request_id, pronoun_resolution);
      if (hold) return hold;
    }

    // (a) "run X" / "trigger X" -> routine-trigger
    {
      const m = matchRoutineTrigger(normalized);
      if (m) {
        const proposal = buildProposal({
          request_id,
          intent_family: 'routine-trigger',
          target_phrases: [m.routine_name],
          exclusions: [],
          desired_values: { routine_name: m.routine_name },
          temporal: null,
          unresolved_fields: [],
          confidence: 1,
          provenance: { source: 'grammar', matched_rule: 'routine-trigger@1' },
        });
        return { ok: true, proposal };
      }
    }

    // (b) "turn on X" / "switch on X" / "X on"
    // (c) "turn off X" / "switch off X" / "X off"
    // (e) "turn off everything except X" / "all off except X"
    {
      const setState = await this.trySetState(normalized, request_id, pronoun_resolution);
      if (setState) return setState;
    }

    // (d) "set X to N percent" / "X at N percent" / "brightness N on X"
    {
      const abs = await this.trySetBrightnessAbsolute(normalized, request_id, pronoun_resolution);
      if (abs) return abs;
    }

    // (f) "dim X by N percent" / "X down N"
    // (g) "brighten X by N percent" / "X up N"
    {
      const rel = await this.trySetBrightnessRelative(normalized, request_id, pronoun_resolution);
      if (rel) return rel;
    }

    // (h) "X to a little dimmer" / "X a little brighter"
    {
      const vague = await this.trySetBrightnessVague(normalized, request_id, pronoun_resolution);
      if (vague) return vague;
    }

    // (i) "until midnight" / "until sunrise" -> hold-until. The grammar
    //     holds the most recently mentioned target alongside.
    {
      const hold = await this.tryHoldUntil(normalized, request_id, pronoun_resolution);
      if (hold) return hold;
    }

    return { ok: false, reason: 'no supported pattern matched', residual_utterance: normalized };
  }

  // ---------------------------------------------------------------------------
      // set-state (turn on / off, with or without exclusions)
      // ---------------------------------------------------------------------------

    private async trySetState(
        normalized: string,
        request_id: string,
        pronoun_resolution: PronounResolution,
      ): Promise<GrammarMatchResult | null> {
        // Pattern B (must run before Pattern A): "all off except X" /
        // "turn off everything except X". If the utterance contains an
        // "except" clause we honor it specifically, not as a generic set-
        // state. Running this first also prevents pattern A from capturing
        // "turn off everything except office and lamp" with the entire
        // tail as a single target.
        const allExcept = /^all\s+off\s+except\s+(.+)$/.exec(normalized)
          ?? /^turn\s+off\s+everything\s+except\s+(.+)$/.exec(normalized)
          ?? /^everything\s+off\s+except\s+(.+)$/.exec(normalized);
        if (allExcept && allExcept[1] !== undefined) {
          const rest = allExcept[1];
          return this.buildSetStateExcept(rest, request_id, pronoun_resolution, normalized);
        }

        // Pattern A: "turn on/off X" / "switch on/off X" (verb-then-state)
        const turnMatch = /^(?:turn|switch)\s+(on|off)\s+(.+)$/.exec(normalized);
        if (turnMatch && turnMatch[1] !== undefined && turnMatch[2] !== undefined) {
          const on = turnMatch[1] === 'on';
          const rest = turnMatch[2];
          // If the rest contains "except", pattern B should have matched.
          // Defensive check: if it did not (regex failed), reject so we
          // never silently drop a multi-exclusion clause.
          if (/\bexcept\b/.test(rest)) {
            return {
              ok: false,
              reason: '"except" clause did not match the all-off-except pattern',
              residual_utterance: normalized,
            };
          }
          return this.buildSetState(rest, on, request_id, pronoun_resolution, 'turn-on-off@1', normalized);
        }

      // Pattern A2: "turn X on/off" / "switch X on/off" (verb-then-object-then-state)
      // E.g. "turn it on", "switch the lamp off". We require the state word
      // to be the LAST token so we don't accidentally match "switch the
      // on-call lamp".
      const turnObjMatch = /^(?:turn|switch)\s+(.+?)\s+(on|off)$/.exec(normalized);
      if (
        turnObjMatch &&
        turnObjMatch[1] !== undefined &&
        turnObjMatch[2] !== undefined
      ) {
        const rest = turnObjMatch[1];
        const on = turnObjMatch[2] === 'on';
        // Skip if "rest" looks like it would swallow an entire clause (we
        // want a single noun phrase, not a sentence). The conjunction
        // splitter already handles multi-clause utterances; here we just
        // need to avoid capturing "and dim Y" as the target.
        if (!/\b(?:and|then)\b/.test(rest)) {
          return this.buildSetState(
            rest,
            on,
            request_id,
            pronoun_resolution,
            'turn-X-on-off@1',
            normalized,
          );
        }
      }

    // Pattern C: "X on" / "X off" (shorthand)
    const shorthand = /^([a-z0-9\s'()-]+?)\s+(on|off)$/.exec(normalized);
    if (shorthand && shorthand[1] !== undefined && shorthand[2] !== undefined) {
      const rest = shorthand[1];
      const on = shorthand[2] === 'on';
      // The shorthand matches many things; require the rest to contain
      // either "the" or a recognizable target. We let the resolver
      // validate; if it can't, it rejects.
      return this.buildSetState(rest, on, request_id, pronoun_resolution, 'shorthand@1', normalized);
    }

    return null;
  }

  private async buildSetState(
    target_phrase_raw: string,
    on: boolean,
    request_id: string,
    pronoun_resolution: PronounResolution,
    matched_rule: string,
    full_utterance: string,
  ): Promise<GrammarMatchResult | null> {
    // Strip leading "the" and trailing noise.
    const cleaned = stripThe(target_phrase_raw).trim();
    if (cleaned.length === 0) {
      return {
        ok: false,
        reason: 'empty target in set-state clause',
        residual_utterance: full_utterance,
      };
    }
    const device = await this.resolveTarget(cleaned, pronoun_resolution);
    if (!device) {
      return {
        ok: false,
        reason: `target "${cleaned}" did not resolve to a known device`,
        residual_utterance: full_utterance,
      };
    }
    const proposal = buildProposal({
      request_id,
      intent_family: 'set-state',
      target_phrases: [device.friendly_name],
      exclusions: [],
      desired_values: withLoadTypeHint({ on }, device.load_type),
      temporal: null,
      unresolved_fields: [],
      confidence: 1,
      provenance: { source: 'grammar', matched_rule },
    });
    return { ok: true, proposal };
  }

  private async buildSetStateExcept(
    except_phrase_raw: string,
    request_id: string,
    pronoun_resolution: PronounResolution,
    full_utterance: string,
  ): Promise<GrammarMatchResult | null> {
    // "turn off everything except X" -> the action target is "everything"
    // (which means all non-excluded devices). The grammar cannot expand
    // "everything" into the full device list; that is the resolver's job.
    // The proposal carries exclusions (phrase "everything" + exclusion
    // names) and a set-state intent_family. The contract executor is the
    // only place that knows which devices exist; the resolver applies
    // the exclusion list there.
    //
    // What we CAN honor: capture the excluded phrase(s). We split on
    // "and" / "," inside the except clause for multiple exclusions, but
    // plan section 7 says "multiple exclusions" reject the fast path.
    // So we accept ONE exclusion phrase here. Multi-exclusion goes to
    // Bonsai/clarification.
    const phrases = splitExclusions(except_phrase_raw);
    if (phrases.length > 1) {
      return {
        ok: false,
        reason: 'multiple exclusions require model or clarification',
        residual_utterance: full_utterance,
      };
    }
    if (phrases.length === 0) {
      return {
        ok: false,
        reason: 'empty exclusion in "everything except" clause',
        residual_utterance: full_utterance,
      };
    }
    const exclusionPhrase = stripThe(phrases[0]!).trim();
    if (exclusionPhrase.length === 0) {
      return {
        ok: false,
        reason: 'empty exclusion phrase',
        residual_utterance: full_utterance,
      };
    }
    const excludedDevice = await this.resolveTarget(exclusionPhrase, pronoun_resolution);
    if (!excludedDevice) {
      return {
        ok: false,
        reason: `exclusion "${exclusionPhrase}" did not resolve to a known device`,
        residual_utterance: full_utterance,
      };
    }
    // "everything" target: we still want the proposal to carry at least
    // one target phrase so the resolver has something to expand. We use
    // the resolved exclusion's complement pattern: the resolver will
    // expand "everything except <X>" into all non-X devices. To keep
    // the proposal honest, we set target_phrases=["everything"] and
    // exclusions=[X.friendly_name].
    const proposal = buildProposal({
      request_id,
      intent_family: 'set-state',
      target_phrases: ['everything'],
      exclusions: [excludedDevice.friendly_name],
      desired_values: { on: false },
      temporal: null,
      unresolved_fields: [],
      confidence: 1,
      provenance: { source: 'grammar', matched_rule: 'all-off-except@1' },
    });
    return { ok: true, proposal };
  }

  // ---------------------------------------------------------------------------
  // set-brightness-absolute
  // ---------------------------------------------------------------------------

  private async trySetBrightnessAbsolute(
    normalized: string,
    request_id: string,
    pronoun_resolution: PronounResolution,
  ): Promise<GrammarMatchResult | null> {
    // "set X to N percent" / "set X to N%"
    const m1 = /^set\s+(.+?)\s+to\s+(\d{1,3})\s*(?:%|percent)?$/.exec(normalized);
    if (m1 && m1[1] !== undefined && m1[2] !== undefined) {
      const target = stripThe(m1[1]).trim();
      const n = clampPercent(Number(m1[2]));
      const device = await this.resolveTarget(target, pronoun_resolution);
      if (!device) return this.rejectTarget(target, normalized);
      return this.okBrightnessAbsolute(target, device, n, request_id, 'set-to@1');
    }

    // "X at N percent"
    const m2 = /^(.+?)\s+at\s+(\d{1,3})\s*(?:%|percent)?$/.exec(normalized);
    if (m2 && m2[1] !== undefined && m2[2] !== undefined) {
      const target = stripThe(m2[1]).trim();
      const n = clampPercent(Number(m2[2]));
      const device = await this.resolveTarget(target, pronoun_resolution);
      if (!device) return this.rejectTarget(target, normalized);
      return this.okBrightnessAbsolute(target, device, n, request_id, 'at-percent@1');
    }

    // "brightness N on X"
    const m3 = /^brightness\s+(\d{1,3})\s*(?:%|percent)?\s+on\s+(.+)$/.exec(normalized);
    if (m3 && m3[1] !== undefined && m3[2] !== undefined) {
      const n = clampPercent(Number(m3[1]));
      const target = stripThe(m3[2]).trim();
      const device = await this.resolveTarget(target, pronoun_resolution);
      if (!device) return this.rejectTarget(target, normalized);
      return this.okBrightnessAbsolute(target, device, n, request_id, 'brightness-on@1');
    }

    return null;
  }

  private okBrightnessAbsolute(
    target: string,
    device: DeviceMatch,
    brightness: number,
    request_id: string,
    matched_rule: string,
  ): GrammarMatchResult {
    const proposal = buildProposal({
      request_id,
      intent_family: 'set-brightness-absolute',
      target_phrases: [device.friendly_name],
      exclusions: [],
      desired_values: withLoadTypeHint({ brightness }, device.load_type),
      temporal: null,
      unresolved_fields: [],
      confidence: 1,
      provenance: { source: 'grammar', matched_rule },
    });
    void target;
    return { ok: true, proposal };
  }

  // ---------------------------------------------------------------------------
  // set-brightness-relative (dim by N, brighten by N, X down N, X up N)
  // ---------------------------------------------------------------------------

  private async trySetBrightnessRelative(
    normalized: string,
    request_id: string,
    pronoun_resolution: PronounResolution,
  ): Promise<GrammarMatchResult | null> {
    // "dim X by N percent" / "dim X by N%"
    const m1 = /^dim\s+(.+?)\s+by\s+(\d{1,3})\s*(?:%|percent)?$/.exec(normalized);
    if (m1 && m1[1] !== undefined && m1[2] !== undefined) {
      const target = stripThe(m1[1]).trim();
      const n = clampPercent(Number(m1[2]));
      const device = await this.resolveTarget(target, pronoun_resolution);
      if (!device) return this.rejectTarget(target, normalized);
      return this.okBrightnessRelative(target, device, -n, request_id, 'dim-by@1');
    }

    // "brighten X by N percent" / "brighten X by N%"
    const m2 = /^brighten\s+(.+?)\s+by\s+(\d{1,3})\s*(?:%|percent)?$/.exec(normalized);
    if (m2 && m2[1] !== undefined && m2[2] !== undefined) {
      const target = stripThe(m2[1]).trim();
      const n = clampPercent(Number(m2[2]));
      const device = await this.resolveTarget(target, pronoun_resolution);
      if (!device) return this.rejectTarget(target, normalized);
      return this.okBrightnessRelative(target, device, +n, request_id, 'brighten-by@1');
    }

    // "X down N" / "X up N" (shorthand)
    const m3 = /^(.+?)\s+(down|up)\s+(\d{1,3})\s*(?:%|percent)?$/.exec(normalized);
    if (m3 && m3[1] !== undefined && m3[2] !== undefined && m3[3] !== undefined) {
      const target = stripThe(m3[1]).trim();
      const direction = m3[2];
      const n = clampPercent(Number(m3[3]));
      const device = await this.resolveTarget(target, pronoun_resolution);
      if (!device) return this.rejectTarget(target, normalized);
      const delta = direction === 'up' ? +n : -n;
      return this.okBrightnessRelative(target, device, delta, request_id, 'shorthand-down-up@1');
    }

    return null;
  }

  private okBrightnessRelative(
    target: string,
    device: DeviceMatch,
    delta: number,
    request_id: string,
    matched_rule: string,
  ): GrammarMatchResult {
    const proposal = buildProposal({
      request_id,
      intent_family: 'set-brightness-relative',
      target_phrases: [device.friendly_name],
      exclusions: [],
      desired_values: withLoadTypeHint({ brightness_delta: delta }, device.load_type),
      temporal: null,
      unresolved_fields: [],
      confidence: 1,
      provenance: { source: 'grammar', matched_rule },
    });
    void target;
    return { ok: true, proposal };
  }

  // ---------------------------------------------------------------------------
  // set-brightness-relative (vague: "a little dimmer")
  // ---------------------------------------------------------------------------

  private async trySetBrightnessVague(
    normalized: string,
    request_id: string,
    pronoun_resolution: PronounResolution,
  ): Promise<GrammarMatchResult | null> {
    // "X to a little dimmer" / "X to a little brighter"
    // "X a little dimmer" / "X a little brighter"
    const m = /^(.+?)\s+(?:to\s+)?a\s+little\s+(dimmer|brighter)$/.exec(normalized);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      const target = stripThe(m[1]).trim();
      const direction = m[2];
      const device = await this.resolveTarget(target, pronoun_resolution);
      if (!device) return this.rejectTarget(target, normalized);
      const delta = direction === 'dimmer' ? -DEFAULT_VAGUE_DELTA : +DEFAULT_VAGUE_DELTA;
      // Vague relative adjustments require fresh state. Without it we
      // reject. The caller passes pronoun_resolution.has_recent_fresh_state
      // to signal this; we use the same gate.
      if (!pronoun_resolution.has_recent_fresh_state) {
        return {
          ok: false,
          reason: 'vague brightness adjustment requires fresh state',
          residual_utterance: normalized,
        };
      }
      const proposal = buildProposal({
        request_id,
        intent_family: 'set-brightness-relative',
        target_phrases: [device.friendly_name],
        exclusions: [],
        desired_values: withLoadTypeHint({ brightness_delta: delta, vague: true }, device.load_type),
        temporal: null,
        unresolved_fields: [],
        confidence: 1,
        provenance: { source: 'grammar', matched_rule: 'vague-relative@1' },
      });
      return { ok: true, proposal };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // hold-until ("until midnight", "until sunrise")
  // ---------------------------------------------------------------------------

  private async tryHoldUntil(
    normalized: string,
    request_id: string,
    pronoun_resolution: PronounResolution,
  ): Promise<GrammarMatchResult | null> {
    // We require a target to bind the hold to. So "until midnight" alone
    // is ambiguous unless the pronoun resolution says "this device".
    const m = /^turn\s+(on|off)\s+(.+?)\s+until\s+(midnight|sunrise|sunset)$/.exec(normalized);
    if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
    const on = m[1] === 'on';
    const target = stripThe(m[2]).trim();
    const terminal = m[3];
    const device = await this.resolveTarget(target, pronoun_resolution);
    if (!device) return this.rejectTarget(target, normalized);
    const temporal: TemporalClause =
      terminal === 'midnight'
        ? { kind: 'until', iso: '00:00', restore_behavior: 'restore-previous' }
        : terminal === 'sunrise'
          ? { kind: 'after-sunrise' }
          : { kind: 'after-sunset' };
    const proposal = buildProposal({
      request_id,
      intent_family: 'hold-until',
      target_phrases: [device.friendly_name],
      exclusions: [],
      desired_values: withLoadTypeHint({ on }, device.load_type),
      temporal,
      unresolved_fields: [],
      confidence: 1,
      provenance: { source: 'grammar', matched_rule: 'until-time@1' },
    });
    return { ok: true, proposal };
  }

  // ---------------------------------------------------------------------------
  // Device resolution
  // ---------------------------------------------------------------------------

  private async resolveTarget(
    phrase: string,
    pronoun_resolution: PronounResolution,
  ): Promise<DeviceMatch | null> {
    // Pronoun binding.
    const lower = phrase.toLowerCase().trim();
    if ((PRONOUNS as ReadonlyArray<string>).includes(lower)) {
      if (!pronoun_resolution.has_recent_fresh_state || !pronoun_resolution.last_device) {
        return null;
      }
      const d = this.registry.device(pronoun_resolution.last_device);
      if (!d) return null;
      return {
        canonical_id: d.canonical_id,
        friendly_name: d.friendly_name,
        load_type: d.load_type,
      };
    }

    const matches = await this.registry.resolve(phrase);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      // Multiple candidates: grammar can't disambiguate. Reject.
      return null;
    }
    const m = matches[0]!;
    return {
      canonical_id: m.device.canonical_id,
      friendly_name: m.device.friendly_name,
      load_type: m.device.load_type,
    };
  }

  private rejectTarget(_target: string, residual: string): GrammarMatchResult {
    return {
      ok: false,
      reason: `target could not be resolved to a known device`,
      residual_utterance: residual,
    };
  }
}

// =============================================================================
// Helpers
// =============================================================================

const DEFAULT_VAGUE_DELTA = 10;

function stripThe(s: string): string {
  return s.replace(/^the\s+/i, '').trim();
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

function containsNegation(normalized: string): boolean {
  // Match whole-word negators. We do NOT match "no" inside "north",
  // "nothing", etc. \b guards that. "do not" / "don't" covered.
  const tokens = normalized.split(/\s+/);
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] ?? '';
    if (t === 'not') return true;
    if (t === "don't") return true;
    if (t === 'dont') return true;
    if (t === 'neither') return true;
    if (t === 'no') {
      // Allow "north", "northwest" etc. - \b in the source already does
      // that for the tokenized form. "no" alone or followed by "the"
      // / "way" / "lights" is negation.
      const next = tokens[i + 1] ?? '';
      if (next === 'the' || next === 'way' || next.length === 0) return true;
      // Heuristic: if the next token is a noun, treat as negation
      // ("no lights"). If the next token is a verb the model should
      // decide; we conservatively treat as negation.
      return true;
    }
    if (t === "don't" || t === "dont") return true;
    if (i + 1 < tokens.length && tokens[i] === 'do' && tokens[i + 1] === 'not') {
      return true;
    }
  }
  return false;
}

function findPronoun(tokens: ReadonlyArray<string>): string | null {
  for (const t of tokens) {
    if ((PRONOUNS as ReadonlyArray<string>).includes(t)) return t;
  }
  return null;
}

function splitOnConjunction(normalized: string): ReadonlyArray<string> {
  // Split on " and ", " then " only when the surrounding words look like
  // action verbs ("turn", "dim", "set", "brighten"). Otherwise "and" in
  // "set the lamp and the fan to 50" would be split, which is fine, but
  // in "the lamp and the fan" it shouldn't.
  //
  // Exception: do NOT split inside an "everything except X and Y"
  // clause. The "and" there is part of an exclusion list, not a
  // conjunction between independent actions. We detect this by checking
  // whether "except" appears before the conjunction in the string; the
  // "and" after "except" is excluded from splitting.
  const conjunctionRe = /\s+(?:and|then|,)\s+/g;
  const parts: string[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  // Find positions of "except" markers; conjunction after the LAST
  // "except" is treated as an exclusion-list continuation.
  const exceptIndices: number[] = [];
  const exceptRe = /\bexcept\b/g;
  let em: RegExpExecArray | null;
  while ((em = exceptRe.exec(normalized)) !== null) {
    exceptIndices.push(em.index);
  }
  const lastExceptIdx =
    exceptIndices.length > 0 ? (exceptIndices[exceptIndices.length - 1] ?? -1) : -1;
  while ((m = conjunctionRe.exec(normalized)) !== null) {
    // Split if there is no "except" clause (lastExceptIdx === -1) OR
    // the conjunction comes BEFORE the "except" (i.e., is not part
    // of an exclusion list).
    if (lastExceptIdx === -1 || m.index <= lastExceptIdx) {
      const head = normalized.slice(lastIndex, m.index);
      const tail = normalized.slice(conjunctionRe.lastIndex);
      const headLooksLikeClause = /\b(?:turn|switch|set|dim|brighten|run|trigger)\b/.test(head);
      const tailLooksLikeClause = /^(?:turn|switch|set|dim|brighten|run|trigger)\b/.test(tail);
      if (headLooksLikeClause || tailLooksLikeClause) {
        parts.push(head);
        lastIndex = conjunctionRe.lastIndex;
      }
    }
  }
  parts.push(normalized.slice(lastIndex));
  return parts.filter((p) => p.trim().length > 0);
}

function splitExclusions(s: string): ReadonlyArray<string> {
  // Split on " and " or "," inside the "except X" clause.
  return s
    .split(/\s*(?:,|\sand\s)\s*/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function isConjunctionNoise(s: string): boolean {
  // Pure connector or punctuation tokens that the conjunction guard
  // produces but that carry no semantic content.
  const cleaned = s.trim().toLowerCase();
  if (cleaned === '' || cleaned === 'and' || cleaned === 'then' || cleaned === ',') return true;
  return false;
}

function looksLikeIndependentClause(s: string): boolean {
  const lower = s.trim().toLowerCase();
  if (lower.length === 0) return false;
  // An "independent clause" here means: starts with a recognized action
  // verb OR ends with a recognizable state word (on/off). This catches
  // "dim the office", "turn on the lamp", "the lamp off", etc.
  const startsWithVerb =
    /^(?:turn|switch|set|dim|brighten|run|trigger)\b/.test(lower);
  const endsWithState = /\b(?:on|off)$/.test(lower);
  return startsWithVerb || endsWithState;
}

function matchRoutineTrigger(normalized: string): { readonly routine_name: string } | null {
  const m = /^(?:run|trigger)\s+(.+)$/.exec(normalized);
  if (!m || m[1] === undefined) return null;
  const name = m[1].trim();
  if (name.length === 0) return null;
  return { routine_name: name };
}

/**
 * If the device's load_type is unknown-switch, propagate a
 * `load_type: 'unknown-switch'` field inside desired_values. The
 * IntentProposal has no load_type field of its own; this is the only
 * honest way to flag it so the contract executor (which sees
 * load_type in ContractTarget) can warn.
 *
 * Light / fan / outlet etc. add NO entry; they are classified.
 */
function withLoadTypeHint(
  base: Readonly<Record<string, number | string | boolean>>,
  load_type: LoadType,
): Readonly<Record<string, number | string | boolean>> {
  if (load_type === 'unknown-switch') {
    return { ...base, load_type: 'unknown-switch' };
  }
  return base;
}

// =============================================================================
// Proposal builder
// =============================================================================

type BuildProposalArgs = {
  readonly request_id: string;
  readonly intent_family: IntentFamily;
  readonly target_phrases: ReadonlyArray<string>;
  readonly exclusions: ReadonlyArray<string>;
  readonly desired_values: Readonly<Record<string, number | string | boolean>>;
  readonly temporal: TemporalClause | null;
  readonly unresolved_fields: ReadonlyArray<string>;
  readonly confidence: number;
  readonly provenance: ProposalProvenance;
};

function buildProposal(args: BuildProposalArgs): IntentProposal {
  return {
    request_id: args.request_id,
    intent_family: args.intent_family,
    target_phrases: args.target_phrases,
    exclusions: args.exclusions,
    desired_values: args.desired_values,
    temporal: args.temporal,
    unresolved_fields: args.unresolved_fields,
    confidence: args.confidence,
    provenance: args.provenance,
  };
}