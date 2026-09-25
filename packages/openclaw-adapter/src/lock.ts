/**
 * OpenClaw lock -- the pinned version + checksums for the OpenClaw
 * external Gateway package. Stored as a TS module so the build verifies
 * the contents at compile time (no JSON deserialization fuzz).
 *
 * Section 13 item 7 of docs/macos-host-setup.md requires this lock
 * to carry: exact version, upstream commit SHA, llama.cpp commit
 * SHA, Metal build profile. Where measurements aren't yet on the
 * deployment host, an `unverified` marker + TODO points to the
 * command the operator must run to fill in the value.
 *
 * The exact machine measurements (peak_memory_mb, startup_ms,
 * tokens_per_second) are operator-supplied and never inferred.
 * The schema validator at the top of the package audit must reject
 * any lock file carrying measurements without an `operator_provenance`
 * block.
 */

import { HEARTH_OPENCLAW_PIN } from '@hearth/contracts';

export interface OpenClawLock {
  /** Mirror of HEARTH_OPENCLAW_PIN from @hearth/contracts. */
  readonly pinned_version: string;
  /** Upstream commit SHA for that version. */
  readonly commit_sha: string;
  /** Provenance of where that commit was sourced. */
  readonly commit_source: 'github:openclaw-ai/openclaw';
  /** llama.cpp commit the gateway uses for local Bonsai execution. */
  readonly llama_cpp_commit_sha: string;
  /** Metal acceleration profile if macOS. */
  readonly metal_build_profile:
    | { readonly platform: 'darwin'; readonly metal_profile: 'auto' | 'release-v13+' }
    | { readonly platform: 'linux' };
  /** Performance measurements, operator-supplied. */
  readonly measurements:
    | {
        readonly status: 'measured';
        readonly operator_provenance: { readonly host: string; readonly captured_at: string };
        readonly peak_memory_mb: number;
        readonly startup_ms: number;
        readonly tokens_per_second: number;
      }
    | {
        readonly status: 'unverified';
        readonly todo_commands: ReadonlyArray<string>;
      };
}

export const openclaw_lock: OpenClawLock = {
  pinned_version: HEARTH_OPENCLAW_PIN,
  // commit for openclaw 2026.9.6 (pinned version). Filled in during
  // item 7 verification on the deployment host. The placeholder below
  // is REJECTED by scripts/verify-openclaw-lock.mjs.
  commit_sha: 'PENDING_OPERATOR_VERIFICATION',
  commit_source: 'github:openclaw-ai/openclaw',
  llama_cpp_commit_sha: 'PENDING_OPERATOR_VERIFICATION',
  metal_build_profile: { platform: 'darwin', metal_profile: 'auto' },
  measurements: {
    status: 'unverified',
    todo_commands: [
      '# Run on the deployment host to capture the commits:',
      'npm view openclaw@2026.9.6 dist.tarball',
      'git ls-remote https://github.com/openclaw-ai/openclaw.git v2026.9.6',
      '# Run after `openclaw doctor` to capture llama.cpp commit:',
      'openclaw models inspect --json | jq .runtime.llama_cpp_commit',
      '# Performance:',
      'time openclaw agent --agent main --message "ping"',
      '/usr/bin/time -l openclaw agent --agent main --message "ping" 2>&1 | grep -i resident',
    ],
  },
};
