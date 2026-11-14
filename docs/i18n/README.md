# Documentation languages

Repository Markdown is maintained in English. Create or update a translated document only when the user explicitly requests it.

## Optional translated documents

An explicitly requested Chinese translation uses a sibling `foo.zh.md` beside `foo.md` and a generated `foo.i18n.yaml` consistency record. Run `pnpm run verify-translation-pairing --write foo.md` to record it and `pnpm run verify-translation-pairing foo.md` to check it. English-only documents need neither artifact.

Follow [translation-rules.md](translation-rules.md) and [terminology.md](terminology.md) for requested translations. The extended [`dsh-translate-docs`](../../.agents/skills/dsh-translate-docs/SKILL.md) workflow runs only when the user names it.

The documentation site projects the English source into both locale route trees. Chinese navigation labels do not imply that translated page content exists.
