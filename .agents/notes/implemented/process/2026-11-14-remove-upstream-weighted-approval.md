# Agent Note: Remove upstream weighted approval from this repository

Status: implemented

## Problem

The inherited weighted approval workflow gives named upstream reviewers two points, other write-capable reviewers one point, and adds author credit from merged pull requests. Its special reviewer weights and production-code blame model describe the source project's review policy, not a review requirement defined for this repository.

## Decision

This repository does not publish or require weighted approval scores. Remove both weighted-approval workflows, the scoring and blame-classification source, the score workflow's App-token wiring, the test script and CI gates, and its English-only translation exclusion. Keep the separate `Policy` workflows and their App integration. If maintainers later need a local approval threshold, define it through this repository's GitHub review settings.

## Verification

The CI workflow spec checks that both publisher workflows, the scoring directory, the Python scorer integration, and the package test script are absent. The run-gates spec checks that no CI mode schedules the removed scoring suite.

## Alternatives considered

**Keep the inherited weights.** The named reviewers and production-code ownership model belong to the source project and do not define this repository's review requirements.

**Create a local weighted list.** That adds a custom score without a locally agreed reviewer model; GitHub's native review settings can express a required-approval threshold if one is needed.

## Consequences

After this change reaches the default branch, new pull requests no longer receive the `weighted approval` status or the `weighted approval decision` check run. Existing statuses remain attached to the commits that already received them.
