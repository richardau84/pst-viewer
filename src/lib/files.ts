export const ACCEPTED_EXTENSIONS = ['.pst', '.ost', '.msg', '.eml', '.zip'] as const
export const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(',')

export function isAcceptedFile(name: string): boolean {
  const lower = name.toLowerCase()
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function filterAccepted(files: FileList | File[]): File[] {
  return Array.from(files).filter((f) => isAcceptedFile(f.name))
}

/** Whether a drag event is carrying files (vs. text/elements). */
export function dragHasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

/** Only a real single PST/OST gets a persistable file handle — `.msg`/`.eml`
 *  batches and zip-extracted files have no single stable identity to hold a
 *  handle for (see `src/lib/zip.ts`: extracted files are synthetic, in-memory
 *  `File`s from fflate). */
export function isPersistableName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.pst') || lower.endsWith('.ost')
}

/** `showOpenFilePicker`/`getAsFileSystemHandle`/`crypto.subtle` are all
 *  Chromium-only and secure-context-gated; feature-detect once and reuse. */
export const FSA_SUPPORTED =
  typeof window !== 'undefined' &&
  typeof indexedDB !== 'undefined' &&
  typeof crypto !== 'undefined' &&
  !!crypto.subtle &&
  'showOpenFilePicker' in window

/** Picker `types` filter covering every format this app opens. Handles for
 *  the non-PST/OST results (`.msg`/`.eml`/`.zip`) are simply not kept — see
 *  `isPersistableName`. */
export const PICKER_TYPES: FilePickerAcceptType[] = [
  {
    description: 'Outlook mailbox / message files',
    accept: {
      'application/octet-stream': ['.pst', '.ost', '.msg', '.zip'],
      'message/rfc822': ['.eml'],
    },
  },
]

/** `{ size, lastModified }` off a `File`, used identically by the main thread
 *  and the worker as the cache-validity fingerprint: a mismatch (including
 *  Outlook compacting/repairing the file) means "reindex from scratch." */
export function fingerprint(file: File): { size: number; lastModified: number } {
  return { size: file.size, lastModified: file.lastModified }
}

/**
 * Identity-derived id for a persistable source: `hex(sha256("pst:" + name +
 * "|" + size + "|" + lastModified))`, hashed over the small metadata string
 * only (never the file content — hashing a multi-GB file would defeat the
 * random-access reads `makeReader`/`ReadFileApi` depend on for opening huge
 * files quickly). Dropping the same file again always reproduces the same
 * id, so it hits the same cached search index instead of minting a
 * duplicate; a random id would silently orphan the old cache on every
 * re-drop.
 */
export async function sourceKey(file: File): Promise<string> {
  const data = new TextEncoder().encode(`pst:${file.name}|${file.size}|${file.lastModified}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
