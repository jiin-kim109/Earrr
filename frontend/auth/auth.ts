import { createClient } from '@supabase/supabase-js';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { useAuth } from './store.js';
import type { AuthView } from './store.js';
import { configureSession } from '../storage/access.js';
import type { PublicAuthConfig, UserProfile } from '../../shared/types/user.js';

interface AuthHooks {
  pause: () => Promise<void>;
  identity: (session: Session | null, migrate: boolean) => Promise<void>;
}
const signup = z.object({
  firstName: z.string().trim().min(1, 'Enter your first name.').max(80),
  lastName: z.string().trim().min(1, 'Enter your last name.').max(80),
  email: z.email('Enter a valid email address.').max(254),
  password: z.string().min(8, 'Use at least 8 characters for your password.'),
});
const email = z.email('Enter a valid email address.');
const code = z.string().regex(/^\d{6}$/, 'Enter the code sent to your email.');
const profileNames = z.object({ first_name: z.string(), last_name: z.string() });
let client: SupabaseClient | null = null;
let hooks: AuthHooks | null = null;
let applying = Promise.resolve();
let currentUser: string | null = null;
let signupEmail: string | null = null;
let suppressIdentity = false;
let initializing = false;
const signupStorageKey = 'earrr:pending-signup';
const name = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
function profile(session: Session): UserProfile {
  const previous = useAuth.getState().profile;
  const own = previous?.id === session.user.id ? previous : null;
  return {
    id: session.user.id,
    email: session.user.email ?? '',
    firstName: own?.firstName || name(session.user.user_metadata.first_name),
    lastName: own?.lastName || name(session.user.user_metadata.last_name),
  };
}
function publishSession(session: Session | null) {
  const changed = useAuth.getState().session?.user.id !== session?.user.id;
  useAuth.setState({
    session,
    profile: session ? profile(session) : null,
    ...(changed ? { profileError: null } : {}),
  });
}
const sdk = () => {
  if (!client) throw new Error('Account login is not configured yet.');
  return client;
};
async function loadProfile(session: Session) {
  const { data, error } = await sdk()
    .from('earrr_profiles')
    .select('first_name,last_name')
    .eq('user_id', session.user.id)
    .maybeSingle();
  if (useAuth.getState().session?.user.id !== session.user.id) return;
  if (error) {
    useAuth.setState({ profileError: `Your name could not be loaded: ${error.message}` });
    return;
  }
  const names = data === null ? null : profileNames.safeParse(data);
  if (names && !names.success) {
    useAuth.setState({ profileError: 'Your account profile contains invalid name data.' });
    return;
  }
  const current = profile(session);
  useAuth.setState({
    profile: {
      ...current,
      firstName: (names?.success && name(names.data.first_name)) || current.firstName,
      lastName: (names?.success && name(names.data.last_name)) || current.lastName,
    },
    profileError: null,
  });
}
async function action(work: () => Promise<void>) {
  if (useAuth.getState().busy) return;
  useAuth.setState({ busy: true, error: null, notice: null });
  try {
    await work();
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    useAuth.setState({
      error:
        code === 'email_address_not_authorized'
          ? 'The default email provider only sends to this Supabase project team. This address is not authorized to receive a code.'
          : code === 'over_email_send_rate_limit'
            ? 'Email sending is temporarily rate limited. Wait before requesting another code.'
            : error instanceof z.ZodError
              ? error.issues[0]!.message
              : error instanceof Error
                ? error.message
                : 'This account action could not be completed.',
    });
  } finally {
    useAuth.setState({ busy: false });
  }
}
const needsGuestTransfer = (session: Session | null = useAuth.getState().session) =>
  Boolean(signupEmail && session?.user.email?.toLowerCase() === signupEmail);
async function apply(
  session: Session | null,
  migrate = needsGuestTransfer(session),
  force = false,
) {
  const nextUser = session?.user.id ?? null;
  publishSession(session);
  if (nextUser !== currentUser || migrate || force) {
    await hooks!.identity(session, migrate);
    currentUser = nextUser;
    if (migrate) account.completedGuestTransfer();
  }
  useAuth.setState({ view: null, error: null, notice: null });
  if (session) await loadProfile(session);
}

