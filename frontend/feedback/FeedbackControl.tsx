import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Dialog, RadioGroup } from 'radix-ui';
import { MessageSquareText, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { EarFace, type EarExpression } from '@/components/EarFace';
import { useAuth } from '@/auth/store';
import { useStudio } from '@/studio/studio';
import { submitFeedback } from './submit.js';
import './FeedbackControl.css';

const ratings: Array<{ value: EarExpression; label: string }> = [
  { value: 1, label: 'Not useful' },
  { value: 2, label: 'A little useful' },
  { value: 3, label: 'Somewhat useful' },
  { value: 4, label: 'Useful' },
  { value: 5, label: 'Very useful' },
];

function FeedbackForm({ email, onSubmit }: { email: string; onSubmit: () => void }) {
  const id = useId();
  const [rating, setRating] = useState('');
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState('no');
  const [replyEmail, setReplyEmail] = useState(email);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'sent'>('idle');
  const mounted = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(closeTimer.current);
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status !== 'idle' || !rating || !message.trim()) return;
    setStatus('submitting');
    const saved = await submitFeedback({
      rating: Number(rating),
      message: message.trim(),
      replyEmail: reply === 'yes' ? replyEmail.trim() : null,
    });
    if (!mounted.current) return;
    if (!saved) {
      onSubmit();
      return;
    }
    setStatus('sent');
    closeTimer.current = setTimeout(onSubmit, 1000);
  };

  return (
    <form
      className="mt-6 space-y-6 [@media(max-height:640px)]:mt-4 [@media(max-height:640px)]:space-y-4"
      onSubmit={submit}
    >
      <div>
        <div
          aria-hidden="true"
          className="mb-2 grid grid-cols-5 gap-1.5 text-center text-xs whitespace-nowrap text-muted-foreground sm:gap-3"
        >
          <span className="col-start-1">Not useful</span>
          <span className="col-start-5">Very useful</span>
        </div>
        <RadioGroup.Root
          aria-label="Usefulness rating"
          value={rating}
          onValueChange={setRating}
          disabled={status !== 'idle'}
          required
          className="grid grid-cols-5 gap-1.5 sm:gap-3"
        >
          {ratings.map((item) => (
            <RadioGroup.Item
              key={item.value}
              value={String(item.value)}
              aria-label={`${item.value}: ${item.label}`}
              className="group flex h-16 min-w-0 cursor-pointer items-center justify-center rounded-xl border border-transparent text-muted-foreground outline-none transition-[color,background-color,border-color] duration-150 ease-out-expo hover:bg-muted/65 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=checked]:border-brand/25 data-[state=checked]:bg-brand/8 data-[state=checked]:text-brand motion-reduce:transition-none sm:h-20 [@media(max-height:640px)]:h-14"
            >
              <svg
                viewBox="54 32 72 70"
                aria-hidden="true"
                className="h-12 w-full max-w-20 sm:h-14"
              >
                <EarFace expression={item.value} ears={false} />
              </svg>
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-message`}>Anything you'd like to share?</Label>
        <Textarea
          id={`${id}-message`}
          name="message"
          placeholder="What worked well? What could be better?"
          value={message}
          onChange={(event) => setMessage(event.currentTarget.value)}
          maxLength={4000}
          required
          disabled={status !== 'idle'}
          className="field-sizing-fixed min-h-28 resize-y rounded-xl bg-card px-3.5 py-3 text-base shadow-none placeholder:font-[350] focus-visible:ring-ring/15 disabled:opacity-100 md:text-base [@media(max-height:640px)]:min-h-20"
        />
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span id={`${id}-reply`} className="text-sm font-medium">
            Would you like a reply?
          </span>
          <RadioGroup.Root
            aria-labelledby={`${id}-reply`}
            value={reply}
            onValueChange={setReply}
            disabled={status !== 'idle'}
            className="flex shrink-0 gap-0.5 rounded-full border border-border bg-muted/40 p-0.5"
          >
            {(['no', 'yes'] as const).map((value) => (
              <RadioGroup.Item
                key={value}
                value={value}
                className="flex h-11 min-w-12 cursor-pointer items-center justify-center rounded-full px-3 text-sm text-muted-foreground outline-none transition-[background-color,color,box-shadow] duration-150 ease-out-expo hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-card data-[state=checked]:text-foreground data-[state=checked]:shadow-xs motion-reduce:transition-none"
              >
                {value === 'yes' ? 'Yes' : 'No'}
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
        </div>
        {reply === 'yes' && (
          <div className="space-y-2">
            <Label htmlFor={`${id}-email`}>Reply email</Label>
            <input
              id={`${id}-email`}
              name="replyEmail"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="your-email@example.com"
              value={replyEmail}
              onChange={(event) => setReplyEmail(event.currentTarget.value)}
              maxLength={254}
              required
              disabled={status !== 'idle'}
              className="h-12 w-full min-w-0 rounded-xl border border-input bg-card px-3.5 text-base text-foreground outline-none transition-[border-color,box-shadow] duration-150 ease-out-expo placeholder:font-[350] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/15 motion-reduce:transition-none"
            />
          </div>
        )}
      </div>
      <span role="status" className="sr-only">
        {status === 'sent' ? 'Feedback submitted.' : ''}
      </span>
      <Button
        type="submit"
        data-feedback-state={status}
        aria-label={status === 'sent' ? 'Feedback submitted' : 'Submit'}
        aria-busy={status === 'submitting'}
        className="feedback-submit h-11 w-full rounded-full data-[feedback-state=sent]:bg-success/10 data-[feedback-state=sent]:text-success disabled:data-[feedback-state=sent]:opacity-100 disabled:data-[feedback-state=submitting]:opacity-70"
        disabled={
          status !== 'idle' || !rating || !message.trim() || (reply === 'yes' && !replyEmail.trim())
        }
      >
        <span className="relative grid h-6 place-items-center" aria-hidden="true">
          <span className="feedback-submit-label">Submit</span>
          <svg
            data-testid="feedback-submit-check"
            className="feedback-submit-check absolute size-6"
            viewBox="0 0 24 24"
            fill="none"
          >
            <path
              d="M5 12.5 9.5 17 19 7"
              pathLength="1"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </Button>
    </form>
  );
}

export function FeedbackControl() {
  const [open, setOpen] = useState(false);
  const disabled = useStudio((state) => Boolean(state.fatalError));
  const email = useAuth((state) =>
    state.session ? state.profile?.email || state.session.user.email || '' : '',
  );

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button
          type="button"
          variant="text"
          aria-label="Feedback"
          disabled={disabled}
          className="h-11 gap-1.5 rounded-full px-2 text-sm font-medium tracking-tight sm:px-3"
        >
          Feedback
          <MessageSquareText className="size-4" strokeWidth={1.6} aria-hidden="true" />
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/25 motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in motion-safe:duration-150 motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out motion-safe:data-[state=closed]:duration-100" />
        <Dialog.Content
          aria-describedby={undefined}
          className="scrollbar-thin scrollbar-thumb-muted-foreground/60 scrollbar-track-transparent fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-popover p-5 shadow-lg outline-none motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in motion-safe:data-[state=open]:zoom-in-95 motion-safe:duration-150 motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:fade-out motion-safe:data-[state=closed]:zoom-out-95 motion-safe:data-[state=closed]:duration-100 sm:p-7 [@media(max-height:640px)]:p-4"
        >
          <Dialog.Title className="max-w-[24ch] pr-5 text-xl leading-snug font-medium tracking-tight">
            How useful has this been for your ear training?
          </Dialog.Title>
          <Dialog.Close asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close feedback"
              className="absolute top-2 right-2 rounded-full text-muted-foreground"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </Dialog.Close>
          <FeedbackForm email={email} onSubmit={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
