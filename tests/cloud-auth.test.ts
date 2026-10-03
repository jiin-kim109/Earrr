import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';
import { CloudRepository } from '../server/repositories/cloud.repository.js';

const getUser = vi.hoisted(() => vi.fn());
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser } }),
}));
const user: User = {
  id: '2c7c1e90-6c41-420b-95f7-856048f66af0',
  aud: 'authenticated',
  created_at: '2026-09-30T00:00:00Z',
  email_confirmed_at: '2026-09-30T00:00:00Z',
  app_metadata: {},
  user_metadata: {},
};
const token = (expires: number) =>
  `fixture.${Buffer.from(JSON.stringify({ exp: expires })).toString('base64url')}.signature`;
let repository: CloudRepository;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T15:00:00Z'));
  getUser.mockReset().mockResolvedValue({ data: { user }, error: null });
  repository = new CloudRepository({
    port: 3105,
    databasePath: ':memory:',
    azureEndpoint: '',
    apiKey: '',
    configured: false,
    deployment: 'test',
    transcriptionDeployment: '',
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceKey: 'fixture-server-key',
  });
});
afterEach(() => vi.useRealTimers());

describe('verified Supabase identity cache', () => {
  it('caches an authoritative getUser result for at most 30 seconds', async () => {
    const bearer = token(Math.floor(Date.now() / 1000) + 3600);
    await repository.user(bearer);
    await repository.user(bearer);
    expect(getUser).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30_001);
    await repository.user(bearer);
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it('never uses the cache after the JWT expires, even inside the 30-second window', async () => {
    const bearer = token(Math.floor(Date.now() / 1000) + 5);
    await repository.user(bearer);
    vi.advanceTimersByTime(6000);
    getUser.mockResolvedValue({ data: { user: null }, error: new Error('JWT expired.') });
    await expect(repository.user(bearer)).rejects.toThrow('login session');
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it('rejects an unverified email or malformed claims instead of trusting decoded identity', async () => {
    const bearer = token(Math.floor(Date.now() / 1000) + 3600);
    getUser.mockResolvedValueOnce({
      data: { user: { ...user, email_confirmed_at: null } },
      error: null,
    });
    await expect(repository.user(bearer)).rejects.toThrow('Verify your email');
    await expect(repository.user('malformed')).rejects.toThrow('login session');
    await expect(repository.user(token(Math.floor(Date.now() / 1000) - 1))).rejects.toThrow(
      'login session',
    );
  });
});
