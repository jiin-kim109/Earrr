import { useId } from 'react';
import { cn } from 'cn';
import { Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { InstrumentPicker } from '@/instruments/InstrumentPicker';
import { studio, useStudio } from '@/studio/studio';
import { AudioNotice } from './AudioNotice.js';
import type { AudioNoticeSurface } from '@/studio/store';

export function SpeakerSettings({
  volume,
  voiceVolume = volume,
  scrollable = false,
  pending = false,
  surface,
}: {
  volume: number;
  voiceVolume?: number;
  scrollable?: boolean;
  pending?: boolean;
  surface: AudioNoticeSurface;
}) {
  const state = useStudio();
  const id = useId();
  const outputs = state.devices.filter(
    (device) =>
      device.kind === 'audiooutput' &&
      device.deviceId &&
      !['default', 'communications'].includes(device.deviceId),
  );
  const choices = [
    { id: '', label: 'System default', unavailable: false },
    ...outputs.map((device, index) => ({
      id: device.deviceId,
      label: device.label || `Speakers ${index + 1}`,
      unavailable: false,
    })),
  ];
  if (state.speakerDevice && !outputs.some((device) => device.deviceId === state.speakerDevice)) {
    choices.push({
      id: state.speakerDevice,
      label: 'Saved speaker (unavailable)',
      unavailable: true,
    });
  }
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h2 id={id} className="text-sm font-medium">
        Speakers
      </h2>
      <RadioGroup
        aria-labelledby={id}
        value={state.speakerDevice}
        disabled={!studio.audio.supportsOutputSelection()}
        className={cn(
          'gap-0.5',
          scrollable &&
            'scrollbar-thin scrollbar-thumb-muted-foreground/60 scrollbar-track-transparent max-h-32 overflow-y-auto',
        )}
        onValueChange={(device) => {
          void studio.chooseSpeaker(device);
        }}
      >
        {choices.map((device, index) => (
          <div key={device.id} className="flex min-h-8 items-center gap-3 px-0.5">
            <RadioGroupItem value={device.id} id={`${id}-${index}`} disabled={device.unavailable} />
            <Label
              htmlFor={`${id}-${index}`}
              className="min-w-0 flex-1 cursor-pointer py-1.5 text-xs leading-snug font-normal"
            >
              {device.label}
            </Label>
          </div>
        ))}
      </RadioGroup>
      <AudioNotice surface={surface} />
      <div className="space-y-3 pt-2">
        {(
          [
            { key: 'voiceVolume', label: 'Tutor voice', value: voiceVolume },
            { key: 'volume', label: 'Instrument sound', value: volume },
          ] as const
        ).map((control) => (
          <div key={control.key}>
            <div className="mb-1 flex items-center justify-between gap-3">
              <Label htmlFor={`${id}-${control.key}`} className="text-sm font-medium">
                {control.label}
              </Label>
              <span className="text-xs text-muted-foreground tabular-nums">
                {Math.round(control.value * 100)}%
              </span>
            </div>
            <Slider
              id={`${id}-${control.key}`}
              aria-label={control.label}
              value={[control.value * 100]}
              disabled={pending}
              min={0}
              max={100}
              step={5}
              className="h-6"
              onValueChange={([value]) => {
                if (value !== undefined) void studio.updateSettings({ [control.key]: value / 100 });
              }}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

export function AudioSettings() {
  const settings = useStudio((state) => state.snapshot!.settings);
  const volume = settings.volume;
  const notice = useStudio((state) => state.audioNotices.lesson);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-12 shrink-0 rounded-full"
          aria-label="Audio settings"
          title="Audio settings"
          data-audio-notice={Boolean(notice)}
        >
          {volume === 0 && (settings.voiceVolume ?? volume) === 0 ? (
            <VolumeX className={`size-6${notice ? ' text-destructive' : ''}`} />
          ) : (
            <Volume2 className={`size-6${notice ? ' text-destructive' : ''}`} />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        aria-label="Audio settings"
        className="scrollbar-thin scrollbar-thumb-muted-foreground/60 scrollbar-track-transparent max-h-(--radix-popover-content-available-height) w-80 max-w-[calc(100vw-1.5rem)] space-y-4 overflow-y-auto rounded-2xl p-5"
      >
        <SpeakerSettings
          volume={volume}
          voiceVolume={settings.voiceVolume}
          surface="lesson"
          scrollable
        />
        <InstrumentPicker instrument={settings.instrument} badge showLabel={false} />
      </PopoverContent>
    </Popover>
  );
}
