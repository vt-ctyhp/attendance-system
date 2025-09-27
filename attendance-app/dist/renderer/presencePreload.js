"use strict";
/// <reference lib="dom" />
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
let currentPrompt = null;
let messageEl = null;
let confirmBtn = null;
let dismissBtn = null;
const updateMessage = () => {
    if (!messageEl || !currentPrompt) {
        return;
    }
    messageEl.textContent = currentPrompt.message ?? 'Please confirm your presence.';
};
const disableUi = () => {
    confirmBtn?.setAttribute('disabled', 'true');
    dismissBtn?.setAttribute('disabled', 'true');
};
const enableUi = () => {
    confirmBtn?.removeAttribute('disabled');
    dismissBtn?.removeAttribute('disabled');
};
electron_1.ipcRenderer.on('attendance:presence-window-data', (_event, prompt) => {
    currentPrompt = prompt;
    enableUi();
    updateMessage();
});
electron_1.ipcRenderer.on('attendance:presence-window-disable', () => {
    disableUi();
});
electron_1.contextBridge.exposeInMainWorld('attendancePresence', {
    initialize: () => {
        messageEl = document.getElementById('presence-message');
        confirmBtn = document.getElementById('presence-confirm');
        dismissBtn = document.getElementById('presence-dismiss');
        confirmBtn?.addEventListener('click', () => {
            if (!currentPrompt) {
                return;
            }
            disableUi();
            electron_1.ipcRenderer.send('attendance:presence-window-confirm', currentPrompt.id);
        });
        dismissBtn?.addEventListener('click', () => {
            if (!currentPrompt) {
                return;
            }
            disableUi();
            electron_1.ipcRenderer.send('attendance:presence-window-dismiss', currentPrompt.id);
        });
        electron_1.ipcRenderer.send('attendance:presence-window-ready');
    },
    setPrompt: (prompt) => {
        currentPrompt = prompt;
        enableUi();
        updateMessage();
    },
    disable: () => {
        disableUi();
    }
});
