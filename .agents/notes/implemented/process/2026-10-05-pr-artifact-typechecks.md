# Agent Note: PR artifact builds and aggregate TypeScript checks

Status: implemented

## Problem

PR jobs need the same compiled packages for benchmarks, compatibility, packaging, and runtime checks. Building the repository-wide test and script programs in every artifact job repeats expensive diagnostics. In the allowed #3661 baseline, benchmark build preparation takes about 304 seconds before 432 seconds of serial measurements. A cold macOS arm64 Host compiler profile on Node 24.19.0 takes 84.01 seconds, including 55.92 seconds in the aggregate program; its 282 emitted projects take 24.33 seconds combined. Increasing concurrency consumes more shared-runner resources.

## Decision

Pull-request CI runs the public `typecheck` command, and the master Linux suite runs the complete repository build. Pull-request release rehearsals still use checked `build:artifacts`. [Node version ownership](2026-10-15-node-24-runtime-floor.md) and the [current CI schedule](2026-11-15-pr-minimum-post-merge-ci.md) own their respective policies.

Checked PR artifact builds compile every existing project reference from each compiler face with one serial `tsc -b` process, then run the ordinary Typert, bundling, Desktop, and Web stages. The helper reads the existing Host and Client aggregates rather than maintaining another package list. It omits only each root's additional test and script program; package diagnostics, emitted outputs, and Host-before-Client ordering remain required. Non-PR release and real-API workflow builds retain their normal checks. That artifact build is `pnpm run build:artifacts`; [the build split](2026-10-11-build-artifacts-check-split.md) owns its steps and scheduling.

Only the CI benchmark helper selects `tsc -b --noCheck` for package emission. Benchmarks consume JavaScript and Typert runtime metadata; their declaration and build-information files are disposable and never published. Typert analyzes source types independently, while required complete builds own semantic diagnostics. Syntax and configuration failures still reject benchmark preparation. TypeScript records pending checks so a later ordinary incremental build diagnoses the same source without deleting caches or forcing a rebuild. Public benchmark scripts and every release, Python, preview, compatibility, and normal artifact builder keep their checked defaults.

The Python executable builder selects `build:artifacts` artifact compilation with `--build-artifacts` after verifying its runtime closure. Invalid closure inputs fail before compilation, deployment, or packing; the default complete build and prebuilt `--skip-build` mode keep their existing stages.

Pull-request release rehearsals invoke the root manifest's `build:artifacts`; a PR that edits these root manifest scripts activates the separate native-addon platform matrix, a trade-off [the build split](2026-10-11-build-artifacts-check-split.md) records. The vendor rehearsal and post-merge benchmark job invoke the internal build helpers directly.

Benchmark sample counts stay fixed. Pull-request release rehearsals compile artifacts, while pull-request `typecheck` and the post-merge Linux suite own aggregate type diagnostics. The master benchmark job remains separate so measurements use an otherwise idle runner. The Linux x64 Python runtime starts after the master Python SDK suite succeeds; Linux ARM64 and both macOS runtimes run in the master workflow. Coverage partitions reuse compact file-cost metadata within their platform and runner pool. Parallel release packing uses pnpm's existing bounded scheduler; serial publication keeps family order.

Each Node version runs the same eight source compatibility specs in one serial Vitest invocation. Both file parallelism and the CLI worker limit are fixed to one, and the gate sets `VITEST_MAX_WORKERS=1` because that environment variable overrides Vitest's CLI limit. Files retain fork isolation; the build-backed Node 24.9 lazy-search smoke keeps its separate build dependency. The original seven-spec paired samples preserve all 253 assertion outcomes and reduce startup-only median time from 11.52 to 8.69 seconds, without increasing owned descendant-process peak.

## Alternatives considered

**Raise job or worker concurrency.** Rejected because the shared runner must keep its current resource ceiling.

**Remove aggregate checks from every build.** Rejected because package projects do not typecheck all repository tests and scripts; pull-request `typecheck` and the post-merge Linux suite retain those diagnostics.

**Cache compiled outputs across revisions.** Deferred because cache correctness and invalidation add obligations that removing duplicate aggregate work does not need.

## Consequences

The cold Host reference build takes 23.49 seconds with 1.91 GiB peak RSS, compared with 84.01 seconds and 3.87 GiB for the complete compiler pass. All 5,932 emitted files match by path and SHA-256. These are single local compiler samples, excluding bundling and tests; current-head CI owns the PR latency result. The benchmark scenarios and their budgets remain unchanged.

Three alternating cold preparation pairs on Apple M4 Pro / Node 24.19.0 compare checked reference compilation with benchmark-only emission: 61.16, 82.53, and 57.80 seconds versus 55.53, 50.82, and 50.75 seconds. Median preparation falls from 61.16 to 50.82 seconds (16.9%); this includes native support, libraries, benchmark workers, and Web assets, excluding dependency installation and measurements. Every pair has the same 11,894 output paths, including 3,181 byte-identical JavaScript files and unchanged source maps. The 356 build-information files differ, and nine declarations only reorder union members; those files are not published from the benchmark lane. Library-build median user CPU falls from 76.45 to 64.23 seconds, while median maximum RSS stays near 2.75 GiB. Required CI determines the complete PR timing.

Parallel packing relies on the pinned pnpm CLI to honor exact recursive filters, the pack destination, the workspace concurrency limit, and each package's lifecycle hooks. A pnpm upgrade must pass the real-CLI checks in `scripts/release/pack.spec.ts` before release packing adopts it.

Coverage weights sum Vitest's distinct environment, preparation, setup, collection, and execution costs. CI's platform/environment/pool cache prefixes exclude the previous `coverage-times-<run>` archives. Persistent local checkouts can retain wall-clock weights for files not measured during rollout; removing `.coverage-times.json` resets that history. These advisory weights affect partition assignment, while the complete inventory and merged coverage thresholds remain required.

The current pull-request and post-merge schedule is recorded in the [CI policy note](2026-11-15-pr-minimum-post-merge-ci.md).
