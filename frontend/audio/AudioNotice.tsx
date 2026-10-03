import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { studio, useStudio } from '@/studio/studio';
import type { AudioNoticeSurface } from '@/studio/store';

export function AudioNotice({ surface }: { surface: AudioNoticeSurface }) {
  const notice = useStudio((state) => state.audioNotices[surface]);
  const blocked = useStudio((state) => state.voiceBlocked);
  if (!notice) return null;
  return (
    <div
      data-testid={`audio-notice-${surface}`}
      role={notice.kind === 'error' ? 'alert' : 'status'}
      className="flex flex-wrap items-center gap-2 text-xs"
    >
      <AlertCircle className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 wrap-anywhere">{notice.message}</span>
      {blocked && notice.kind === 'error' && (
        <Button
          variant="text"
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={() => void studio.enableAudio(surface)}
        >
          Retry audio
        </Button>
      )}
      <Button
        variant="text"
        size="sm"
        className="h-8 px-2 text-xs"
        aria-label="Dismiss audio notice"
        onClick={() => studio.dismissAudioNotice(surface)}
      >
        Dismiss
      </Button>
    </div>
  );
}
