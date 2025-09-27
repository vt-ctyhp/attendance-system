import { contextBridge, ipcRenderer } from 'electron';

type Listener<T> = (payload: T) => void;

type PresencePromptPayload = {
  id: string;
  expiresAt: string;
  message?: string;
};

const register = <T>(channel: string, handler: Listener<T>) => {
  const subscription = (_event: unknown, payload: T) => handler(payload);
  ipcRenderer.on(channel, subscription);
  return () => ipcRenderer.removeListener(channel, subscription);
};

contextBridge.exposeInMainWorld('attendance', {
  logAction: (action: string) => {
    ipcRenderer.send('attendance-action', action);
  },
  getBootstrap: () => ipcRenderer.invoke('attendance:get-bootstrap'),
  getSystemStatus: () => ipcRenderer.invoke('attendance:get-system-status'),
  getSettings: () => ipcRenderer.invoke('attendance:get-settings'),
  updateSettings: (settings: { serverBaseUrl: string; workEmail: string | null }) =>
    ipcRenderer.invoke('attendance:update-settings', settings),
  testServerUrl: (url: string) => ipcRenderer.invoke('attendance:test-server-url', url),
  loadOfflineQueue: () => ipcRenderer.invoke('attendance:load-offline-queue'),
  saveOfflineQueue: (queue: unknown) => ipcRenderer.invoke('attendance:save-offline-queue', queue),
  clearOfflineQueue: () => ipcRenderer.invoke('attendance:clear-offline-queue'),
  openPresencePrompt: (prompt: PresencePromptPayload) => {
    ipcRenderer.send('attendance:presence-open', prompt);
  },
  closePresencePrompt: (promptId: string) => {
    ipcRenderer.send('attendance:presence-close', promptId);
  },
  onPresenceWindowConfirm: (handler: Listener<string>) => register('attendance:presence-window-confirm', handler),
  onPresenceWindowDismiss: (handler: Listener<string>) => register('attendance:presence-window-dismiss', handler)
});
