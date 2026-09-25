# Hearth v3.0.2

Fixes a fresh-install regression introduced in v3.0: every
`SqliteExecutionStore` test failed with "Could not locate the bindings
file" because pnpm 10+ skipped `better-sqlite3`'s prebuild-install
step.

## What's in this release

- **Root `package.json`** now declares
  `pnpm.onlyBuiltDependencies: [better-sqlite3, esbuild]`. This is the
  one-line fix that lets pnpm run the install scripts for native deps.
- **`scripts/install.sh`** now runs `pnpm rebuild better-sqlite3` after
  install and asserts that
  `node_modules/.../better-sqlite3/build/Release/better_sqlite3.node`
  exists before continuing. The install fails loudly (with the rebuild
  command in the error message) if the binding didn't build.
- **`scripts/doctor.sh`** adds a native-binding sanity check at the top:
  PASSes if the binding is present, FAILs with the rebuild hint otherwise.
- **`scripts/install.sh`** defaults to `<owner>/hearth.git` so a fresh
  install does not embed the GitHub org/user.

## Tests

197 tests across 9 packages + apps; typecheck clean; portability /
Bonsai-lock / GLiNER2-lock verifiers green.

```
packages/contracts:       7/7
packages/registry:      12/12
packages/ha-adapter:    15/15
packages/executor:      31/31   (previously failing without this fix)
packages/interpreter:   44/44
packages/extractor:      8/8
packages/scheduler:     14/14
apps/control:           43/43
apps/web:               23/23
                      ------
                      197
```

## Upgrade from v3.0.1

```bash
git fetch origin --tags
git checkout v3.0.2
pnpm install --frozen-lockfile
pnpm rebuild better-sqlite3   # only needed once; install.sh does this automatically
node scripts/doctor.sh
```

If you were running v3.0.1 on the deployment host and saw
`SqliteExecutionStore` test failures or the doctor reporting the binding
as missing, this release fixes it.

## What's NOT validated in this release

Still requires the deployment machine for live OpenClaw, Bonsai 27B,
GLiNER2 `fastino/gliner2.5-base-v1`, Home Assistant credentials, and a
labeled evaluation corpus. A production-ready declaration is gated on a
live-resource end-to-end run; this release is fixture-mode only.

## Documentation status

This release is post-scrub. All publication-facing docs on `main` are
clean of personal references; clone URLs use the `<owner>/hearth`
placeholder.
