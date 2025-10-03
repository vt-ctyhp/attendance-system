export interface BootstrapData {
  baseUrl: string;
  deviceId: string;
  platform: string;
  presenceUiMode?: 'overlay' | 'popup' | 'both';
  presenceEnabled?: boolean;
}

export interface SystemStatus {
  idleSeconds: number;
  foregroundApp: {
    title: string | null;
    owner: string | null;
  } | null;
}

export interface AppSettings {
  deviceId: string;
  serverBaseUrl: string;
  workEmail: string | null;
}

export interface QueueItem {
  path: string;
  method?: 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  requiresAuth?: boolean;
  description?: string;
  tokenOverride?: string | null;
  attempt: number;
  nextAttemptAt: number;
}

export interface PresencePromptPayload {
  id: string;
  expiresAt: string;
  message?: string;
}

export interface AttendanceApi {
  logAction: (action: string) => void;
  getBootstrap: () => Promise<BootstrapData>;
  getSystemStatus: () => Promise<SystemStatus>;
  getSettings: () => Promise<AppSettings>;
  updateSettings: (settings: { serverBaseUrl: string; workEmail: string | null }) => Promise<AppSettings>;
  testServerUrl: (url: string) => Promise<{ ok: boolean; status?: number; url?: string }>;
  loadOfflineQueue: () => Promise<QueueItem[]>;
  saveOfflineQueue: (queue: QueueItem[]) => Promise<unknown>;
  clearOfflineQueue: () => Promise<unknown>;
  openPresencePrompt: (prompt: PresencePromptPayload) => void;
  closePresencePrompt: (promptId: string) => void;
  onPresenceWindowConfirm: (handler: (promptId: string) => void) => () => void;
  onPresenceWindowDismiss: (handler: (promptId: string) => void) => () => void;
}

export interface PresenceWindowApi {
  initialize: () => void;
  setPrompt: (prompt: PresencePromptPayload) => void;
  disable: () => void;
}

declare global {
  interface Window {
    attendance: AttendanceApi;
    attendancePresence: PresenceWindowApi;
  }
}

export {};
