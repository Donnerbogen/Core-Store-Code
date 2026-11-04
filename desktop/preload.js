const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coreStore', {
  getInfo: () => ipcRenderer.invoke('app:get-info'),
  getPrograms: () => ipcRenderer.invoke('store:get-programs'),
  installProgram: id => ipcRenderer.invoke('store:install', id),
  startProgram: id => ipcRenderer.invoke('store:start', id),
  updateProgram: id => ipcRenderer.invoke('store:update-program', id),
  uninstallProgram: id => ipcRenderer.invoke('store:uninstall', id),
  checkStoreUpdate: () => ipcRenderer.invoke('store:check-update'),
  applyStoreUpdate: () => ipcRenderer.invoke('store:apply-update'),
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
  openProgramFolder: id => ipcRenderer.invoke('app:open-program-folder', id)
});