export const account = {
  async initialize(callbacks: AuthHooks) {
    hooks = callbacks;
    if (client) {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      publishSession(data.session);
      if (data.session) await loadProfile(data.session);
      currentUser = useAuth.getState().session?.user.id ?? null;
      return useAuth.getState().session;
    }
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('Account configuration could not be loaded.');
    const { auth } = (await response.json()) as { auth: PublicAuthConfig };
    useAuth.setState({ config: auth });
    if (!auth.enabled) return null;
    client = createClient(auth.url, auth.publishableKey, {
      auth: {
        storageKey: 'earrr:auth',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    });
    configureSession(() => useAuth.getState().session);
    const pending = localStorage.getItem(signupStorageKey);
    if (pending) {
      signupEmail = pending.toLowerCase();
      useAuth.setState({ pendingEmail: pending });
    }
    initializing = true;
    client.auth.onAuthStateChange((event, session) => {
      publishSession(session);
      if (event === 'PASSWORD_RECOVERY') {
        useAuth.setState({ view: 'new-password' });
        return;
      }
      if (
        event === 'INITIAL_SESSION' ||
        initializing ||
        suppressIdentity ||
        (currentUser === (session?.user.id ?? null) && event !== 'USER_UPDATED')
      )
        return;
      applying = applying
        .then(() =>
          currentUser === (session?.user.id ?? null)
            ? session
              ? loadProfile(session)
              : undefined
            : apply(session),
        )
        .catch((error) => {
          useAuth.setState({
            error: error instanceof Error ? error.message : 'Saved progress could not be loaded.',
          });
        });
    });
    try {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      currentUser = data.session?.user.id ?? null;
      publishSession(data.session);
      if (data.session) await loadProfile(data.session);
      currentUser = useAuth.getState().session?.user.id ?? null;
      return useAuth.getState().session;
    } finally {
      initializing = false;
    }
  },
  async open(view: AuthView) {
    await action(async () => {
      if (useAuth.getState().view === null) await hooks!.pause();
      useAuth.setState({ view, error: null, notice: null });
    });
  },
  needsGuestTransfer,
  completedGuestTransfer() {
    if (!needsGuestTransfer()) return;
    localStorage.removeItem(signupStorageKey);
    signupEmail = null;
  },
  async close() {
    useAuth.setState({ view: null, error: null, notice: null });
  },
  async logIn(address: string, password: string) {
    await action(async () => {
      suppressIdentity = true;
      try {
        const { data, error } = await sdk().auth.signInWithPassword({
          email: email.parse(address.trim()),
          password,
        });
        if (error) {
          if (error.code === 'email_not_confirmed')
            useAuth.setState({ view: 'verify', pendingEmail: address });
          throw error;
        }
        if (!data.session) throw new Error('Login returned no session.');
        await apply(data.session);
      } finally {
        suppressIdentity = false;
      }
    });
  },
  async signUp(values: z.infer<typeof signup>) {
    await action(async () => {
      const input = signup.parse(values);
      suppressIdentity = true;
      try {
        const { data, error } = await sdk().auth.signUp({
          email: input.email,
          password: input.password,
          options: { data: { first_name: input.firstName, last_name: input.lastName } },
        });
        if (error) throw error;
        signupEmail = input.email.toLowerCase();
        localStorage.setItem(signupStorageKey, signupEmail);
        useAuth.setState({
          pendingEmail: input.email,
          view: 'verify',
        });
        if (data.session) await apply(data.session, true);
      } finally {
        suppressIdentity = false;
      }
    });
  },
  async verifySignup(token: string) {
    await action(async () => {
      suppressIdentity = true;
      try {
        const verified = useAuth.getState().session;
        if (verified?.user.email_confirmed_at && needsGuestTransfer(verified)) {
          await apply(verified, true);
          return;
        }
        const { data, error } = await sdk().auth.verifyOtp({
          email: useAuth.getState().pendingEmail,
          token: code.parse(token),
          type: 'signup',
        });
        if (error) throw error;
        if (!data.session) throw new Error('Verification returned no login session.');
        await apply(data.session);
      } finally {
        suppressIdentity = false;
      }
    });
  },
  async resendSignup() {
    await action(async () => {
      const { error } = await sdk().auth.resend({
        type: 'signup',
        email: useAuth.getState().pendingEmail,
      });
      if (error) throw error;
      useAuth.setState({ notice: 'A new code has been sent.' });
    });
  },
  async sendRecovery(address: string) {
    await action(async () => {
      const target = email.parse(address.trim());
      const { error } = await sdk().auth.resetPasswordForEmail(target);
      if (error) throw error;
      useAuth.setState({
        view: 'verify-recovery',
        pendingEmail: target,
        notice: useAuth.getState().view === 'verify-recovery' ? 'A new code has been sent.' : null,
      });
    });
  },
  async verifyRecovery(token: string) {
    await action(async () => {
      suppressIdentity = true;
      try {
        const { data, error } = await sdk().auth.verifyOtp({
          email: useAuth.getState().pendingEmail,
          token: code.parse(token),
          type: 'recovery',
        });
        if (error) throw error;
        if (!data.session) throw new Error('Password recovery returned no login session.');
        publishSession(data.session);
        await loadProfile(data.session);
        useAuth.setState({ view: 'new-password' });
      } finally {
        suppressIdentity = false;
      }
    });
  },
  async updatePassword(password: string) {
    await action(async () => {
      z.string().min(8, 'Use at least 8 characters.').parse(password);
      suppressIdentity = true;
      try {
        const { data, error } = await sdk().auth.updateUser({ password });
        if (error || !data.user) throw error ?? new Error('The password could not be updated.');
        const { data: current, error: sessionError } = await sdk().auth.getSession();
        if (sessionError) throw sessionError;
        if (!current.session) throw new Error('Log in with your new password to continue.');
        await apply(current.session);
      } finally {
        suppressIdentity = false;
      }
    });
  },
  async signInWithGoogle() {
    await action(async () => {
      if (!useAuth.getState().config?.googleEnabled)
        throw new Error('Google login is not enabled yet.');
      const { error } = await sdk().auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${location.origin}/auth/callback` },
      });
      if (error) throw error;
    });
  },
  async signOut() {
    await action(async () => {
      await hooks!.pause();
      suppressIdentity = true;
      try {
        const { error } = await sdk().auth.signOut({ scope: 'local' });
        if (error) throw error;
        await apply(null, false, true);
      } finally {
        suppressIdentity = false;
      }
    });
  },
};
