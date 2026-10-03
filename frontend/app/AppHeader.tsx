import type { ReactNode } from 'react';
import { Brand } from '@/components/Brand';
import { AccountControl } from '@/auth/AccountControl';

export function AppHeader({
  navigation,
  compact = false,
}: {
  navigation?: ReactNode;
  compact?: boolean;
}) {
  return (
    <header className={`flex h-16 shrink-0 items-center gap-2 ${compact ? 'px-3' : 'px-7'}`}>
      {navigation}
      <div className="flex h-11 items-center px-1">
        <Brand className={compact ? 'h-7' : 'h-8'} />
      </div>
      <div className="ml-auto min-w-0">
        <AccountControl />
      </div>
    </header>
  );
}
