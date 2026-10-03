import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { account } from './auth.js';
import { useAuth } from './store.js';
import { ChevronDown } from 'lucide-react';

const accountButtonClass =
  'h-10 max-w-full rounded-full border-border bg-card px-4 text-sm font-semibold text-foreground shadow-none hover:bg-muted sm:h-11';

export function AccountControl() {
  const { session, profile, busy, error, profileError } = useAuth();

  if (!session) {
    return (
      <Button
        type="button"
        variant="outline"
        className={`${accountButtonClass} min-w-24 px-5`}
        disabled={busy}
        onClick={() => void account.open('login')}
      >
        Log In
      </Button>
    );
  }

  const displayName = [profile?.firstName?.trim(), profile?.lastName?.trim()]
    .filter(Boolean)
    .join(' ');
  const email = profile?.email || session.user.email || '';
  const label = displayName || email;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={accountButtonClass}
          aria-label={`Account menu for ${displayName || email || 'your account'}`}
        >
          <span className="min-w-0 max-w-[9rem] truncate sm:max-w-[12rem]">{label}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        aria-label="Account"
        className="w-72 max-w-[calc(100vw-2rem)] rounded-xl p-2 duration-150 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100"
      >
        <div className="px-3 pt-3 pb-4">
          <p className="truncate text-sm font-medium text-foreground">{label}</p>
          {email && (
            <p className="mt-1 text-xs leading-relaxed break-all text-muted-foreground">{email}</p>
          )}
        </div>
        {(error || profileError) && (
          <p role="alert" className="px-3 pb-2 text-sm leading-relaxed text-destructive">
            {error || profileError}
          </p>
        )}
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-start px-3"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void account.signOut()}
        >
          Sign out
        </Button>
      </PopoverContent>
    </Popover>
  );
}
