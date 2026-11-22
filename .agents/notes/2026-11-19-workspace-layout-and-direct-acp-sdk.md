# Agent Note: Remove `@cycle/acp` wrapper, consolidate daemon/transport, and introduce top-level `harness/`

Status: accepted
Date: 2026-11-19
Basis: User request on 2026-11-19 reviewing workspace package layout and deciding to remove thin wrapper/over-split packages while preparing top-level `harness/` for upcoming Codex and AGY integrations.

## Problem

The workspace had grown to 10 packages with four structural issues:

1. `packages/acp` contained a single 8-line re-export of `@agentclientprotocol/sdk/experimental/v2` after [decision 0005](../../docs/decisions/0005-acp-v2.md) abandoned duplicating ACP's zod schemas.
2. `packages/daemon` was only consumed in production by `apps/daemon` (9 files of CLI/config glue), splitting one daemon across two packages (`@cycle/daemon` and `@cycle/daemon-app`).
3. `packages/transport` (4 files, 330 lines) combined incompatible Bun-only server code (`Bun.listen`/`Bun.connect`, used only by `apps/daemon`) and Node-compatible client code (`node:net`/`node:child_process`, used only by `packages/client` and `apps/desktop`), requiring per-file runtime exceptions in `scripts/check.ts`.
4. `packages/adapters/claude` was nested under `packages/adapters/` even though agent harnesses (Claude, and soon Codex and AGY) are a top-level architectural layer alongside `apps/` and `packages/`.

## Decision

1. **Remove `packages/acp` and import `@agentclientprotocol/sdk/experimental/v2` directly.** Keep single-place exact version pinning via root `package.json`'s `workspaces.catalog` (`"@agentclientprotocol/sdk": "2.7.0"`), enforced by `scripts/check.ts` (every workspace manifest must use `"catalog:"`, root catalog must pin an exact semver, and source imports may only target `@agentclientprotocol/sdk/experimental/v2`, rejecting `unstable` and v1 paths). Move the ACP v2 upgrade tripwire test into `packages/protocol/test/acp.test.ts`.
2. **Merge `packages/daemon` into `apps/daemon` as `@cycle/daemon`.** Keep `apps/daemon` as the single package for both daemon internals and the `cycle` executable/CLI, while continuing to export the library surface (`Daemon`, `listenUnix`, etc.) for `packages/client` and `apps/desktop` tests.
3. **Split and remove `packages/transport`.** Move the Bun server half (`server.ts`, `socket-adapter.ts`) into `apps/daemon/src/transport/` and the Node client half (`client.ts`, `Channel`) into `packages/client/src/transport.ts`.
4. **Move `packages/adapters/*` to top-level `harness/*`** (`packages/adapters/claude` → `harness/claude`, renamed `@cycle/harness-claude`) to house Claude alongside upcoming Codex and AGY harnesses.

## Alternatives considered

- **Keep `packages/acp` or merge it as `@cycle/protocol/acp`**: Rejected by the user because an 8-line re-export package adds workspace indirection without solving schema divergence; Bun's workspace `catalog` plus `scripts/check.ts` already enforce single-place version pinning and block `unstable` imports.
- **Flatten `packages/adapters/claude` into `packages/adapter-claude`**: Rejected by the user because Codex and AGY harnesses are coming next; a dedicated top-level `harness/` directory cleanly separates agent harnesses from shared libraries (`packages/`) and runnable apps (`apps/`).

## Consequences

- Workspace count drops from 10 to 7 (`packages/{protocol,client,analytics,ui}`, `harness/claude`, `apps/{daemon,desktop}`), unused runtime dependencies (`@cycle/acp` in `packages/protocol`, `@cycle/protocol` in `apps/desktop`) are removed, and `@agentclientprotocol/sdk` is placed in `packages/protocol`'s `devDependencies` for the relocated `packages/protocol/test/acp.test.ts`.
- `scripts/check.ts` no longer needs per-file exceptions for `packages/transport/src/client.ts`; `packages/client/src/`, `packages/protocol/src/`, and `packages/analytics/src/` are uniformly checked as Node-only.
- Because `packages/client` dev-depends on `apps/daemon` (which depends on `harness/claude`), `scripts/integration-plan.ts` now conservatively selects `node` in addition to the other 5 suites (`adapter`, `ssh`, `backend`, `package`, `smoke`) when `harness/claude` changes.
- Upgrading `@agentclientprotocol/sdk` if its subpath changes from `experimental/v2` will touch call sites across the repo instead of one re-export file, though it remains a mechanical find-and-replace guarded by `scripts/check.ts`.

## Related

- Partially replaces the packaging mechanism (re-exporting via `packages/acp`) recorded in historical [docs/decisions/0005-acp-v2.md](../../docs/decisions/0005-acp-v2.md); the core decision in 0005 (L1 modeled on ACP v2 stable set, exact pinned SDK version, Cycle extensions in `@cycle/protocol`) remains in force.
- The bullet in Consequences about `scripts/integration-plan.ts` selecting suites is replaced by [integration runs every suite](2026-11-21-integration-runs-every-suite.md): every suite now runs on every PR.
