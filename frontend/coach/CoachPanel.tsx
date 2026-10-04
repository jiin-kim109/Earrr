import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { ArrowUp, ChevronsDown, ChevronsUp } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { InlineError } from '@/components/InlineError';
import { MicrophoneControl } from '@/audio/MicrophoneSettings';
import { studio, useStudio } from '@/studio/studio';
import type { Transcript } from './types.js';

interface ComposerProps {
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
}

const messageMotion =
  'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200 motion-safe:ease-out-expo';

function Message({
  message,
  animate,
  compact = false,
  continuation = false,
}: {
  message: Transcript;
  animate: boolean;
  compact?: boolean;
  continuation?: boolean;
}) {
  return (
    <div
      data-message-id={message.id}
      data-message-role={message.role}
      data-feedback-id={message.feedbackId}
      data-testid={compact ? 'latest-message' : undefined}
      className={cn(
        'flex',
        'items-start gap-3',
        animate && messageMotion,
        message.role === 'user' && 'justify-end',
        !compact && (continuation ? 'mt-2' : 'mt-6 first:mt-0'),
      )}
    >
      {message.role === 'assistant' && (
        <span
          data-testid={continuation ? undefined : 'message-sender'}
          aria-hidden={continuation || undefined}
          className={cn('flex h-6 w-8 shrink-0 items-center justify-center', compact && 'mt-3')}
        >
          {!continuation && (
            <img src="/brand/earrr-mark.svg" alt="Earrr" draggable={false} className="size-6" />
          )}
        </span>
      )}
      <div
        className={cn(
          'min-w-0',
          message.role === 'user'
            ? 'max-w-[min(88%,66ch)] rounded-2xl rounded-tr-sm bg-muted px-4 py-3'
            : 'max-w-[66ch]',
          message.role !== 'user' &&
            compact &&
            'rounded-2xl rounded-tl-sm border border-border/60 bg-card px-4 py-3 shadow-soft',
        )}
      >
        {message.role === 'system' && (
          <span
            data-testid="message-sender"
            className={cn(
              'mb-1.5 block leading-4 font-semibold text-muted-foreground',
              compact ? 'text-[11px]' : 'text-xs',
            )}
          >
            Studio
          </span>
        )}
        <p
          className={cn(
            'leading-relaxed wrap-anywhere whitespace-pre-wrap',
            compact ? 'line-clamp-2 text-sm' : 'text-[15px]',
          )}
        >
          {message.text}
        </p>
      </div>
    </div>
  );
}

