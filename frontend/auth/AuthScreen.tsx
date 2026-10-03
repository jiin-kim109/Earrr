import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { account } from './auth.js';
import { FormField } from './FormField.js';
import { useAuth, type AuthState, type AuthView } from './store.js';

const headings: Record<AuthView, string> = {
  login: 'Welcome back.',
  signup: 'Create an account.',
  verify: 'Check your email.',
  'forgot-password': 'Reset your password.',
  'verify-recovery': 'Enter your reset code.',
  'new-password': 'Choose a new password.',
};

const submitLabels: Record<AuthView, string> = {
  login: 'Log In',
  signup: 'Create account',
  verify: 'Verify email',
  'forgot-password': 'Send reset code',
  'verify-recovery': 'Verify code',
  'new-password': 'Save new password',
};

type AuthFormProps = Pick<AuthState, 'busy' | 'error' | 'notice' | 'pendingEmail'> & {
  view: AuthView;
  headingId: string;
  googleEnabled: boolean;
  verifiedSignup: boolean;
};

function AuthForm({
  view,
  headingId,
  busy,
  error,
  notice,
  pendingEmail,
  googleEnabled,
  verifiedSignup,
}: AuthFormProps) {
  const messageId = useId();
  const confirmationRef = useRef<HTMLInputElement>(null);
  const [confirmationTouched, setConfirmationTouched] = useState(false);
  const [values, setValues] = useState({
    firstName: '',
    lastName: '',
    email: pendingEmail,
    password: '',
    confirmPassword: '',
    code: '',
  });
  const confirmationMismatch =
    values.confirmPassword.length > 0 && values.confirmPassword !== values.password;
  const confirmationError =
    confirmationTouched && confirmationMismatch ? 'Passwords do not match.' : undefined;

  useEffect(() => {
    confirmationRef.current?.setCustomValidity(
      confirmationMismatch ? 'Passwords do not match.' : '',
    );
  }, [confirmationMismatch]);

  function field(name: keyof typeof values) {
    return {
      name,
      value: values[name],
      onChange(event: ChangeEvent<HTMLInputElement>) {
        const value = event.currentTarget.value;
        setValues((current) => ({ ...current, [name]: value }));
      },
    };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    switch (view) {
      case 'login':
        await account.logIn(values.email, values.password);
        break;
      case 'signup':
        await account.signUp({
          firstName: values.firstName,
          lastName: values.lastName,
          email: values.email,
          password: values.password,
        });
        break;
      case 'verify':
        await account.verifySignup(values.code);
        break;
      case 'forgot-password':
        await account.sendRecovery(values.email);
        break;
      case 'verify-recovery':
        await account.verifyRecovery(values.code);
        break;
      case 'new-password':
        await account.updatePassword(values.password);
        break;
    }
  }

  const verifying = view === 'verify' || view === 'verify-recovery';

  return (
    <>
      <form
        aria-labelledby={headingId}
        aria-describedby={error ? `${messageId}-error` : notice ? `${messageId}-notice` : undefined}
        aria-busy={busy}
        className="space-y-4"
        onSubmit={handleSubmit}
      >
        <fieldset disabled={busy} className="min-w-0 space-y-4">
          {view === 'signup' && (
            <div className="grid grid-cols-2 gap-3">
              <FormField
                {...field('firstName')}
                label="First name"
                autoComplete="given-name"
                required
              />
              <FormField
                {...field('lastName')}
                label="Last name"
                autoComplete="family-name"
                required
              />
            </div>
          )}
          {(view === 'login' || view === 'signup' || view === 'forgot-password') && (
            <FormField
              {...field('email')}
              label="Email"
              type="email"
              inputMode="email"
              autoComplete={view === 'login' ? 'username' : 'email'}
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          )}
          {(view === 'login' || view === 'signup') && (
            <FormField
              {...field('password')}
              label="Password"
              type="password"
              autoComplete={view === 'login' ? 'current-password' : 'new-password'}
              minLength={view === 'signup' ? 8 : undefined}
              hint={view === 'signup' ? 'At least 8 characters.' : undefined}
              required
            />
          )}
          {view === 'login' && (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="text"
                size="sm"
                className="-mr-2 text-brand hover:text-brand"
                disabled={busy}
                onClick={() => void account.open('forgot-password')}
              >
                Forgot password?
              </Button>
            </div>
          )}
          {verifying && !verifiedSignup && (
            <FormField
              {...field('code')}
              label="Email code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              minLength={6}
              maxLength={6}
              title="Enter the code sent to your email."
              className="tabular-nums tracking-[0.3em]"
              required
            />
          )}
          {view === 'new-password' && (
            <>
              <FormField
                {...field('password')}
                label="New password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                hint="At least 8 characters."
                required
              />
              <FormField
                {...field('confirmPassword')}
                ref={confirmationRef}
                label="Confirm new password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                error={confirmationError}
                onBlur={() => setConfirmationTouched(true)}
                onInvalid={() => setConfirmationTouched(true)}
                required
              />
            </>
          )}
        </fieldset>
        {error && (
          <p
            id={`${messageId}-error`}
            role="alert"
            className="text-sm leading-relaxed text-destructive"
          >
            {error}
          </p>
        )}
        {notice && (
          <p
            id={`${messageId}-notice`}
            role="status"
            aria-atomic="true"
            className="text-sm leading-relaxed text-muted-foreground"
          >
            {notice}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={busy} aria-busy={busy}>
          {verifiedSignup ? 'Continue to learning' : submitLabels[view]}
        </Button>
        {verifying && !verifiedSignup && (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <Button
              type="button"
              variant="text"
              size="sm"
              className="-ml-2 text-brand hover:text-brand"
              disabled={busy || (view === 'verify-recovery' && !pendingEmail)}
              onClick={() =>
                void (view === 'verify'
                  ? account.resendSignup()
                  : account.sendRecovery(pendingEmail))
              }
            >
              Send code again
            </Button>
            {view === 'verify-recovery' && (
              <Button
                type="button"
                variant="text"
                size="sm"
                className="-mr-2"
                disabled={busy}
                onClick={() => void account.open('forgot-password')}
              >
                Use a different email
              </Button>
            )}
          </div>
        )}
      </form>
      {googleEnabled && (view === 'login' || view === 'signup') && (
        <div className="mt-5 space-y-4">
          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={() => void account.signInWithGoogle()}
          >
            Continue with Google
          </Button>
        </div>
      )}
    </>
  );
}

export function AuthScreen() {
  const { view, config, busy, error, notice, pendingEmail, session } = useAuth();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [view]);

  if (view === null) return null;

  const recovering =
    view === 'forgot-password' || view === 'verify-recovery' || view === 'new-password';
  const verifying = view === 'verify' || view === 'verify-recovery';
  const verifiedSignup = Boolean(
    view === 'verify' &&
      session?.user.email_confirmed_at &&
      session.user.email?.toLowerCase() === pendingEmail.toLowerCase(),
  );

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'mx-auto flex w-full flex-1 flex-col justify-center py-8 sm:py-12',
        view === 'login' ? 'max-w-[46rem]' : 'max-w-[26rem]',
      )}
    >
      <Button
        type="button"
        variant="text"
        className="-ml-2 self-start px-2"
        disabled={busy}
        onClick={() => void account.close()}
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to learning
      </Button>
      <div
        className={cn(
          'mt-6 grid gap-10',
          view === 'login' && 'md:grid-cols-[minmax(0,24rem)_minmax(0,18rem)] md:gap-16',
        )}
      >
        <div
          key={view}
          className="w-full motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200 motion-safe:ease-out-expo motion-reduce:animate-none"
        >
          <h1
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="text-[2rem] leading-tight font-semibold tracking-tight text-foreground outline-none"
          >
            {verifiedSignup ? 'Finish setting up.' : headings[view]}
          </h1>
          {verifiedSignup ? (
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Your email is verified. Continue to save your guest progress to your account.
            </p>
          ) : verifying ? (
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {pendingEmail ? (
                <>
                  Enter the code sent to{' '}
                  <span className="font-medium break-all text-foreground">{pendingEmail}</span>.
                </>
              ) : (
                'Enter the code sent to your email.'
              )}
            </p>
          ) : null}
          {view === 'forgot-password' && (
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              We will email you a code to reset your password.
            </p>
          )}
          <div className="mt-6">
            <AuthForm
              view={view}
              headingId={headingId}
              busy={busy}
              error={error}
              notice={notice}
              pendingEmail={pendingEmail}
              googleEnabled={config?.googleEnabled === true}
              verifiedSignup={verifiedSignup}
            />
          </div>
        </div>
        {view === 'login' && (
          <aside className="md:self-center">
            <h2 className="text-xl leading-snug font-semibold tracking-tight text-foreground">
              Don't have an account?
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
              Keep your progress and pick up where you left off.
            </p>
            <Button
              type="button"
              variant="text"
              size="sm"
              className="mt-4 -ml-2 px-2 text-brand hover:text-brand"
              disabled={busy}
              onClick={() => void account.open('signup')}
            >
              Create an account
            </Button>
          </aside>
        )}
      </div>
      {recovering && (
        <Button
          type="button"
          variant="text"
          className="mt-6 self-start px-0 text-muted-foreground"
          disabled={busy}
          onClick={() => void account.open('login')}
        >
          Back to Log In
        </Button>
      )}
    </section>
  );
}
