const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coreStore', {
  getInfo: () => ipcRenderer.invoke('app:get-info'),
  checkMaintenance: () => ipcRenderer.invoke('store:check-maintenance'),
  getPrograms: () => ipcRenderer.invoke('store:get-programs'),
  installProgram: id => ipcRenderer.invoke('store:install', id),
  startProgram: id => ipcRenderer.invoke('store:start', id),
  updateProgram: id => ipcRenderer.invoke('store:update-program', id),
  uninstallProgram: id => ipcRenderer.invoke('store:uninstall', id),
  checkStoreUpdate: () => ipcRenderer.invoke('store:check-update'),
  checkStoreUpdateForAction: () => ipcRenderer.invoke('store:check-update-for-action'),
  applyStoreUpdate: () => ipcRenderer.invoke('store:apply-update'),
  getUpdateFailure: () => ipcRenderer.invoke('store:get-update-failure'),
  acknowledgeUpdateFailure: () => ipcRenderer.invoke('store:acknowledge-update-failure'),
  openSupportWebsite: () => ipcRenderer.invoke('store:open-support-website'),
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
  openProgramFolder: id => ipcRenderer.invoke('app:open-program-folder', id)
});
