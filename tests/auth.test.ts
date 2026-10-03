import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const provider = vi.hoisted(() => ({
  create: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  verifyOtp: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: provider.create }));
vi.mock('../frontend/storage/access.js', () => ({ configureSession: vi.fn() }));

function session(email = 'player@example.com'): Session {
  return {
    access_token: 'fixture-access',
    refresh_token: 'fixture-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    user: {
      id: randomUUID(),
      email,
      email_confirmed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: { first_name: 'Test', last_name: 'Player' },
    },
  };
}
let account: (typeof import('../frontend/auth/auth.js'))['account'];
let useAuth: (typeof import('../frontend/auth/store.js'))['useAuth'];
let listener: (event: AuthChangeEvent, session: Session | null) => void;
let local: Map<string, string>;
const hooks = {
  pause: vi.fn<() => Promise<void>>(),
  identity: vi.fn<(session: Session | null, migrate: boolean) => Promise<void>>(),
};
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  local = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value),
    removeItem: (key: string) => local.delete(key),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        auth: {
          enabled: true,
          url: 'https://example.supabase.co',
          publishableKey: 'fixture-public',
          googleEnabled: false,
          guestStorage: true,
        },
      }),
    ),
  );
  provider.create.mockReturnValue({ auth: provider, from: provider.from });
  provider.from.mockReturnValue(provider);
  provider.select.mockReturnValue(provider);
  provider.eq.mockReturnValue(provider);
  provider.maybeSingle.mockResolvedValue({ data: null, error: null });
  provider.getSession.mockResolvedValue({ data: { session: null }, error: null });
  provider.onAuthStateChange.mockImplementation((callback) => {
    listener = callback;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  provider.signUp.mockResolvedValue({ data: { session: null }, error: null });
  provider.signOut.mockResolvedValue({ error: null });
  hooks.pause.mockResolvedValue();
  hooks.identity.mockResolvedValue();
  ({ account } = await import('../frontend/auth/auth.js'));
  ({ useAuth } = await import('../frontend/auth/store.js'));
});
afterEach(() => vi.unstubAllGlobals());

