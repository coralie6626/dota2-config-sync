// The only bridge between the UI and the main process. Calls take account IDs,
// category names and plain options, never file paths or commands.

import { contextBridge, ipcRenderer } from 'electron';
import type { Api, GuideProgress } from './shared/types';

const api: Api = {
  listAccounts: () => ipcRenderer.invoke('listAccounts'),
  getDiff: (sourceId, targetId, categories) => ipcRenderer.invoke('getDiff', String(sourceId), String(targetId), [...categories].map(String)),
  push: (sourceId, targetIds, categories) =>
    ipcRenderer.invoke('push', String(sourceId), [...targetIds].map(String), [...categories].map(String)),
  restore: (backupId, accountId) => ipcRenderer.invoke('restore', String(backupId), String(accountId)),
  guideToolStatus: () => ipcRenderer.invoke('guideToolStatus'),
  importGuides: (targetIds, options) =>
    ipcRenderer.invoke('importGuides', [...targetIds].map(String), { replace: options?.replace === true }),
  cancelGuideImport: () => ipcRenderer.invoke('cancelGuideImport'),
  onGuideProgress: (cb) => {
    const listener = (_e: unknown, p: GuideProgress) => cb(p);
    ipcRenderer.on('guideProgress', listener);
    return () => {
      ipcRenderer.removeListener('guideProgress', listener);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
