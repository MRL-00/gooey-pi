import { join, win32 } from 'node:path'

import type { HarnessId } from '../../src/types/api'

/**
 * Static description of one agent harness: how its executable is discovered
 * and where its agent state lives on disk. Discovery itself stays in
 * process-utils (`harnessExecutableCandidates`/`findHarnessExecutable`) so
 * every harness shares the same absolute-path and X_OK rules.
 */
export interface HarnessDescriptor {
  id: HarnessId
  productName: string
  agentName: string
  executableName: (platform: NodeJS.Platform) => string
  /** Environment override for the executable; only absolute paths are honored. */
  binaryEnvVar: string
  /** Directories under process.resourcesPath (as path segments) that may bundle the executable. */
  bundledResourceDirs: readonly (readonly string[])[]
  posixCandidateDirs: (home: string) => string[]
  windowsCandidateDirs: (env: NodeJS.ProcessEnv) => string[]
  agentDir: (home: string) => string
  sessionRoot: (home: string) => string
}

export const HARNESSES: Record<HarnessId, HarnessDescriptor> = {
  prime: {
    id: 'prime',
    productName: 'Prime Work',
    agentName: 'Prime Agent',
    executableName: (platform) => platform === 'win32' ? 'prime-agent.exe' : 'prime-agent',
    binaryEnvVar: 'PRIME_AGENT_BINARY',
    bundledResourceDirs: [['agent'], ['agent', 'bin']],
    posixCandidateDirs: (home) => ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin')],
    windowsCandidateDirs: (env) => env.LOCALAPPDATA ? [win32.join(env.LOCALAPPDATA, 'Programs', 'Prime Agent')] : [],
    agentDir: (home) => join(home, '.prime', 'agent'),
    sessionRoot: (home) => join(home, '.prime', 'agent', 'sessions'),
  },
  omp: {
    id: 'omp',
    productName: 'OMP Work',
    agentName: 'OMP',
    executableName: (platform) => platform === 'win32' ? 'omp.exe' : 'omp',
    binaryEnvVar: 'OMP_BINARY',
    bundledResourceDirs: [],
    posixCandidateDirs: (home) => [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'],
    windowsCandidateDirs: () => [],
    agentDir: (home) => join(home, '.omp', 'agent'),
    sessionRoot: (home) => join(home, '.omp', 'agent', 'sessions'),
  },
  pi: {
    id: 'pi',
    productName: 'Pi Work',
    agentName: 'Pi',
    executableName: (platform) => platform === 'win32' ? 'pi.exe' : 'pi',
    binaryEnvVar: 'PI_BINARY',
    bundledResourceDirs: [],
    posixCandidateDirs: (home) => [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'],
    windowsCandidateDirs: () => [],
    agentDir: (home) => join(home, '.pi', 'agent'),
    sessionRoot: (home) => join(home, '.pi', 'agent', 'sessions'),
  },
}
