export interface RuntimeQueue<T> {
  put(runtimeId: string, value: T): T | undefined
  get(runtimeId: string): T | undefined
  delete(runtimeId: string): T | undefined
  values(): IterableIterator<T>
  clear(): void
}

/** Keeps one independently owned pending request for every runtime. */
export function createRuntimeQueue<T>(): RuntimeQueue<T> {
  const pending = new Map<string, T>()
  return {
    put(runtimeId, value) {
      const previous = pending.get(runtimeId)
      pending.set(runtimeId, value)
      return previous
    },
    get: (runtimeId) => pending.get(runtimeId),
    delete(runtimeId) {
      const previous = pending.get(runtimeId)
      pending.delete(runtimeId)
      return previous
    },
    values: () => pending.values(),
    clear: () => pending.clear(),
  }
}
