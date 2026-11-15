# Agent Note: Keep pull-request CI quick and run long checks after merge

Status: implemented

## Problem

The required pull-request checks included long coverage, snapshot, benchmark, Python runtime, and Windows jobs. These jobs delayed the merge of a fork maintained with a deliberately smaller review and test budget.

## Decision

GitHub Actions pull-request CI in `ci.yml` runs Linux typecheck, lint, and documentation checks. It does not run unit tests, snapshots, coverage, benchmarks, Python runtime builds, or Windows tests.

After a push to `master`, `ci-master.yml` runs the exhaustive Linux Node suite and a separate Linux benchmark job. `ci-python.yml` runs the keyless Python SDK suite and Linux x64 runtime checks; `ci-master.yml` also builds Linux ARM64 and both macOS Python runtimes. These checks receive no provider credentials. No Windows or Wine test lane runs automatically in GitHub Actions; the Python release workflow retains its Windows x64 build, and the separate manual Desktop packaging workflow remains available.

## Alternatives considered

**Keep long checks in the pull-request verdict.** Rejected because their runtime was delaying merges; this repository accepts reporting exhaustive Linux and Python failures after a change reaches `master`.

**Drop the exhaustive checks.** Rejected because coverage, snapshots, benchmarks, and installed Python behavior still need regular validation; moving them to master retains that signal.

**Keep automated Windows and Wine tests.** Rejected because their long jobs are outside the requested CI budget. The cost is that Windows regressions no longer receive an automatic GitHub Actions test signal; Windows artifacts remain part of release builds.

## Consequences

A Linux or Python regression can be reported after it has merged and reached `master`. Pull-request reviewers receive only typecheck, lint, and documentation results before merge. The previous cross-platform schedule and its runner rationale remain in the [archived serial CI reference](../../archived/process/2026-07-21-serial-cross-platform-ci-reference.md) and [archived Windows CI decision](../../archived/process/2026-08-08-native-windows-pull-request-ci.md).
