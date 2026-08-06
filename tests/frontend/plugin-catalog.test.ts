import { describe, expect, it } from 'vitest'
import { createPluginCatalogAdmission } from '../../src/lib/plugin-catalog'

describe('plugin catalog request ownership', () => {
  it('rejects global and project results after a newer owning request', () => {
    const admission = createPluginCatalogAdmission()
    const globalRequest = admission.begin(0)
    const projectRequest = admission.begin(1, '/project-a')

    expect(admission.isCurrent(globalRequest, 1, '/project-a')).toBe(false)
    expect(admission.isCurrent(projectRequest, 1, '/project-a')).toBe(true)
    expect(admission.isCurrent(projectRequest, 2, '/project-b')).toBe(false)
  })

  it('allows only the latest refresh for the same project generation', () => {
    const admission = createPluginCatalogAdmission()
    const firstRefresh = admission.begin(4, '/project')
    const secondRefresh = admission.begin(4, '/project')

    expect(admission.isCurrent(firstRefresh, 4, '/project')).toBe(false)
    expect(admission.isCurrent(secondRefresh, 4, '/project')).toBe(true)
  })
})
