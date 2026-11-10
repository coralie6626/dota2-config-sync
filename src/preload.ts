// The only bridge between the UI and the main process: four functions,
// taking account IDs and category names, never file paths.

import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from './shared/types';

const api: Api = {
  listAccounts: () => ipcRenderer.invoke('listAccounts'),
  getDiff: (sourceId, targetId, categories) => ipcRenderer.invoke('getDiff', String(sourceId), String(targetId), [...categories].map(String)),
  push: (sourceId, targetIds, categories) =>
    ipcRenderer.invoke('push', String(sourceId), [...targetIds].map(String), [...categories].map(String)),
  restore: (backupId, accountId) => ipcRenderer.invoke('restore', String(backupId), String(accountId)),
};

contextBridge.exposeInMainWorld('api', api);