function ConversationHistory({
  autoFocus = false,
  preview = false,
}: {
  autoFocus?: boolean;
  preview?: boolean;
}) {
  const state = useStudio();
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const userId = useRef<string | undefined>(undefined);
  const [edges, setEdges] = useState({ above: false, below: false });
  const [existing] = useState(() => new Set(state.messages.map((message) => message.id)));
  const newestUser = [...state.messages].reverse().find((message) => message.role === 'user');
  const updateEdges = useCallback(() => {
    const element = content.current;
    if (!element) return;
    const next = {
      above: element.scrollTop > 2,
      below: element.scrollHeight - element.scrollTop - element.clientHeight > 2,
    };
    setEdges((old) => (old.above === next.above && old.below === next.below ? old : next));
  }, []);
  useEffect(() => {
    if (autoFocus) content.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  useLayoutEffect(() => {
    const element = content.current;
    if (element && (atBottom.current || preview || newestUser?.id !== userId.current)) {
      atBottom.current = true;
      element.scrollTop = element.scrollHeight;
    }
    userId.current = newestUser?.id;
    updateEdges();
  }, [state.messages, newestUser?.id, state.phase, preview, updateEdges]);
  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current || preview) element.scrollTop = element.scrollHeight;
      updateEdges();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [preview, updateEdges]);
  const recent = state.messages.slice(-2);
  const messages = preview
    ? recent.every((message) => message.role === 'assistant')
      ? recent.slice(-1)
      : recent
    : state.messages;
  let previousSpeaker: Transcript['role'] | undefined;
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div
        ref={content}
        role="log"
        tabIndex={preview ? undefined : 0}
        aria-label={preview ? 'Latest conversation' : 'Practice conversation'}
        aria-live={
          (state.snapshot?.settings.voiceVolume ?? state.snapshot?.settings.volume) === 0 ||
          state.snapshot?.session?.mode === 'solo'
            ? 'polite'
            : 'off'
        }
        className={cn(
          'scrollbar-thin scrollbar-thumb-muted-foreground/60 scrollbar-track-transparent min-h-0 min-w-0 flex-1 overscroll-contain outline-none focus-visible:bg-card/30',
          preview ? 'overflow-hidden px-2' : 'overflow-x-hidden overflow-y-auto pr-5 pl-3',
        )}
        onScroll={() => {
          const element = content.current;
          if (element)
            atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 16;
          updateEdges();
        }}
      >
        <div
          className={cn('flex min-h-full flex-col', preview ? 'justify-end gap-2 py-2' : 'py-6')}
        >
          {messages.map((message) => {
            const continuation = message.role === previousSpeaker;
            if (message.role !== 'system') previousSpeaker = message.role;
            return (
              <Message
                key={message.id}
                message={message}
                compact={preview}
                continuation={continuation}
                animate={!existing.has(message.id)}
              />
            );
          })}
          {state.phase === 'thinking' && state.connection === 'connected' && (
            <div
              data-testid="coach-thinking"
              role="status"
              aria-label="Coach is thinking"
              className={cn(
                'flex min-h-8 shrink-0 items-center gap-1.5',
                preview
                  ? 'w-fit rounded-2xl rounded-tl-sm border border-border/60 bg-card px-4'
                  : 'mt-4 px-1',
              )}
            >
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-pulse"
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <div
        data-testid="chat-top-fade"
        data-visible={edges.above}
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 h-5 bg-linear-to-b from-background to-transparent transition-opacity duration-150 motion-reduce:transition-none',
          edges.above ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div
        data-testid="chat-bottom-fade"
        data-visible={edges.below}
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-linear-to-t from-background to-transparent transition-opacity duration-150 motion-reduce:transition-none',
          edges.below ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  );
}

function MessageComposer({ draft, setDraft }: ComposerProps) {
  const state = useStudio();
  const session = state.snapshot?.session;
  const canSend = Boolean(
    session &&
      (session.mode === 'solo' ? session.status === 'active' : state.connection === 'connected'),
  );
  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || !canSend) return;
    const submitted = draft;
    if (await studio.send(submitted)) setDraft((current) => (current === submitted ? '' : current));
  };
  return (
    <div className="shrink-0">
      <div className="scrollbar-thin scrollbar-thumb-muted-foreground/60 scrollbar-track-transparent max-h-28 overflow-y-auto px-3">
        <InlineError />
      </div>
      <form
        data-testid="message-composer"
        className="flex shrink-0 items-end gap-2 px-2 pt-2 pb-2"
        onSubmit={(event) => {
          void send(event);
        }}
      >
        <div className="flex min-w-0 flex-1 items-end gap-2 rounded-2xl bg-card px-2 py-1.5 shadow-soft ring-1 ring-border/70 transition-shadow duration-200 focus-within:ring-2 focus-within:ring-ring/30 motion-reduce:transition-none">
          <Textarea
            id="coach-message"
            aria-label="Message"
            rows={1}
            maxLength={session?.mode === 'solo' ? 600 : 2000}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Message…"
            disabled={!canSend}
            className="max-h-24 min-h-10 flex-1 resize-none border-0 bg-transparent px-2 py-2.5 text-sm shadow-none focus-visible:ring-0"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <Button
            type="submit"
            size="icon-sm"
            className="shrink-0 rounded-full"
            aria-label="Send message"
            disabled={!canSend || !draft.trim()}
          >
            <ArrowUp />
          </Button>
        </div>
        <MicrophoneControl />
      </form>
    </div>
  );
}

export function CoachPanel(props: ComposerProps) {
  return (
    <section aria-label="Conversation" className="flex h-full min-h-0 min-w-0 flex-col">
      <ConversationHistory />
      <MessageComposer {...props} />
    </section>
  );
}

export function CompactCoachPanel({ children, ...props }: ComposerProps & { children: ReactNode }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const id = useId();
  return (
    <div data-testid="compact-training" className="flex min-h-0 flex-1 flex-col gap-2">
      <div
        id={id}
        data-testid="shared-training-space"
        className={cn('flex min-h-0 flex-col overflow-hidden', historyOpen ? 'flex-1' : 'flex-[7]')}
      >
        {historyOpen ? (
          <section
            aria-label="Conversation"
            className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border/60 bg-card/50 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
          >
            <ConversationHistory autoFocus />
          </section>
        ) : (
          children
        )}
      </div>
      <div className={cn('flex flex-col', historyOpen ? 'shrink-0' : 'min-h-28 flex-[3]')}>
        {historyOpen ? (
          <div className="flex h-8 shrink-0 items-center justify-end px-2">
            <Button
              type="button"
              variant="text"
              size="xs"
              aria-expanded
              aria-controls={id}
              aria-label="Minimize conversation"
              onClick={() => setHistoryOpen(false)}
            >
              <ChevronsDown />
              Minimize
            </Button>
          </div>
        ) : (
          <div data-testid="conversation-preview" className="relative flex min-h-0 flex-1 flex-col">
            <div
              aria-hidden="true"
              className="flex h-7 shrink-0 items-center justify-end px-4 text-muted-foreground"
            >
              <ChevronsUp className="size-4" />
            </div>
            <ConversationHistory preview />
            <button
              type="button"
              aria-label="Expand conversation"
              aria-expanded={false}
              aria-controls={id}
              className="absolute inset-0 z-10 cursor-pointer rounded-xl outline-none transition-colors hover:bg-foreground/[.025] focus-visible:bg-foreground/5 motion-reduce:transition-none"
              onClick={() => setHistoryOpen(true)}
            />
          </div>
        )}
        <MessageComposer {...props} />
      </div>
    </div>
  );
}
