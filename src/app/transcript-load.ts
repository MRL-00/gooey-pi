export interface TranscriptReadLifecycle<Value> {
  read(): Promise<Value>
  isCurrent(): boolean
  onValue(value: Value): void
  onError(error: unknown): void
  onFinally(): void
}

/** One promise lifecycle for initial reads and authoritative reconciliations. */
export async function runTranscriptRead<Value>(lifecycle: TranscriptReadLifecycle<Value>): Promise<void> {
  try {
    const value = await lifecycle.read()
    if (lifecycle.isCurrent()) lifecycle.onValue(value)
  } catch (error) {
    if (lifecycle.isCurrent()) lifecycle.onError(error)
  } finally {
    lifecycle.onFinally()
  }
}
