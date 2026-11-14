# AGENTS.md — Archived Agent Notes

Archived Agent Notes are frozen English historical records, not current authority. Never edit, reformat, update, move, or delete a sealed note; use active notes or current documentation for new decisions and facts.

An archival change moves one implemented Markdown file to `archived/{kind}/`, retains `Status: implemented`, inserts `Archived: YYYY-MM-DD` immediately below it, and repairs or deletes inbound links. Run the [`dsh-archive-agent-notes`](../../skills/dsh-archive-agent-notes/SKILL.md) workflow and append new hashes with `pnpm run verify-archived-agent-notes --write`.

The archive verifier rejects changed or missing sealed notes, unknown kind folders, and invalid archive metadata. The one-time language-removal migration permits deleting old `.zh.md` and `.i18n.yaml` seals and permits an English note's exact language-switcher line to be removed; no other archived content change is accepted.
