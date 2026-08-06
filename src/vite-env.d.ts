/// <reference types="vite/client" />
import type { PrimeWorkApi } from './types/api'
declare global { interface Window { prime: PrimeWorkApi } }
export {}
