"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const register = (channel, handler) => {
    const subscription = (_event, payload) => handler(payload);
    electron_1.ipcRenderer.on(channel, subscription);
    return () => electron_1.ipcRenderer.removeListener(channel, subscription);
};
electron_1.contextBridge.exposeInMainWorld('attendance', {
    logAction: (action) => {
        electron_1.ipcRenderer.send('attendance-action', action);
    },
    getBootstrap: () => electron_1.ipcRenderer.invoke('attendance:get-bootstrap'),
    getSystemStatus: () => electron_1.ipcRenderer.invoke('attendance:get-system-status'),
    getSettings: () => electron_1.ipcRenderer.invoke('attendance:get-settings'),
    updateSettings: (settings) => electron_1.ipcRenderer.invoke('attendance:update-settings', settings),
    testServerUrl: (url) => electron_1.ipcRenderer.invoke('attendance:test-server-url', url),
    loadOfflineQueue: () => electron_1.ipcRenderer.invoke('attendance:load-offline-queue'),
    saveOfflineQueue: (queue) => electron_1.ipcRenderer.invoke('attendance:save-offline-queue', queue),
    clearOfflineQueue: () => electron_1.ipcRenderer.invoke('attendance:clear-offline-queue'),
    openPresencePrompt: (prompt) => {
        electron_1.ipcRenderer.send('attendance:presence-open', prompt);
    },
    closePresencePrompt: (promptId) => {
        electron_1.ipcRenderer.send('attendance:presence-close', promptId);
    },
    onPresenceWindowConfirm: (handler) => register('attendance:presence-window-confirm', handler),
    onPresenceWindowDismiss: (handler) => register('attendance:presence-window-dismiss', handler)
});
