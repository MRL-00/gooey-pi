export interface PluginCatalogRequest {
  id: number
  workspaceGeneration: number
  projectPath?: string
}

export interface PluginCatalogAdmission {
  begin(workspaceGeneration: number, projectPath?: string): PluginCatalogRequest
  isCurrent(request: PluginCatalogRequest, workspaceGeneration: number, projectPath?: string): boolean
}

export function createPluginCatalogAdmission(): PluginCatalogAdmission {
  let latestRequestId = 0
  return {
    begin(workspaceGeneration, projectPath) {
      return { id: ++latestRequestId, workspaceGeneration, projectPath }
    },
    isCurrent(request, workspaceGeneration, projectPath) {
      return request.id === latestRequestId
        && request.workspaceGeneration === workspaceGeneration
        && request.projectPath === projectPath
    },
  }
}
