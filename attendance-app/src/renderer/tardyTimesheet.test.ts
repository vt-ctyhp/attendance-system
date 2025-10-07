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

const ensureCrypto = () => {
  if (!globalThis.crypto?.randomUUID) {
    (globalThis as { crypto: Crypto }).crypto = {
      ...(globalThis.crypto ?? {}),
      randomUUID: () => 'test-id'
    } as Crypto;
  }
};

const installAttendanceStub = (workEmail: string) => {
  const attendance = {
    onPresenceWindowConfirm: vi.fn().mockReturnValue(() => undefined),
    onPresenceWindowDismiss: vi.fn().mockReturnValue(() => undefined),
    openPresencePrompt: vi.fn(),
    closePresencePrompt: vi.fn(),
    logAction: vi.fn(),
    getBootstrap: vi.fn().mockResolvedValue({
      baseUrl: 'http://localhost:4000',
      deviceId: 'device-1',
      platform: 'test-platform',
      presenceEnabled: true
    }),
    getSettings: vi.fn().mockResolvedValue({ serverBaseUrl: '', workEmail }),
    getSystemStatus: vi.fn().mockResolvedValue({ idleSeconds: 0, foregroundApp: null })
  };
  (window as typeof window & { attendance?: typeof attendance }).attendance = attendance;
  return attendance;
};

const buildOverviewPayload = () => {
  const baseDay = {
    date: '2025-05-05',
    label: 'Mon, May 5',
    activeHours: 7.5,
    idleHours: 0.5,
    breaks: 2,
    lunches: 1,
    tardyMinutes: 12,
    presenceMisses: 0
  };

  return {
    user: {
      id: 51,
      email: 'tardy-render@example.com',
      name: 'Tardy Render',
      role: 'employee',
      location: 'Retail Floor'
    },
    session: {
      id: 'session-123',
      status: 'working',
      startedAt: new Date().toISOString(),
      breakStartedAt: null,
      lunchStartedAt: null,
      lastPresenceCheck: null,
      nextPresenceCheck: new Date().toISOString(),
      lastClockedInAt: new Date().toISOString(),
      lastClockedOutAt: null
    },
    today: {
      date: '2025-05-05',
      label: 'Mon, May 5',
      activeMinutes: 450,
      idleMinutes: 30,
      breakMinutes: 20,
      lunchMinutes: 45,
      breaksCount: 2,
      lunchCount: 1,
      tardyMinutes: 12,
      presenceMisses: 0
    },
    timesheet: {
      view: 'weekly',
      periods: {
        weekly: {
          label: 'May 5 – May 11',
          range: 'May 5, 2025 – May 11, 2025',
          days: [baseDay],
          totals: {
            activeHours: 7.5,
            idleHours: 0.5,
            breaks: 2,
            lunches: 1,
            tardyMinutes: 12,
            presenceMisses: 0
          }
        },
        pay_period: {
          label: 'Pay Period',
          range: 'May 1, 2025 – May 15, 2025',
          days: [baseDay],
          totals: {
            activeHours: 7.5,
            idleHours: 0.5,
            breaks: 2,
            lunches: 1,
            tardyMinutes: 12,
            presenceMisses: 0
          }
        },
        monthly: {
          label: 'May 2025',
          range: 'May 1, 2025 – May 31, 2025',
          days: [baseDay],
          totals: {
            activeHours: 7.5,
            idleHours: 0.5,
            breaks: 2,
            lunches: 1,
            tardyMinutes: 12,
            presenceMisses: 0
          }
        }
      }
    },
    requests: [],
    schedule: {
      defaults: [],
      upcoming: []
    },
    activity: [],
    makeUpCap: {
      used: 0,
      cap: 8
    },
    balances: {
      pto: 32,
      uto: 4,
      makeUp: 0
    },
    meta: {
      generatedAt: new Date().toISOString(),
      referenceDate: 'May 5, 2025'
    }
  };
};

describe('timesheet tardy rendering', () => {
  let attendanceStub: ReturnType<typeof installAttendanceStub>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    document.documentElement.innerHTML = template;
    ensureCrypto();
    attendanceStub = installAttendanceStub('tardy-render@example.com');

    const overview = buildOverviewPayload();
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method?.toUpperCase() ?? 'GET';

      if (url.includes('/api/app/overview') && method === 'GET') {
        const body = JSON.stringify(overview);
        return {
          ok: true,
          status: 200,
          json: async () => overview,
          text: async () => body
        } as unknown as Response;
      }

      if (url.includes('/api/sessions/start') && method === 'POST') {
        const tokens = {
          accessToken: 'token-123',
          refreshToken: 'refresh-123'
        };
        const body = JSON.stringify(tokens);
        return {
          ok: true,
          status: 200,
          json: async () => tokens,
          text: async () => body
        } as unknown as Response;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => ''
      } as unknown as Response;
    });
    vi.spyOn(globalThis as { fetch: typeof fetch }, 'fetch').mockImplementation(fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.innerHTML = '';
    delete (window as typeof window & { attendance?: unknown }).attendance;
    delete (window as typeof window & { attendancePresence?: unknown }).attendancePresence;
  });

  it('displays tardy minutes in the timesheet table', async () => {
    await import('./index');
    const waitForTardy = async () => {
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        const cell = document.querySelector('tbody tr td:nth-child(6)');
        if (cell && cell.textContent?.trim() === '12') {
          return cell;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return document.querySelector('tbody tr td:nth-child(6)');
    };

    const tardyCell = await waitForTardy();
    expect(tardyCell).not.toBeNull();
    expect(tardyCell?.textContent?.trim()).toBe('12');

    const todayCard = document.querySelector('[data-today-tardy]');
    if (todayCard) {
      expect(todayCard.textContent).toContain('12');
    }

    expect(attendanceStub.getBootstrap).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
  });
});
