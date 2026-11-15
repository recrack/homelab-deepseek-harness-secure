# Agent Note: Linux CI failover runbook

Status: implemented

## Problem

The pull-request verdict in [CI](../../../../.github/workflows/ci.yml) normally uses GitHub-hosted Linux runners. If that pool is unavailable, a repository writer can select another runner without merging a workflow change. The same Linux failover variable also selects runners for a small set of release rehearsals and optional jobs.

## Decision

**DSH_CI_FAILOVER_LINUX** is a repository Actions variable. For the required PR job, **github** selects **ubuntu-24.04**, **blacksmith** selects Blacksmith's 8-vCPU Linux runner, **selfhosted** selects the **vm-backup** pool for non-Dependabot PRs, and an unset or unrecognized value keeps **ubuntu-latest**. Other workflows use only the values they explicitly handle; see the [Blacksmith failover note](2026-09-09-blacksmith-failover-leg.md) for participating jobs.

The exhaustive Linux suite runs after pushes to master on the dedicated **serial-linux-selfhosted** lane. It is a persistent standby check and does not depend on this variable. The keyless Python suites and benchmark jobs also run after merge. GitHub Actions does not schedule Windows or Wine tests; native Windows release builds remain on hosted Windows runners.

### Switch runners

1. In repository **Settings → Secrets and variables → Actions → Variables**, set **DSH_CI_FAILOVER_LINUX** to **github**, **selfhosted**, or **blacksmith** as needed.
2. Start a new workflow run or push a commit so the runner expression is evaluated again; already queued jobs do not change runners.
3. After the pool recovers, delete the variable to return to each workflow's default, or set a different supported value.

The **selfhosted** route executes PR code on a persistent machine and excludes Dependabot. Use it only when every PR that can reach the repository is trusted; public repositories should use ephemeral GitHub-hosted or Blacksmith runners. The writer-managed variable selects a runner but does not establish trust.

### In-house runner

**vm-backup** is one shared Linux VM with multiple systemd-managed runner instances, so registrations add scheduling slots rather than CPU or memory. The image must include the Linux packages needed by Playwright Chromium and WebKit; workflows download the lockfile-selected browsers and do not install system packages on this persistent host. Check the latest **serial-linux-selfhosted** result before relying on the pool.

The release rehearsal workflows may also use **vm-backup** for eligible, credential-free same-repository PRs and master pushes when the variable is **selfhosted**. Their publication jobs stay hosted. Distinct refs can add concurrent load, so check host capacity before leaving the variable set during an incident.

## Alternatives considered

**Change runner labels in a workflow.** Rejected because a runner outage can block the PR needed to change the workflow. Repository variables can select a runner without a merge.

**Always require the in-house pool.** Rejected because it makes the VM a single point of failure. Hosted runners remain the default, and the variable is a reversible fallback.

## Consequences

The failover remains available without a workflow merge, while hosted runners remain the default. Self-hosted routing is limited to trusted work because PR code runs on the persistent VM.
