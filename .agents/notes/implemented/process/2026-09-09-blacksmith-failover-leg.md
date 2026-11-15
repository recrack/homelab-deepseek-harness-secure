# Agent Note: Blacksmith as an opt-in Linux CI failover

Status: implemented

## Problem

Replacing runner labels wholesale would send unrelated, credential-bearing, or host-capability jobs to third-party infrastructure and could change benchmark measurements. Blacksmith is useful as an explicit capacity option, but it should not become the default.

## Decision

**DSH_CI_FAILOVER_LINUX=blacksmith** selects Blacksmith only in workflows with an explicit Linux branch. Current users are the quick PR verdict in [ci.yml](../../../../.github/workflows/ci.yml), the supported Linux rows in the manual benchmark matrices in [ci-master.yml](../../../../.github/workflows/ci-master.yml), the bwrap sandbox job, expected-filename validation, Linux x64 Python runtime CI, and the credential-free dsh release rehearsal. Each workflow pins its runner size; jobs without an explicit branch retain their declared runner.

Blacksmith is an ephemeral runner, so the self-hosted persistent-machine exclusion for Dependabot does not apply to its branch. The master Linux reference suite remains on **vm-backup**. The automated post-merge benchmark job remains on **ubuntu-24.04**. Windows and Wine tests are not scheduled by GitHub Actions, and the Windows Python release target remains on **windows-2025** without a Blacksmith branch.

The variable is writer-managed repository state. Setting it does not require a merge, but only new or rerun jobs evaluate the changed runner selector. See the [Linux failover runbook](2026-07-26-ci-failover-runbook.md) for switch and trust guidance.

## Alternatives considered

**Replace every runner label with a Blacksmith label.** Rejected because it changes benchmark environments and moves jobs with credentials or special host requirements.

**Use Blacksmith as the default.** Rejected because the existing hosted and self-hosted routes remain available, while Blacksmith adds cost and should be an explicit capacity choice.

## Consequences

Only jobs with an explicit Blacksmith branch can move when the variable is set. Workflow specs pin these selectors so a later edit cannot silently broaden the runner set.
