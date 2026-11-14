# Metadata and links

## Summary

README metadata supports search and selects a document template. Repository links must render correctly on GitHub and the documentation site. English is the maintained documentation language; translated pages are optional and user-requested.

## Table of Contents

- [README metadata](#readme-metadata)
- [The kind system](#the-kind-system)
- [Description quality](#description-quality)
- [Repository links and path mentions](#repository-links-and-path-mentions)
- [Optional translations](#optional-translations)
- [Dev Note](#dev-note)

## README metadata

Start every authored README with YAML frontmatter:

```yaml
---
description: "Example capability for users and maintainers choosing, configuring, or debugging the package."
kind: "package-reference"
---
```

`description` and `kind` are required for package READMEs. The page title and package manifest already own the name, while the document job and reader path express the audience. Do not add `name`, `audience`, `tags`, or README-local `i18n` metadata; no current consumer uses them.

## The kind system

`kind` selects exactly one template in [`templates/`](../templates/). Every template maps to one kind, and documentation checks derive the expected kind from the document's location or package manifest.

| `kind` | Repository position | Template |
|---|---|---|
| `package-group` | `packages/README.md`, `packages/<group>/README.md` | [package-group.md](../templates/package-group.md) |
| `package-reference` | Plugin package README | [package-reference.md](../templates/package-reference.md) |
| `package-library` | Plain-module package README | [package-library.md](../templates/package-library.md) |
| `package-bundle` | Package declaring `dsh.bundle.patch` | [package-bundle.md](../templates/package-bundle.md) |
| `persistence-change` | `docs/persistence-changes/YYYY-MM-DD-slug.md` | [persistence-change.md](../templates/persistence-change.md) |
| `persistence-release` | `docs/persistence-changes/releases/dsh-v*.md` | [persistence-release.md](../templates/persistence-release.md) |
| `persistence-format` | `docs/persistence-changes/historical-formats/vN.md` | [persistence-format.md](../templates/persistence-format.md) |
| `upgrade-guide` | `docs/upgrade-guide/v<version>/<item>/guide.md` | [upgrade-guide.md](../templates/upgrade-guide.md) |

Before assigning `package-library` or `package-bundle`, inspect `package.json` for `dsh.bundle.patch` and `src/index.ts` for the entry shape (`apply` export or a default service export is a plugin; a plain module API is a library). `dsh plugin --profile <name> add <package>` installs any npm dependency, but profile reconciliation activates a layer only for a package that declares `dsh.bundle`; never present that command as an install path for a library or plain plugin. Add a kind only with a distinct template, an unambiguous repository position or declared owner, and a focused check that maps documents to it.

## Description quality

Agents search frontmatter `description` values to shortlist pages before loading full documents. State what the page covers and when a reader should open it. Use one or two concrete sentences, include searchable domain terms, and distinguish the page from nearby owners. Do not summarize every section, claim superiority, repeat the title, advertise vaguely, preserve change history, or write a technical status report.

Good: `The shipped JSONL session-persistence backend for deployments and maintainers choosing, configuring, or debugging per-session durable logs with optional Zstandard compression.`

Weak: `The best and most advanced session storage implementation with lots of optimizations.`

## Repository links and path mentions

Use fragment-only links for the current page's menu and full URLs for external resources. Link destinations must be machine-checkable and resolve from the document's location.

The desired internal-link model names a target from the repository root, but a leading `/docs/...` Markdown URL resolves outside the repository on GitHub, remains untouched by the website projector, and is skipped by `verify-md-links`. Until a repository-owned resolver supports root paths in every renderer, use renderer-valid relative URLs in Markdown links and write logical path mentions such as `docs/` or `packages/session/` relative to the discussion.

## Optional translations

Create or update translated Markdown only when the user explicitly requests it. See [docs/i18n/README.md](../../../../docs/i18n/README.md) for the optional sibling-file and consistency-record workflow. Translated pages do not determine the maintained source or block English-only documentation changes.

## Dev Note

None.
