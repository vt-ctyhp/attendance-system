/**
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event?: unknown) => void;
type PromptListener = (promptId: string) => void;

class ElementStub {
  id: string;
  tagName: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
  textContent: string;
  value: string;
  disabled: boolean;
  innerHTML: string;
  classList: { toggle: (token: string, force?: boolean) => void };
  private listeners: Record<string, Listener[]> = {};
  private attributes: Record<string, string> = {};
  children: ElementStub[] = [];
  submitButton: ElementStub | null = null;

  constructor(id = '', tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.innerHTML = '';
    this.classList = { toggle: () => undefined };
  }

  addEventListener(event: string, handler: Listener) {
    this.listeners[event] = this.listeners[event] ?? [];
    this.listeners[event].push(handler);
  }

  removeEventListener(event: string, handler: Listener) {
    const list = this.listeners[event];
    if (!list) {
      return;
    }
    this.listeners[event] = list.filter((existing) => existing !== handler);
  }

  dispatch(eventName: string, event: unknown = {}) {
    const listeners = this.listeners[eventName];
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener(event);
    }
  }

  click() {
    this.dispatch('click', { preventDefault: () => undefined, stopPropagation: () => undefined });
  }

  appendChild(child: ElementStub) {
    this.children.push(child);
    return child;
  }

  querySelector(selector: string) {
    if (selector === 'button[type="submit"]') {
      return this.submitButton;
    }
    return null;
  }

  focus() {
    // no-op for tests
  }

  reset() {
    // no-op for tests
  }

  removeAttribute(name: string) {
    if (name === 'disabled') {
      this.disabled = false;
    }
    delete this.attributes[name];
  }

  setAttribute(name: string, value: string) {
    if (name === 'disabled') {
      this.disabled = true;
    }
    this.attributes[name] = value;
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  matches(selector: string) {
    if (selector === '[data-action="timesheet-request-edit"]') {
      return this.dataset.action === 'timesheet-request-edit';
    }
    return false;
  }
}

class DocumentStub {
  elements = new Map<string, ElementStub>();
  actionButtons: ElementStub[] = [];
  body = new ElementStub('body', 'body');

  getElementById(id: string) {
    if (!this.elements.has(id)) {
      this.elements.set(id, new ElementStub(id));
    }
    return this.elements.get(id) ?? null;
  }

  createElement(tag: string) {
    return new ElementStub('', tag);
  }

  querySelectorAll(selector: string) {
    if (selector === '[data-action]') {
      return this.actionButtons;
    }
    return [];
  }

  createActionButton(action: string) {
    const button = new ElementStub(`action-${action}`, 'button');
    button.dataset.action = action;
    this.actionButtons.push(button);
    return button;
  }
}

const ACTION_KEYS = ['log-in', 'start-break', 'end-break', 'start-lunch', 'end-lunch', 'log-out'];

const ensureModalHidden = (doc: DocumentStub, id: string) => {
  const el = doc.getElementById(id);
  if (el) {
    el.dataset.visible = 'false';
  }
};

const createSubmitButton = () => {
  const button = new ElementStub('submit-btn', 'button');
  button.removeAttribute = button.removeAttribute.bind(button);
  return button;
};

const installGlobalEnvironment = () => {
  const documentStub = new DocumentStub();

  for (const key of ACTION_KEYS) {
    documentStub.createActionButton(key);
  }

  const loginForm = documentStub.getElementById('login-form');
  if (loginForm) {
    const submit = createSubmitButton();
    loginForm.submitButton = submit;
    loginForm.querySelector = (selector: string) => (selector === 'button[type="submit"]' ? submit : null);
  }

  const requestForm = documentStub.getElementById('request-form');
  if (requestForm) {
    const submit = createSubmitButton();
    requestForm.submitButton = submit;
    requestForm.querySelector = (selector: string) => (selector === 'button[type="submit"]' ? submit : null);
  }

  ensureModalHidden(documentStub, 'presence-modal');
  ensureModalHidden(documentStub, 'settings-modal');
  ensureModalHidden(documentStub, 'request-modal');
  ensureModalHidden(documentStub, 'login-modal');
  ensureModalHidden(documentStub, 'timesheet-modal');
  ensureModalHidden(documentStub, 'timesheet-edit-modal');

  (globalThis as { document?: unknown }).document = documentStub as unknown;

  const timeouts = new Map<number, () => void>();
  let timeoutIndex = 0;

  const confirmHandlers: PromptListener[] = [];
  const dismissHandlers: PromptListener[] = [];

  const attendanceApi = {
    logAction: vi.fn(),
    getBootstrap: vi.fn().mockResolvedValue({ baseUrl: 'http://localhost:4000', deviceId: 'device-1', platform: 'test' }),
    getSystemStatus: vi.fn().mockResolvedValue({ idleSeconds: 0, foregroundApp: null }),
    getSettings: vi.fn().mockResolvedValue({
      deviceId: 'device-1',
      serverBaseUrl: 'http://localhost:4000',
      workEmail: 'worker@example.com'
    }),
    updateSettings: vi.fn().mockImplementation(async (settings: { serverBaseUrl: string; workEmail: string | null }) => ({
      deviceId: 'device-1',
      serverBaseUrl: settings.serverBaseUrl,
      workEmail: settings.workEmail ?? null
    })),
    testServerUrl: vi.fn().mockResolvedValue({ ok: true }),
    loadOfflineQueue: vi.fn().mockResolvedValue([]),
    saveOfflineQueue: vi.fn().mockResolvedValue({}),
    clearOfflineQueue: vi.fn().mockResolvedValue({}),
    openPresencePrompt: vi.fn(),
    closePresencePrompt: vi.fn(),
    onPresenceWindowConfirm: (handler: PromptListener) => {
      confirmHandlers.push(handler);
      return () => {
        const index = confirmHandlers.indexOf(handler);
        if (index >= 0) {
          confirmHandlers.splice(index, 1);
        }
      };
    },
    onPresenceWindowDismiss: (handler: PromptListener) => {
      dismissHandlers.push(handler);
      return () => {
        const index = dismissHandlers.indexOf(handler);
        if (index >= 0) {
          dismissHandlers.splice(index, 1);
        }
      };
    }
  };

  const windowStub: Record<string, unknown> = {
    attendance: attendanceApi,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout: vi.fn().mockImplementation((handler: () => void) => {
      const id = ++timeoutIndex;
      timeouts.set(id, handler);
      return id;
    }),
    clearTimeout: vi.fn().mockImplementation((id: number) => {
      timeouts.delete(id);
    }),
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    crypto: { randomUUID: () => 'prompt-test-id' },
    fetch: vi.fn()
  };

  (globalThis as { window?: unknown }).window = windowStub as unknown;

  class MutationObserverStub {
    constructor(private readonly callback: MutationCallback) {}
    observe() {
      // no-op for tests
    }
    disconnect() {
      // no-op for tests
    }
  }

  (globalThis as { MutationObserver?: unknown }).MutationObserver = MutationObserverStub as unknown;

  if (!(globalThis as { crypto?: Crypto }).crypto) {
    (globalThis as unknown as { crypto: { randomUUID: () => string } }).crypto = { randomUUID: () => 'prompt-test-id' };
  }

  return { documentStub, confirmHandlers, dismissHandlers, attendanceApi, windowStub };
};

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('presence prompts', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
  });

  it('opens presence modal and acknowledges when presencePrompt is returned', async () => {
    const env = installGlobalEnvironment();
    const module = await import('./index');
    await flushPromises();

    const helpers = module.__test;
    helpers.setPresenceUiMode('overlay');
    const prompt = { id: 'prompt-123', expiresAt: new Date(Date.now() + 60_000).toISOString(), message: 'Ping' };
    const extracted = helpers.resolvePresencePrompt({ presencePrompt: prompt });
    expect(extracted).toEqual(prompt);
    expect(helpers.shouldDisplayPresencePrompt(extracted)).toBe(true);

    helpers.showPresencePrompt(extracted);
    const modal = helpers.getPresenceModal();
    expect(modal?.dataset.visible).toBe('true');

    const sendStub = vi.fn().mockResolvedValue({ ok: true });
    helpers.setSendOrQueueHandler(sendStub as any);

    const state = helpers.getState();
    state.sessionId = 'session-xyz';

    const confirmButton = helpers.getPresenceConfirmButton();
    expect(confirmButton).not.toBeNull();

    await helpers.acknowledgePresencePrompt('overlay');

    expect(sendStub).toHaveBeenCalledTimes(1);
    const firstCall = sendStub.mock.calls[0]?.[0];
    expect(firstCall).toMatchObject({
      path: '/api/events/presence/confirm',
      body: {
        sessionId: 'session-xyz',
        promptId: 'prompt-123'
      }
    });
    expect(modal?.dataset.visible).toBe('false');
    expect(env.attendanceApi.closePresencePrompt).toHaveBeenCalledWith('prompt-123');

    helpers.resetSendOrQueueHandler();
  });

  it('supports legacy prompt field and avoids duplicate modals', async () => {
    const env = installGlobalEnvironment();
    const module = await import('./index');
    await flushPromises();

    const helpers = module.__test;
    helpers.setPresenceUiMode('overlay');
    const prompt = { id: 'legacy-1', expiresAt: new Date(Date.now() + 45_000).toISOString(), message: 'Legacy' };

    const extracted = helpers.resolvePresencePrompt({ prompt });
    expect(extracted).toEqual(prompt);
    expect(helpers.shouldDisplayPresencePrompt(extracted)).toBe(true);

    helpers.showPresencePrompt(extracted);
    expect(helpers.getPresenceModal()?.dataset.visible).toBe('true');

    expect(helpers.shouldDisplayPresencePrompt(extracted)).toBe(false);
    expect(env.attendanceApi.openPresencePrompt).not.toHaveBeenCalled();
  });

  it('acknowledges prompt when popup surface confirms', async () => {
    const env = installGlobalEnvironment();
    const module = await import('./index');
    await flushPromises();

    const helpers = module.__test;
    helpers.setPresenceUiMode('both');
    const prompt = { id: 'prompt-popup', expiresAt: new Date(Date.now() + 60_000).toISOString(), message: 'Popup' };

    helpers.showPresencePrompt(prompt);
    const state = helpers.getState();
    state.sessionId = 'session-popup';

    const sendStub = vi.fn().mockResolvedValue({ ok: true });
    helpers.setSendOrQueueHandler(sendStub as any);

    expect(env.attendanceApi.openPresencePrompt).toHaveBeenCalledWith({
      id: 'prompt-popup',
      expiresAt: prompt.expiresAt,
      message: prompt.message
    });

    const handler = env.confirmHandlers[env.confirmHandlers.length - 1];
    expect(handler).toBeTypeOf('function');
    handler?.('prompt-popup');

    await flushPromises();

    expect(sendStub).toHaveBeenCalledTimes(1);
    const request = sendStub.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      path: '/api/events/presence/confirm',
      body: {
        sessionId: 'session-popup',
        promptId: 'prompt-popup'
      }
    });
    expect(env.attendanceApi.closePresencePrompt).toHaveBeenCalledWith('prompt-popup');
    helpers.resetSendOrQueueHandler();
  });
});

describe('settings test connection', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
  });

  it('renders version and timestamp when connection succeeds', async () => {
    const env = installGlobalEnvironment();
    const module = await import('./index');
    await flushPromises();

    const helpers = module.__test;
    const fetchMock = env.windowStub.fetch as unknown as ReturnType<typeof vi.fn>;
    const isoTime = '2025-09-26T22:30:00.000Z';

    const openBtn = document.getElementById('open-settings');
    const baseUrlInput = document.getElementById('settings-base-url');
    const testButton = document.getElementById('settings-test');
    expect(openBtn).not.toBeNull();
    expect(baseUrlInput).not.toBeNull();
    expect(testButton).not.toBeNull();

    baseUrlInput!.value = 'https://connect.example.com';
    openBtn!.click();

    const jsonMock = vi.fn().mockResolvedValue({ ok: true, version: '1.2.3', time: isoTime });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jsonMock
    });

    testButton!.click();
    await flushPromises();
    const fetchResult = fetchMock.mock.results[0]?.value as Promise<unknown> | undefined;
    if (fetchResult) {
      await fetchResult;
    }
    const jsonResult = jsonMock.mock.results[0]?.value as Promise<unknown> | undefined;
    if (jsonResult) {
      await jsonResult;
    }
    await flushPromises();

    for (let i = 0; i < 5 && helpers.getState().healthStatus.state === 'testing'; i += 1) {
      await flushPromises();
    }

    const state = helpers.getState();
    expect(state.healthStatus.state).toBe('success');

    const successEl = document.getElementById('settings-success');
    expect(successEl?.innerHTML).toContain('Connected');
    expect(successEl?.innerHTML).toContain('v1.2.3');
    const formattedTime = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'short',
      timeStyle: 'short'
    }).format(new Date(isoTime));
    expect(successEl?.innerHTML).toContain(formattedTime);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(state.lastHealthSuccess).not.toBeNull();
    expect(state.lastHealthSuccess?.version).toBe('1.2.3');
    expect(state.lastHealthSuccess?.time.toISOString()).toBe(isoTime);

    const settingsModal = document.getElementById('settings-modal');
    expect(settingsModal).not.toBeNull();
    settingsModal!.dataset.visible = 'false';
    openBtn!.click();

    const successAfterReopen = document.getElementById('settings-success');
    expect(successAfterReopen?.innerHTML).toContain('v1.2.3');
    expect(successAfterReopen?.innerHTML).toContain(formattedTime);
  });

  it('shows detailed error information when connection fails', async () => {
    const env = installGlobalEnvironment();
    const module = await import('./index');
    await flushPromises();

    const fetchMock = env.windowStub.fetch as unknown as ReturnType<typeof vi.fn>;

    const openBtn = document.getElementById('open-settings');
    const baseUrlInput = document.getElementById('settings-base-url');
    const testButton = document.getElementById('settings-test');
    expect(openBtn).not.toBeNull();
    expect(baseUrlInput).not.toBeNull();
    expect(testButton).not.toBeNull();

    baseUrlInput!.value = 'https://connect.example.com';
    openBtn!.click();

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({})
    });

    testButton!.click();
    await flushPromises();
    const fetchResult = fetchMock.mock.results[0]?.value as Promise<unknown> | undefined;
    if (fetchResult) {
      await fetchResult;
    }
    await flushPromises();

    const helpers = module.__test;
    for (let i = 0; i < 5 && helpers.getState().healthStatus.state === 'testing'; i += 1) {
      await flushPromises();
    }
    const state = helpers.getState();
    expect(state.healthStatus.state).toBe('error');
    const errorEl = document.getElementById('settings-error');
    expect(errorEl?.innerHTML).toContain('Unable to reach server.');
    expect(errorEl?.innerHTML).toContain('HTTP 404 Not Found');
    expect(state.lastHealthSuccess).toBeNull();
  });
});
