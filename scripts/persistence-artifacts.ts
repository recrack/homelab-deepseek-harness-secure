/** Render English persistence documentation without writing files. */

/** One repository-relative generated file and its complete UTF-8 content. */
export interface PersistenceArtifact {
  readonly path: string
  readonly content: string
}

/**
 * Describe one generated English Markdown document.
 * @param source - Repository-relative document path.
 * @param content - Complete document content.
 * @returns The document as an artifact for the owning generator.
 */
export function renderPersistenceDocument(source: string, content: string): PersistenceArtifact[] {
  return [{ path: source, content }]
}
