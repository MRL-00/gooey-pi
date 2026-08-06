#!/usr/bin/env node
import { assertSupportedNode, validateReleaseCredentials } from './lib.mjs'

try {
  assertSupportedNode()
  validateReleaseCredentials(process.env)
  console.log('Release preflight passed: Node, Developer ID, Team ID, and notarization credentials are present.')
} catch (error) {
  console.error(`Release preflight failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
