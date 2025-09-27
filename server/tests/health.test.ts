import { describe, expect, it } from 'vitest';
import { getHealth } from '../src/routes/health';
import { callHandler } from './utils';

describe('GET /api/health', () => {
  it('returns ok response with version and timestamp', async () => {
    const response = await callHandler<{ ok: boolean; version: string; time: string }>(getHealth, {
      method: 'GET'
    });

    expect(response.status).toBe(200);
    expect(response.data).toBeTruthy();
    expect(response.data?.ok).toBe(true);
    expect(typeof response.data?.version).toBe('string');
    expect(response.data?.version?.length).toBeGreaterThan(0);
    expect(() => new Date(response.data?.time ?? '').toISOString()).not.toThrow();
  });
});
