import { useRef, type ChangeEvent } from 'react'
import { useApp } from '../store/store'
import { ACCEPT_ATTR, FSA_SUPPORTED, PICKER_TYPES, filterAccepted, isPersistableName } from '../lib/files'
import { RememberedList } from './RememberedList'
import { AboutContent } from './About'

export function DropZone() {
  const addFiles = useApp((s) => s.addFiles)
  const fileInput = useRef<HTMLInputElement>(null)

  const onPicked = (e: ChangeEvent<HTMLInputElement>) => {
    const accepted = filterAccepted(e.target.files ?? [])
    if (accepted.length) addFiles(accepted)
    e.target.value = '' // allow re-picking the same file
  }

  const onBrowse = async () => {
    if (FSA_SUPPORTED) {
      try {
        const picked = await window.showOpenFilePicker({
          types: PICKER_TYPES,
          multiple: true,
          excludeAcceptAllOption: true,
        })
        const files: File[] = []
        const handles: (FileSystemFileHandle | undefined)[] = []
        for (const handle of picked) {
          const file = await handle.getFile()
          files.push(file)
          handles.push(isPersistableName(file.name) ? handle : undefined)
        }
        if (files.length) addFiles(files, handles)
        return
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return // user cancelled
        // Anything else (blocked by policy, etc.): fall back to the classic input.
      }
    }
    fileInput.current?.click()
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 p-8">
      <button
        type="button"
        onClick={() => void onBrowse()}
        className="group flex min-h-[22rem] w-full max-w-xl flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-700 bg-slate-900/40 p-12 text-center shadow-2xl transition hover:border-sky-500/60 hover:bg-slate-900/70 focus:outline-none focus-visible:border-sky-500"
      >
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-800/80 transition group-hover:bg-slate-800">
          <svg viewBox="0 0 24 24" className="h-8 w-8 text-sky-400" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="m3 7 9 6 9-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <h1 className="text-2xl font-semibold text-slate-100">Open your mailbox</h1>
        <p className="mt-2 text-slate-400">
          Drag &amp; drop a{' '}
          <span className="font-medium text-slate-200">.pst</span>,{' '}
          <span className="font-medium text-slate-200">.ost</span>,{' '}
          <span className="font-medium text-slate-200">.msg</span>,{' '}
          <span className="font-medium text-slate-200">.eml</span>, or{' '}
          <span className="font-medium text-slate-200">.zip</span> file, or click to browse
        </p>

        <span className="mt-7 inline-block rounded-lg bg-sky-500 px-6 py-2.5 font-medium text-white transition group-hover:bg-sky-400">
          Browse files
        </span>
      </button>

      <div className="w-full max-w-xl rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-xs text-slate-400">
        <AboutContent />
      </div>

      <div className="w-full max-w-xl">
        <RememberedList />
      </div>

      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT_ATTR}
        multiple
        hidden
        onChange={onPicked}
      />
    </div>
  )
}
