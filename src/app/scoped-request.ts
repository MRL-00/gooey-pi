export interface ScopedRequest {
  id: number
  generation: number
  path?: string
}

export interface ScopedRequestGuard {
  begin(generation: number, path?: string): ScopedRequest
  invalidate(): void
  isCurrent(request: ScopedRequest, generation: number, path?: string): boolean
}

/** Monotonic admission for async reads whose result belongs to one workspace scope. */
export function createScopedRequestGuard(): ScopedRequestGuard {
  let latestId = 0
  return {
    begin: (generation, path) => ({ id: ++latestId, generation, path }),
    invalidate: () => { latestId += 1 },
    isCurrent: (request, generation, path) => request.id === latestId
      && request.generation === generation
      && request.path === path,
  }
}
