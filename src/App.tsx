import { useEffect } from 'react'
import { AppShell } from './components/AppShell'
import { Tooltips } from './components/Tooltips'
import { pst } from './worker/client'
import { useApp } from './store/store'
import { FSA_SUPPORTED } from './lib/files'

/** Which source ids were open when the tab was last closing — the boot-time
 *  silent restore is bounded to just this set, not every remembered mailbox
 *  ever opened (an unbounded, surprising thing to do on a stray refresh:
 *  concurrent multi-GB opens + reindexes with no user gesture behind them).
 *  Everything else remembered is history: listed, but requires an explicit
 *  "Reconnect" click. */
const WAS_OPEN_KEY = 'pstviewer.wasOpen'

function readWasOpen(): string[] {
  try {
    const raw = localStorage.getItem(WAS_OPEN_KEY)
    const ids: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export default function App() {
  // Dev-only: expose the store + worker so we can drive the app from tests.
  useEffect(() => {
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>
      w.__app = useApp
      w.__pst = pst
    }
  }, [])

  // Warm up the parsing worker + Comlink pipeline early so the first file opens fast.
  useEffect(() => {
    void pst.ping()
  }, [])

  // Track which mailboxes are open, so a future boot can tell "what was open
  // when the tab went away" apart from the rest of the remembered history.
  useEffect(() => {
    if (!FSA_SUPPORTED) return
    const writeWasOpen = () => {
      try {
        const ids = useApp.getState().sources.map((s) => s.id)
        if (ids.length) localStorage.setItem(WAS_OPEN_KEY, JSON.stringify(ids))
        else localStorage.removeItem(WAS_OPEN_KEY)
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('beforeunload', writeWasOpen)
    document.addEventListener('visibilitychange', writeWasOpen)
    return () => {
      window.removeEventListener('beforeunload', writeWasOpen)
      document.removeEventListener('visibilitychange', writeWasOpen)
    }
  }, [])

  // Boot-time restore: load the remembered-mailbox list, then silently
  // reconnect (queryPermission only, never a prompt) just the ids that were
  // open when the tab last closed — sequentially, so the "pick the first
  // folder with messages" race in `selectFolder` (store.ts) resolves one
  // mailbox at a time instead of several folder-tree responses landing at
  // once. Each mailbox's own background indexing still runs concurrently
  // once its folder tree is ready.
  useEffect(() => {
    if (!FSA_SUPPORTED) return
    void (async () => {
      const { loadRemembered, reconnect } = useApp.getState()
      await loadRemembered()
      for (const id of readWasOpen()) {
        await reconnect(id)
      }
    })()
  }, [])

  return (
    <>
      <AppShell />
      <Tooltips />
    </>
  )
}
