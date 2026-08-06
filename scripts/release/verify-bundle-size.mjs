#!/usr/bin/env node
import { resolve } from 'node:path'
import { assertBundleSizeBudgets, collectBundleSizeMetrics, describeSizeMetrics } from './size-budgets.mjs'

try {
  const metrics = collectBundleSizeMetrics(resolve('out'))
  assertBundleSizeBudgets(metrics)
  console.log(`Bundle size budgets passed: ${describeSizeMetrics(metrics)}`)
} catch (error) {
  console.error(`Bundle size verification failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
