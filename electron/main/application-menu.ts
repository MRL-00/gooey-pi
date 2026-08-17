import { app, Menu, type MenuItemConstructorOptions } from 'electron'

interface ApplicationMenuOptions {
  checkForUpdates(): void
  closeWindow(): void
  platform?: NodeJS.Platform
  appName?: string
}

function updateMenuItem(checkForUpdates: () => void): MenuItemConstructorOptions {
  return {
    label: 'Check for Updates…',
    click: () => checkForUpdates(),
  }
}

export function buildApplicationMenuTemplate(options: ApplicationMenuOptions): MenuItemConstructorOptions[] {
  const platform = options.platform ?? process.platform
  const appName = options.appName ?? app.name
  const standardMenus: MenuItemConstructorOptions[] = [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]

  if (platform === 'darwin') {
    return [{
      label: appName,
      submenu: [
        { role: 'about' },
        updateMenuItem(options.checkForUpdates),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: `Quit ${appName}`, accelerator: 'CommandOrControl+Q', click: () => options.closeWindow() },
      ],
    }, ...standardMenus]
  }

  return [...standardMenus, {
    role: 'help',
    submenu: [updateMenuItem(options.checkForUpdates)],
  }]
}

export function installApplicationMenu(options: ApplicationMenuOptions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate(options)))
}
