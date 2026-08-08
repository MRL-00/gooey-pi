/** The renderer's one way to turn an unknown thrown value into display text. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
