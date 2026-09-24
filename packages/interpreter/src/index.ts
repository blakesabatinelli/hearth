/**
 * @hearth/interpreter
 *
 * Grammar-first natural-language interpreter plus the routing layer that
 * decides whether to call GLiNER2 and/or Bonsai. Plan section 7 and
 * ADR-2026-09-24-gliner2-required.
 *
 * The grammar is the cheapest path. GLiNER2 is the schema-driven middle
 * path. Bonsai is the contextual-reasoning last resort. The interpreter
 * is the ONLY place where these three layers coordinate.
 *
 * The interpreter does not call device adapters. It only produces
 * RoutingDecisions and IntentProposals. The contract executor does the
 * dispatching.
 */

export {
  GrammarParser,
} from './grammar.js';
export type {
  GrammarMatchResult,
  GrammarParseOptions,
  PronounResolution,
  GrammarRegistry,
} from './grammar.js';

export type { GrammarRegistrySnapshot } from './grammar.js';

export {
  Interpreter,
  ForbiddenFieldError,
  FORBIDDEN_REQUEST_FIELDS,
} from './interpreter.js';
export type {
  InterpreterOptions,
  InterpreterInterpretOptions,
} from './interpreter.js';

export { buildExtractionSchema } from './schema.js';