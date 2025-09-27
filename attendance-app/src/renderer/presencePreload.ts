/// <reference lib="dom" />

import { contextBridge, ipcRenderer } from 'electron';

interface PresencePromptPayload {
  id: string;
  expiresAt: string;
  message?: string;
}

let currentPrompt: PresencePromptPayload | null = null;
let messageEl: HTMLParagraphElement | null = null;
let confirmBtn: HTMLButtonElement | null = null;
let dismissBtn: HTMLButtonElement | null = null;

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

ipcRenderer.on('attendance:presence-window-data', (_event, prompt: PresencePromptPayload) => {
  currentPrompt = prompt;
  enableUi();
  updateMessage();
});

ipcRenderer.on('attendance:presence-window-disable', () => {
  disableUi();
});

contextBridge.exposeInMainWorld('attendancePresence', {
  initialize: () => {
    messageEl = document.getElementById('presence-message') as HTMLParagraphElement | null;
    confirmBtn = document.getElementById('presence-confirm') as HTMLButtonElement | null;
    dismissBtn = document.getElementById('presence-dismiss') as HTMLButtonElement | null;

    confirmBtn?.addEventListener('click', () => {
      if (!currentPrompt) {
        return;
      }
      disableUi();
      ipcRenderer.send('attendance:presence-window-confirm', currentPrompt.id);
    });

    dismissBtn?.addEventListener('click', () => {
      if (!currentPrompt) {
        return;
      }
      disableUi();
      ipcRenderer.send('attendance:presence-window-dismiss', currentPrompt.id);
    });

    ipcRenderer.send('attendance:presence-window-ready');
  },
  setPrompt: (prompt: PresencePromptPayload) => {
    currentPrompt = prompt;
    enableUi();
    updateMessage();
  },
  disable: () => {
    disableUi();
  }
});
