import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  extendArchiveManifest,
  parseArchiveManifest,
  renderArchiveManifest,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
  type ArchiveManifest,
} from './archived-agent-notes.ts'
import { isArchivedAgentNotePath } from './repo-files.ts'

function fixture(): Map<string, Buffer> {
  return new Map([
    ['process/2026-07-26-example.md', Buffer.from('# Agent Note: Example\n\nStatus: implemented\nArchived: 2026-07-26\n\n## Problem\n\nExample.\n')],
  ])
}

describe('archived Agent Notes', () => {
  it('recognizes archived paths with POSIX and Windows separators', () => {
    expect(isArchivedAgentNotePath('.agents/notes/archived/process/example.md')).toBe(true)
    expect(isArchivedAgentNotePath('.agents\\notes\\archived\\process\\example.md')).toBe(true)
    expect(isArchivedAgentNotePath('.agents/notes/implemented/process/example.md')).toBe(false)
  })

  it('accepts one English implemented note with valid archive metadata', () => {
    expect(validateArchiveArtifacts(fixture())).toEqual([])
  })

  it.each([
    ['Status: proposed\nArchived: 2026-07-26', /requires `Status: implemented`/],
    ['Status: implemented\n\nArchived: 2026-07-26', /immediately after the status/],
    ['Status: implemented\nArchived: 2026-02-30', /valid date/],
    ['Status: implemented\nArchived: 2026-07-25', /predates the note filename/],
  ])('rejects invalid archive metadata: %s', (metadata, error) => {
    const artifacts = fixture()
    artifacts.set('process/2026-07-26-example.md', Buffer.from(`# Historical decision\n${metadata}\n`))
    expect(validateArchiveArtifacts(artifacts).join('\n')).toMatch(error)
  })

  it('rejects non-Markdown archived artifacts', () => {
    const artifacts = fixture()
    artifacts.set('process/2026-07-26-example.zh.md', Buffer.from('translation'))
    expect(validateArchiveArtifacts(artifacts).join('\n')).toContain('archived notes accept English Markdown files only')
  })

  it('extends the manifest without permitting a sealed change or removal', () => {
    const artifacts = fixture()
    const empty: ArchiveManifest = { version: 1, files: {} }
    const first = extendArchiveManifest(empty, artifacts)
    expect(first.errors).toEqual([])
    expect(first.added).toHaveLength(1)

    const sealed: ArchiveManifest = { version: 1, files: first.files }
    const changed = new Map(artifacts)
    changed.set('process/2026-07-26-example.md', Buffer.from('changed'))
    expect(extendArchiveManifest(sealed, changed).errors).toEqual([
      'process/2026-07-26-example.md: sealed content hash changed',
    ])
    changed.delete('process/2026-07-26-example.md')
    expect(extendArchiveManifest(sealed, changed).errors).toContain(
      'process/2026-07-26-example.md: sealed artifact is missing',
    )
  })

  it('allows only caller-authorized English content updates and rejects replacing unrelated seals', () => {
    const artifacts = fixture()
    const initial = extendArchiveManifest({ version: 1, files: {} }, artifacts)
    const baseline: ArchiveManifest = { version: 1, files: initial.files }
    const path = 'process/2026-07-26-example.md'
    const changedArtifacts = new Map(artifacts)
    changedArtifacts.set(path, Buffer.from('updated'))
    const allowed = new Set([path])
    const replacement = extendArchiveManifest(baseline, changedArtifacts, allowed)
    const current: ArchiveManifest = { version: 1, files: replacement.files }

    expect(replacement.errors).toEqual([])
    expect(validateArchiveManifestExtension(baseline, current, allowed)).toEqual([])
    expect(validateArchiveManifestExtension(baseline, current)).toEqual([`${path}: sealed manifest hash changed`])
    expect(validateArchiveManifestExtension(
      { version: 1, files: { 'process/other.md': initial.files[path] as string } },
      { version: 1, files: { 'process/other.md': current.files[path] as string } },
      allowed,
    )).toEqual(['process/other.md: sealed manifest hash changed'])
  })

  it('drops obsolete translation seals while preserving English seals', () => {
    const english = `sha256:${createHash('sha256').update('example').digest('hex')}`
    const baseline: ArchiveManifest = { version: 1, files: {
      'process/example.md': english,
      'process/example.zh.md': 'sha256:' + 'b'.repeat(64),
      'process/example.i18n.yaml': 'sha256:' + 'c'.repeat(64),
    } }
    const current: ArchiveManifest = { version: 1, files: { 'process/example.md': english } }
    expect(validateArchiveManifestExtension(baseline, current)).toEqual([])
    const extended = extendArchiveManifest(baseline, new Map([
      ['process/example.md', Buffer.from('example')],
    ]))
    expect(Object.keys(extended.files)).toEqual(['process/example.md'])
    expect(extended.errors).toEqual([])
  })

  it('round-trips the deterministic manifest schema', () => {
    const content = renderArchiveManifest({ 'process/z.md': `sha256:${'a'.repeat(64)}` })
    expect(parseArchiveManifest(content)).toEqual({
      version: 1,
      files: { 'process/z.md': `sha256:${'a'.repeat(64)}` },
    })
  })
})
