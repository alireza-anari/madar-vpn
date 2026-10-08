import { describe, expect, it } from 'vitest';
import app from './index';

describe('API bootstrap', () => {
  it('returns a real health response', async () => {
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});
