/**
 * Ambient augmentations for the parts of the File System Access API that
 * TypeScript's bundled `lib.dom.d.ts` doesn't ship (it already has
 * `FileSystemHandle`/`FileSystemFileHandle` themselves, just not the
 * permission-query extension or the file picker). Only what this app uses.
 *
 * Feature detection (not these types) is what actually gates behavior at
 * runtime — see `FSA_SUPPORTED` in `src/lib/files.ts`.
 */
export {}

declare global {
  interface FileSystemHandlePermissionDescriptor {
    mode?: 'read' | 'readwrite'
  }

  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
  }

  interface DataTransferItem {
    /** Chromium-only; feature-detect with `'getAsFileSystemHandle' in item`. */
    getAsFileSystemHandle(): Promise<FileSystemHandle | null>
  }

  interface FilePickerAcceptType {
    description?: string
    accept: Record<string, string | string[]>
  }

  interface OpenFilePickerOptions {
    types?: FilePickerAcceptType[]
    excludeAcceptAllOption?: boolean
    multiple?: boolean
  }

  interface Window {
    /** Chromium-only; feature-detect with `'showOpenFilePicker' in window`. */
    showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>
  }
}
