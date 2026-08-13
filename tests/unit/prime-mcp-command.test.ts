import { describe, expect, it } from 'vitest'
import { parsePrimeMcpCommand } from '../../src/hooks/useWorkspaceActions'

describe('Prime MCP slash command routing', () => {
  it('opens Capabilities for the bare command', () => {
    expect(parsePrimeMcpCommand(' /mcp ')).toEqual({ type: 'open' })
  })

  it('extracts a bounded MCP login target', () => {
    expect(parsePrimeMcpCommand('/mcp login notion')).toEqual({ type: 'login', server: 'notion' })
    expect(parsePrimeMcpCommand('/mcp   login   team docs')).toEqual({ type: 'login', server: 'team docs' })
  })

  it('leaves unsupported MCP commands and unsafe targets to the normal prompt path', () => {
    expect(parsePrimeMcpCommand('/mcp list')).toBeUndefined()
    expect(parsePrimeMcpCommand('/mcp login ../notion')).toBeUndefined()
    expect(parsePrimeMcpCommand('/mcp login __proto__')).toBeUndefined()
  })
})
