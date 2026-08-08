import type { PrimeModelCatalog, PrimeModelDescriptor } from '../../src/types/api'
import type { PrimeProviderService } from './providers'

/**
 * The model-catalog surface shared by every agent harness provider service.
 *
 * This captures exactly what the two consumers use today:
 * - `AgentRpcManager` calls `requireAvailableModel` (start options and
 *   `set_model` validation) and `capabilities` (runtime capability decoration
 *   after model or thinking changes).
 * - The `providers:catalog` IPC handler calls `catalog(force, disabledProviders)`.
 *
 * Auth mutations (API keys, logout, OAuth flows) are intentionally excluded:
 * the manager never touches them and they are Prime-specific — OMP
 * authentication is owned by the omp CLI itself.
 */
export interface ModelCatalogProvider {
  catalog(force?: boolean, disabledProviders?: ReadonlySet<string>): Promise<PrimeModelCatalog>
  requireAvailableModel(rawKey: unknown, disabledProviders?: ReadonlySet<string>): Promise<PrimeModelDescriptor>
  capabilities(provider: string | undefined, modelId: string | undefined): Promise<PrimeModelDescriptor | undefined>
}

/**
 * Compile-time proof that PrimeProviderService structurally satisfies the
 * shared surface without editing providers.ts. Harness wiring can use this to
 * hand either service to catalog consumers.
 */
export const asModelCatalogProvider = (service: PrimeProviderService): ModelCatalogProvider => service
