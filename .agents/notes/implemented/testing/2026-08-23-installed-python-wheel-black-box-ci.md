# Agent Note: Installed-wheel Python runtime pull-request validation

Status: implemented

## Problem

The Python SDK unit suite drives fake peers, while installed-wheel checks exercise the runtime that users receive. A source checkout, editable install, mismatched SDK/runtime pair, broken native wheel, or platform-specific closure can therefore escape the keyless runtime evidence unless CI installs the published distributions into a clean environment.

## Decision

### Installed artifact boundary

The required Python runtime workflow builds the pure SDK wheel and each platform runtime wheel before behavior tests. Every native target installs those two local files into a new Python 3.10 virtual environment, changes to a temporary directory outside the repository, unsets `PYTHONPATH` and `DSH_RUNTIME_MODE`, and invokes only the public Python modules plus the packaged executable.

The black-box harness rejects a non-venv process, repository-relative working directory, source or editable import, unequal distribution versions, an SDK dependency that does not exactly pin the runtime version, an executable outside the installed runtime package, or an executable absent from the runtime distribution record. This installed-artifact identity check runs before the first agent request, so a behavior pass cannot conceal that the wrong code ran.

### Keyless behavior

Every target runs the complete packaged-runtime scenario set after installation. A local SSE model keeps outputs deterministic while the public SDK exercises the default SDK profile, ordered patch overlays, external bundle installation through `dsh plugin`, persistent PTY and editor behavior, PTC Node program and workflow execution, ripgrep-backed search, external stdio MCP discovery and execution, model-visible and durable snapshots, Zstandard persistence, direct JSON-RPC, and shutdown. A restart snapshot launches two complete SDK runtime processes against one persistence root and pins their isolated model histories, high-level results, and separate durable logs. The installed run replaces the source-SDK pre-wheel run; the executable and wheel are tested together once rather than maintaining two behavior inventories.

Linux additionally retains its manylinux 2.28 clean-install smoke and GLIBC checks. macOS retains deployment-target and native helper checks. These platform constraints supplement the common black-box behavior rather than substituting for it.

### Provider isolation

GitHub Actions CI runs only keyless Python SDK and installed-wheel scenarios. The runtime harness uses a local SSE model, so it needs no provider credential or live API request. Real-provider checks remain opt-in local diagnostics and are not part of the merge or post-merge workflow.

### Required targets

After a master push, `ci-python.yml` runs the keyless SDK suite and installed-wheel validation on Linux x64; `ci-master.yml` adds Linux ARM64 and both macOS architectures. No Windows runtime tests run in GitHub Actions. The Python release workflow retains the Windows x64 target, and the [sdk-runtime README](../../../../python/sdk-runtime/README.md) owns its PowerShell-specific behavior and snapshot.

## Existing decisions and supersession

This decision supersedes the single-target topology in the archived [required Python runtime pull-request validation](../../archived/testing/2026-08-12-required-python-runtime-pull-request-ci.md) while retaining its requirement that the real executable, snapshots, wheels, and clean installation meet in each selected target check. [docs/architecture.md](../../../../docs/architecture.md) owns the launched application and customization surface; the [single-file Python SDK runtime distribution](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md) remains authoritative for SEA packaging, native sidecars, wheel tags, and release artifacts.

## Alternatives considered

**Validate only Linux x64.** Rejected for automated post-merge checks because native addons, executable construction, wheel tags, and helper files differ across the other supported release targets. Windows runtime tests are omitted to keep GitHub Actions within its chosen schedule; release builds retain the Windows target.

**Run full behavior before wheel construction and keep two small installed smokes.** Rejected because that proves the executable against source imports, then proves too little through the distribution users install. The clean installed environment is the stronger common location for the same scenarios.

**Use a live provider in GitHub Actions.** Rejected because CI must remain credential-free and keyless runtime checks already prove installed-wheel behavior deterministically.

**Run the long installed-wheel matrix before merge.** Rejected because it delays pull-request merges; the keyless matrix runs after merge on master.

## Consequences

Master pushes pay for four keyless native executable and wheel builds plus deterministic installed-artifact scenarios. Failures are reported after merge, and Windows receives no automated runtime test signal in GitHub Actions. In exchange, the workflow validates the installed distributions on Linux x64, Linux ARM64, macOS ARM64, and macOS x64 without provider credentials.
