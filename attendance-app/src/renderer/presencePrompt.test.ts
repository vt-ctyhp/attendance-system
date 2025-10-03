/**
 * @vitest-environment jsdom
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const fixturePath = (relative: string) => {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, relative);
};

const template = readFileSync(fixturePath('index.html'), 'utf-8');

const installAttendanceStub = () => {
  const confirmHandlers: Array<(promptId: string) => void> = [];
  const dismissHandlers: Array<(promptId: string) => void> = [];

  const attendance = {
    onPresenceWindowConfirm: vi.fn().mockImplementation((handler: (promptId: string) => void) => {
      confirmHandlers.push(handler);
      return () => undefined;
    }),
    onPresenceWindowDismiss: vi.fn().mockImplementation((handler: (promptId: string) => void) => {
      dismissHandlers.push(handler);
      return () => undefined;
    }),
    openPresencePrompt: vi.fn(),
    closePresencePrompt: vi.fn(),
    logAction: vi.fn(),
    getBootstrap: vi.fn().mockResolvedValue({
      baseUrl: 'http://localhost:4000',
      deviceId: 'device-1',
      platform: 'test',
      presenceEnabled: true
    }),
    getSettings: vi.fn().mockResolvedValue({ serverBaseUrl: '', workEmail: null }),
    getSystemStatus: vi.fn().mockResolvedValue({ idleSeconds: 0, foregroundApp: null })
  };

  (window as typeof window & { attendance?: typeof attendance }).attendance = attendance;
  (window as typeof window & { attendancePresence?: unknown }).attendancePresence = undefined;

  return { attendance, confirmHandlers, dismissHandlers };
};

const ensureCrypto = () => {
  if (!globalThis.crypto?.randomUUID) {
    (globalThis as { crypto: Crypto }).crypto = {
      ...(globalThis.crypto ?? {}),
      randomUUID: () => 'test-id'
    } as Crypto;
  }
};

const installFetchStub = () => {
  const response = {
    ok: true,
    status: 200,
    json: async () => ({})
  };

  return vi.spyOn(globalThis as { fetch: typeof fetch }, 'fetch').mockResolvedValue(response as unknown as Response);
};

describe('attendance renderer presence behaviour', () => {
  let attendanceStub: ReturnType<typeof installAttendanceStub>['attendance'];
  let fetchMock: ReturnType<typeof installFetchStub>;

  beforeEach(() => {
    vi.resetModules();
    document.documentElement.innerHTML = template;
    ensureCrypto();
    fetchMock = installFetchStub();
    attendanceStub = installAttendanceStub().attendance;
  });

  afterEach(() => {
    fetchMock.mockRestore();
    vi.restoreAllMocks();
    document.documentElement.innerHTML = '';
    delete (window as typeof window & { attendance?: unknown }).attendance;
    delete (window as typeof window & { attendancePresence?: unknown }).attendancePresence;
  });

  it('keeps the presence button hidden but available for scripting', async () => {
    await import('./index');

    const presenceButton = document.getElementById('presence-button') as HTMLButtonElement | null;
    expect(presenceButton).not.toBeNull();
    expect(presenceButton?.hidden).toBe(true);
    expect(presenceButton?.style.display).toBe('none');
    expect(presenceButton?.getAttribute('aria-hidden')).toBe('true');
    expect(presenceButton?.getAttribute('tabindex')).toBe('-1');
  });

  it('registers presence listeners without rendering the UI', async () => {
    await import('./index');

    expect(attendanceStub.onPresenceWindowConfirm).toHaveBeenCalledTimes(1);
    expect(attendanceStub.onPresenceWindowDismiss).toHaveBeenCalledTimes(1);

    const presenceButton = document.getElementById('presence-button') as HTMLButtonElement | null;
    expect(presenceButton?.hidden).toBe(true);
  });

  it('renders a Tardy (m) column with sample data', async () => {
    await import('./index');

    const headers = Array.from(document.querySelectorAll('th')).map((node) => node.textContent?.trim());
    expect(headers).toContain('Tardy (m)');

    const bodyHtml = document.getElementById('timesheet-body')?.innerHTML ?? '';
    expect(bodyHtml).toContain('<td>15</td>');
  });
});
