import { openStore, type Store } from '@helm/core'
import { dbFile } from './paths.ts'

/**
 * Opened per use rather than held. Every Helm action is a fresh process, and a
 * `helm launch` lives as long as its `claude` does - hours - so the wrapper
 * writes its row, closes, and reopens once to record the exit rather than
 * keeping a handle on the shared database the whole time.
 */
export function withStore<T>(fn: (store: Store) => T): T {
  const store = openStore({ file: dbFile() })
  try {
    return fn(store)
  } finally {
    store.close()
  }
}
