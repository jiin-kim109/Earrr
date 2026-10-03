import { Check, ChevronDown } from 'lucide-react';
import { useId } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { studio } from '@/studio/studio';
import { Instrument } from './Instrument.js';
import type { Instrument as InstrumentName } from '../../shared/types/course.js';

export function InstrumentPicker({
  badge = false,
  instrument: current,
  disabled = false,
}: {
  badge?: boolean;
  instrument: InstrumentName;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div
      className={cn(
        badge
          ? 'flex h-10 w-full items-center justify-between gap-3'
          : 'inline-flex items-center gap-2',
      )}
    >
      <Label htmlFor={id} className="text-sm font-medium text-foreground">
        Instrument sound
      </Label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            id={id}
            disabled={disabled}
            className={cn(
              'h-10 rounded-xl text-xs focus-visible:bg-accent focus-visible:ring-0',
              badge ? 'w-[136px] shrink-0 gap-2 px-2' : 'min-w-28 gap-3 px-3',
            )}
            aria-label={`Change instrument: ${current === 'piano' ? 'Piano' : 'Guitar'}`}
          >
            {badge && (
              <Instrument instrument={current} className="flex h-6 w-14 shrink-0 items-center" />
            )}
            <span className={badge ? 'flex-1 text-left' : undefined}>
              {current === 'piano' ? 'Piano' : 'Guitar'}
            </span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={badge ? 'end' : 'center'} className="w-56 rounded-xl p-1.5">
          {(['piano', 'guitar'] as const).map((instrument) => (
            <DropdownMenuItem
              key={instrument}
              onSelect={() => {
                void studio.chooseInstrument(instrument);
              }}
              className="gap-3 rounded-lg py-3"
              aria-label={instrument === 'piano' ? 'Piano' : 'Guitar'}
            >
              <Instrument instrument={instrument} className="flex h-8 w-16 shrink-0 items-center" />
              <span className="flex-1">{instrument === 'piano' ? 'Piano' : 'Guitar'}</span>
              {current === instrument && <Check className="size-3.5" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
