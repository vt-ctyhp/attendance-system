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

interface AttendanceStubOverrides {
  presenceEnabled?: boolean;
  workEmail?: string | null;
}

const installAttendanceStub = (overrides: AttendanceStubOverrides = {}) => {
  const { presenceEnabled = true, workEmail = null } = overrides;
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
      presenceEnabled
    }),
    getSettings: vi.fn().mockResolvedValue({ serverBaseUrl: '', workEmail }),
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
  });

  afterEach(() => {
    fetchMock.mockRestore();
    vi.restoreAllMocks();
    document.documentElement.innerHTML = '';
    delete (window as typeof window & { attendance?: unknown }).attendance;
    delete (window as typeof window & { attendancePresence?: unknown }).attendancePresence;
  });

  it('hides presence UI and listeners when the feature flag is disabled', async () => {
    attendanceStub = installAttendanceStub({ presenceEnabled: false }).attendance;

    await import('./index');
    await Promise.resolve();
    await Promise.resolve();

    const heroPresence = document.getElementById('hero-presence') as HTMLSpanElement | null;
    expect(heroPresence).not.toBeNull();
    expect(heroPresence?.hidden).toBe(true);
    expect(heroPresence?.textContent?.trim()).toBe('');

    const presenceButton = document.getElementById('presence-button') as HTMLButtonElement | null;
    expect(presenceButton).not.toBeNull();
    expect(presenceButton?.hidden).toBe(true);
    expect(presenceButton?.style.display).toBe('none');
    expect(presenceButton?.getAttribute('aria-hidden')).toBe('true');
    expect(presenceButton?.getAttribute('tabindex')).toBe('-1');

    expect(attendanceStub.onPresenceWindowConfirm).not.toHaveBeenCalled();
    expect(attendanceStub.onPresenceWindowDismiss).not.toHaveBeenCalled();
  });

  it('shows presence affordances and listeners when the feature flag is enabled', async () => {
    attendanceStub = installAttendanceStub({ presenceEnabled: true }).attendance;

    await import('./index');
    await Promise.resolve();
    await Promise.resolve();

    const heroPresence = document.getElementById('hero-presence') as HTMLSpanElement | null;
    expect(heroPresence).not.toBeNull();
    expect(heroPresence?.hidden).toBe(false);
    expect(heroPresence?.textContent?.trim().length).toBeGreaterThan(0);

    const presenceButton = document.getElementById('presence-button') as HTMLButtonElement | null;
    expect(presenceButton).not.toBeNull();
    expect(presenceButton?.hidden).toBe(false);
    expect(presenceButton?.getAttribute('aria-hidden')).toBeNull();

    expect(attendanceStub.onPresenceWindowConfirm).toHaveBeenCalledTimes(1);
    expect(attendanceStub.onPresenceWindowDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders a Tardy (m) column with sample data', async () => {
    attendanceStub = installAttendanceStub({ presenceEnabled: false }).attendance;
    await import('./index');

    const headers = Array.from(document.querySelectorAll('th')).map((node) => node.textContent?.trim());
    expect(headers).toContain('Tardy (m)');

    const bodyHtml = document.getElementById('timesheet-body')?.innerHTML ?? '';
    expect(bodyHtml).toContain('<td>15</td>');
  });
});
