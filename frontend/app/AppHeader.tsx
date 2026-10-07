import type { ReactNode } from 'react';
import { Brand } from '@/components/Brand';
import { AccountControl } from '@/auth/AccountControl';
import { FeedbackControl } from '@/feedback/FeedbackControl';

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
      <div className="flex h-11 shrink-0 items-center px-1">
        <Brand compact={compact} className={compact ? 'h-7' : 'h-8'} />
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-3">
        <FeedbackControl />
        <div className="min-w-0">
          <AccountControl />
        </div>
      </div>
    </header>
  );
}
