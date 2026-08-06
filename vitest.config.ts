import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: [
        'electron/main/{browser-downloads,git,jsonl,plugins,process-utils,projects,sessions,settings-schedules,store,terminal,validation}.ts',
        'electron/main/agent-rpc/**/*.ts',
        'electron/main/sessions/**/*.ts',
        'src/lib/{events,extension-ui,render-bounds,workspace}.ts',
        'scripts/release/lib.mjs',
      ],
      reporter: ['text', 'html', 'json-summary'],
      thresholds: {
        statements: 65,
        branches: 50,
        functions: 70,
        lines: 75,
      },
    },
  },
})
