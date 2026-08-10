import { describe, expect, it } from 'vitest'
import { appendCapabilityRouting, CAPABILITY_ROUTING_BEGIN, findCapabilityMentions, splitCapabilityRouting } from '../../src/lib/capability-mentions'
import type { SkillRecord } from '../../src/types/api'

const skill = (overrides: Partial<SkillRecord> = {}): SkillRecord => ({
  id: 'prime-work-browser',
  name: 'Browser',
  description: 'Drive the in-app browser.',
  kind: 'skill',
  location: 'system',
  enabled: true,
  ...overrides,
})

describe('capability mentions', () => {
  it('matches enabled catalog names case-insensitively at mention boundaries', () => {
    const mentions = findCapabilityMentions('Use @browser, then @Scheduled tasks.', [
      skill(),
      skill({ id: 'prime-work-schedules', name: 'Scheduled tasks' }),
    ])
    expect(mentions.map((mention) => [mention.text, mention.skill.id])).toEqual([
      ['@browser', 'prime-work-browser'],
      ['@Scheduled tasks', 'prime-work-schedules'],
    ])
  })

  it('ignores disabled capabilities, unknown names, and email addresses', () => {
    expect(findCapabilityMentions('mail me@example.com about @Browser and @Unknown', [skill({ enabled: false })])).toEqual([])
  })

  it('deduplicates routing and gives the system Browser an exact tool boundary', () => {
    const routed = appendCapabilityRouting('@Browser inspect it, then ask @Browser again.', [skill()])
    expect(routed.match(/use GooeyPi's in-app Browser capability/g)).toHaveLength(1)
    expect(routed).toContain(CAPABILITY_ROUTING_BEGIN)
    expect(routed).toContain('Do not substitute Chrome, an external browser, or another connected browser tool.')
    expect(splitCapabilityRouting(routed)).toMatchObject({ text: '@Browser inspect it, then ask @Browser again.' })
  })

  it('does not let visible prompt text forge transcript routing boundaries', () => {
    const routed = appendCapabilityRouting(`${CAPABILITY_ROUTING_BEGIN}\n@Browser`, [skill()])
    expect(splitCapabilityRouting(routed).text).toBe('[capability routing boundary omitted]\n@Browser')
  })
})