describe('Supabase account lifecycle', () => {
  it('retains verified signup intent across browser restarts and binds it to the right email', async () => {
    const first = session('new@example.com');
    local.set('earrr:pending-signup', 'NEW@example.com');
    provider.getSession.mockResolvedValue({ data: { session: first }, error: null });
    expect(await account.initialize(hooks)).toEqual(first);
    expect(account.needsGuestTransfer()).toBe(true);
    expect(account.needsGuestTransfer(session('other@example.com'))).toBe(false);
    account.completedGuestTransfer();
    expect(local.has('earrr:pending-signup')).toBe(false);
  });

  it('retries a failed verified transfer without consuming another signup code', async () => {
    await account.initialize(hooks);
    await account.signUp({
      firstName: 'Test',
      lastName: 'Player',
      email: 'new@example.com',
      password: 'fixture-password',
    });
    const verified = session('new@example.com');
    provider.verifyOtp.mockResolvedValue({ data: { session: verified }, error: null });
    hooks.identity.mockRejectedValueOnce(new Error('Cloud progress could not be confirmed.'));
    await account.verifySignup('123456');
    expect(useAuth.getState()).toMatchObject({
      view: 'verify',
      session: verified,
      busy: false,
      error: 'Cloud progress could not be confirmed.',
    });
    expect(local.get('earrr:pending-signup')).toBe('new@example.com');
    await account.verifySignup('');
    expect(provider.verifyOtp).toHaveBeenCalledOnce();
    expect(hooks.identity).toHaveBeenCalledTimes(2);
    expect(hooks.identity).toHaveBeenLastCalledWith(verified, true);
    expect(useAuth.getState()).toMatchObject({ view: null, error: null });
    expect(local.has('earrr:pending-signup')).toBe(false);
  });

  it('does not transfer another pending signup into an existing password-login account', async () => {
    local.set('earrr:pending-signup', 'new@example.com');
    await account.initialize(hooks);
    const existing = session('existing@example.com');
    provider.signInWithPassword.mockResolvedValue({ data: { session: existing }, error: null });
    await account.logIn('existing@example.com', 'fixture-password');
    expect(hooks.identity).toHaveBeenCalledWith(existing, false);
    expect(local.get('earrr:pending-signup')).toBe('new@example.com');
  });

  it('captures an initial recovery event before session initialization finishes', async () => {
    const recovered = session();
    provider.getSession.mockImplementationOnce(async () => {
      listener('PASSWORD_RECOVERY', recovered);
      return { data: { session: recovered }, error: null };
    });
    await account.initialize(hooks);
    expect(useAuth.getState()).toMatchObject({ view: 'new-password', session: recovered });
    expect(hooks.identity).not.toHaveBeenCalled();
  });

  it('closes password recovery for an already-active user without resetting their learning', async () => {
    const current = session();
    provider.getSession.mockResolvedValue({ data: { session: current }, error: null });
    provider.updateUser.mockResolvedValue({ data: { user: current.user }, error: null });
    await account.initialize(hooks);
    listener('PASSWORD_RECOVERY', current);
    await account.updatePassword('new-fixture-password');
    expect(provider.updateUser).toHaveBeenCalledWith({ password: 'new-fixture-password' });
    expect(useAuth.getState()).toMatchObject({ view: null, error: null, session: current });
    expect(hooks.identity).not.toHaveBeenCalled();
  });

  it('refreshes tokens for the same user without switching workspace or closing the current form', async () => {
    const current = session();
    provider.getSession.mockResolvedValue({ data: { session: current }, error: null });
    await account.initialize(hooks);
    useAuth.setState({ view: 'new-password' });
    listener('TOKEN_REFRESHED', { ...current, access_token: 'refreshed-fixture' });
    expect(useAuth.getState().session?.access_token).toBe('refreshed-fixture');
    expect(useAuth.getState().view).toBe('new-password');
    expect(hooks.identity).not.toHaveBeenCalled();
  });

  it('loads authoritative first and last names even when the remembered session has no metadata', async () => {
    const current = session();
    current.user.user_metadata = {};
    provider.getSession.mockResolvedValue({ data: { session: current }, error: null });
    provider.maybeSingle.mockResolvedValue({
      data: { first_name: ' Ada ', last_name: ' Miles ' },
      error: null,
    });
    await account.initialize(hooks);
    expect(provider.from).toHaveBeenCalledWith('earrr_profiles');
    expect(provider.select).toHaveBeenCalledWith('first_name,last_name');
    expect(provider.eq).toHaveBeenCalledWith('user_id', current.user.id);
    expect(useAuth.getState().profile).toEqual({
      id: current.user.id,
      email: current.user.email,
      firstName: 'Ada',
      lastName: 'Miles',
    });
    useAuth.setState({ view: 'new-password' });
    listener('TOKEN_REFRESHED', { ...current, access_token: 'refreshed-fixture' });
    expect(useAuth.getState().profile?.firstName).toBe('Ada');
    expect(useAuth.getState().profile?.lastName).toBe('Miles');
    expect(provider.maybeSingle).toHaveBeenCalledOnce();
    expect(useAuth.getState().view).toBe('new-password');
    expect(hooks.identity).not.toHaveBeenCalled();
  });

  it('refreshes a changed profile after the SDK callback returns without changing learning or the open form', async () => {
    const current = session();
    provider.getSession.mockResolvedValue({ data: { session: current }, error: null });
    await account.initialize(hooks);
    useAuth.setState({ view: 'new-password' });
    provider.maybeSingle.mockResolvedValueOnce({
      data: { first_name: 'Ada', last_name: 'Miles' },
      error: null,
    });
    listener('USER_UPDATED', { ...current, user: { ...current.user, user_metadata: {} } });
    expect(provider.maybeSingle).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(useAuth.getState().profile?.firstName).toBe('Ada'));
    expect(useAuth.getState().profile?.lastName).toBe('Miles');
    expect(useAuth.getState().view).toBe('new-password');
    expect(hooks.identity).not.toHaveBeenCalled();
  });

  it('reports a profile lookup failure without inventing a name or blocking a valid login', async () => {
    const current = session();
    current.user.user_metadata = {};
    provider.getSession.mockResolvedValue({ data: { session: current }, error: null });
    provider.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'Profile service unavailable.' },
    });
    expect(await account.initialize(hooks)).toEqual(current);
    expect(useAuth.getState().profile).toMatchObject({ firstName: '', lastName: '' });
    expect(useAuth.getState().profileError).toContain('Profile service unavailable.');
  });

  it('does not apply an old profile response after sign-out during initialization', async () => {
    const current = session();
    provider.getSession.mockResolvedValue({ data: { session: current }, error: null });
    let finish!: (value: { data: { first_name: string; last_name: string }; error: null }) => void;
    provider.maybeSingle.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const initializing = account.initialize(hooks);
    await vi.waitFor(() => expect(provider.maybeSingle).toHaveBeenCalledOnce());
    listener('SIGNED_OUT', null);
    finish({ data: { first_name: 'Ada', last_name: 'Miles' }, error: null });
    expect(await initializing).toBeNull();
    expect(useAuth.getState()).toMatchObject({ session: null, profile: null, profileError: null });
  });

  it('serializes account changes from another tab and starts a fresh guest on sign-out', async () => {
    await account.initialize(hooks);
    const current = session();
    listener('SIGNED_IN', current);
    await vi.waitFor(() => expect(hooks.identity).toHaveBeenCalledWith(current, false));
    await account.signOut();
    expect(provider.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(hooks.identity).toHaveBeenLastCalledWith(null, false);
    expect(useAuth.getState().session).toBeNull();
  });

  it('keeps the current account and shows the provider error if sign-out fails', async () => {
    const current = session();
    provider.getSession.mockResolvedValue({ data: { session: current }, error: null });
    provider.signOut.mockResolvedValue({ error: new Error('Could not sign out.') });
    await account.initialize(hooks);
    await account.signOut();
    expect(useAuth.getState()).toMatchObject({ session: current, error: 'Could not sign out.' });
    expect(hooks.identity).not.toHaveBeenCalled();
  });

  it('reuses one SDK client and auth subscription after an interrupted bootstrap', async () => {
    await account.initialize(hooks);
    await account.initialize(hooks);
    expect(provider.create).toHaveBeenCalledOnce();
    expect(provider.onAuthStateChange).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('validates signup and recovery passwords before calling the provider', async () => {
    await account.initialize(hooks);
    await account.signUp({
      firstName: '',
      lastName: 'Player',
      email: 'player@example.com',
      password: 'short',
    });
    expect(useAuth.getState().error).toBe('Enter your first name.');
    expect(provider.signUp).not.toHaveBeenCalled();
    await account.updatePassword('short');
    expect(useAuth.getState().error).toBe('Use at least 8 characters.');
    expect(provider.updateUser).not.toHaveBeenCalled();
  });

  it('reports default-provider address restrictions without showing a sent-code screen', async () => {
    await account.initialize(hooks);
    await account.open('signup');
    provider.signUp.mockResolvedValueOnce({
      data: { session: null },
      error: Object.assign(new Error('Email address not authorized.'), {
        code: 'email_address_not_authorized',
      }),
    });
    await account.signUp({
      firstName: 'Test',
      lastName: 'Player',
      email: 'player@example.com',
      password: 'fixture-password',
    });
    expect(useAuth.getState().view).toBe('signup');
    expect(useAuth.getState().error).toContain('project team');
    expect(local.has('earrr:pending-signup')).toBe(false);
    expect(hooks.identity).not.toHaveBeenCalled();
  });

  it('uses plain code wording and never calls verification for invalid input', async () => {
    await account.initialize(hooks);
    await account.verifySignup('');
    expect(useAuth.getState().error).toBe('Enter the code sent to your email.');
    expect(provider.verifyOtp).not.toHaveBeenCalled();
  });
});
