import { ArrowRight, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Brand } from '@/components/Brand';
import { InlineError } from '@/components/InlineError';
import { Instrument } from '@/instruments/Instrument';
import { InstrumentPicker } from '@/instruments/InstrumentPicker';
import { studio, useStudio } from '@/studio/studio';
import { MicrophoneSettings } from './MicrophoneSettings.js';
import { SpeakerSettings } from './AudioSettings.js';
import type { Settings } from '../../shared/types/user.js';

export function AudioSetup({
  onStart,
  defaults,
}: {
  onStart: () => void;
  defaults: Pick<Settings, 'instrument' | 'volume' | 'voiceVolume'>;
}) {
  const state = useStudio();
  const settings = state.snapshot?.settings ?? defaults;
  const pending = !state.snapshot || state.loading;
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center py-8 sm:py-12">
      <fieldset
        disabled={state.busy}
        className="grid min-w-0 items-center gap-10 md:grid-cols-[minmax(0,1.25fr)_minmax(280px,.85fr)] md:gap-12 lg:gap-20"
      >
        <div
          data-testid="setup-music"
          className="mx-auto flex w-full min-w-0 max-w-[600px] flex-col gap-4 lg:gap-5"
        >
          <header className="text-center">
            <h1>
              <Brand className="mx-auto h-16 sm:h-20 lg:h-22" />
            </h1>
            <p
              data-testid="setup-tagline"
              className="mt-4 text-xl leading-snug font-normal tracking-tight text-muted-foreground sm:text-2xl"
            >
              Ear training game with{' '}
              <span className="block font-medium text-foreground">a friendly AI tutor.</span>
            </p>
          </header>
          <section
            aria-label="Instrument preview"
            className="flex min-w-0 flex-col items-center gap-3"
          >
            <div className="flex aspect-[2.6/1] w-full items-center justify-center">
              <Instrument
                instrument={settings.instrument}
                interactive={!pending}
                onNote={(midi) => {
                  void studio.previewNote(midi);
                }}
                className="w-full"
              />
            </div>
            <InstrumentPicker instrument={settings.instrument} disabled={pending} />
          </section>
        </div>
        <section
          aria-label="Microphone and speaker setup"
          className="mx-auto w-full max-w-[430px] space-y-5"
        >
          <MicrophoneSettings />
          <SpeakerSettings
            volume={settings.volume}
            voiceVolume={settings.voiceVolume}
            pending={pending}
            surface="setup"
          />
          <InlineError />
          {!state.snapshot && state.error && !state.loading && !state.busy && (
            <Button variant="text" size="sm" onClick={() => void studio.refresh()}>
              Retry
            </Button>
          )}
          <Button
            size="lg"
            className="w-full rounded-full data-[starting=true]:bg-primary/90 data-[starting=true]:shadow-inner disabled:opacity-100"
            disabled={state.busy}
            aria-busy={state.busy}
            data-starting={state.busy}
            onClick={onStart}
          >
            {state.snapshot?.configured === false ? 'Practice offline' : 'Start training'}
            {state.busy ? (
              <LoaderCircle data-testid="start-spinner" className="motion-safe:animate-spin" />
            ) : (
              <ArrowRight />
            )}
          </Button>
        </section>
      </fieldset>
    </div>
  );
}
