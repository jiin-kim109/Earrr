import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { studio, useStudio } from '@/studio/studio';
import { MicrophoneIndicator } from './MicrophoneIndicator.js';

export function MicrophoneSettings({
  id = 'microphone-device',
  scrollable = false,
}: {
  id?: string;
  scrollable?: boolean;
}) {
  const state = useStudio();
  const active = state.hasMicrophone || state.previewingMicrophone;
  const inputs = state.devices.filter(
    (device) =>
      device.kind === 'audioinput' &&
      device.deviceId &&
      device.deviceId !== 'default' &&
      device.deviceId !== 'communications',
  );
  const available = state.devices.some((device) => device.kind === 'audioinput');
  const options = inputs.length
    ? inputs.map((device, index) => ({
        id: device.deviceId,
        label: device.label || `Microphone ${index + 1}`,
      }))
    : available
      ? [{ id: '', label: 'System microphone' }]
      : [];
  const canCapture = state.setupOpen || state.connection === 'connected';
  const selected =
    active || state.micBusy
      ? ['default', 'communications'].includes(state.microphoneDevice)
        ? ''
        : state.microphoneDevice
      : 'none';
  if (selected === '' && inputs.length && available)
    options.unshift({ id: '', label: 'System microphone' });
  const toggle = () => {
    if (active || state.micBusy) void studio.chooseMicrophone('none');
    else if (state.setupOpen) void studio.previewMicrophone();
    else void studio.toggleMicrophone();
  };
  return (
    <section aria-labelledby={`${id}-label`} className="space-y-2">
      <h2 id={`${id}-label`} className="text-sm font-medium">
        Microphone
      </h2>
      <RadioGroup
        aria-labelledby={`${id}-label`}
        value={selected}
        disabled={!canCapture}
        className={cn(
          'gap-0.5',
          scrollable &&
            'scrollbar-thin scrollbar-thumb-muted-foreground/60 scrollbar-track-transparent max-h-32 overflow-y-auto',
        )}
        onValueChange={(device) => {
          void studio.chooseMicrophone(device);
        }}
      >
        <div className="flex min-h-8 items-center gap-3 px-0.5">
          <RadioGroupItem value="none" id={`${id}-none`} />
          <Label
            htmlFor={`${id}-none`}
            className="flex-1 cursor-pointer py-1.5 text-xs font-normal"
          >
            None
          </Label>
        </div>
        {options.map((device, index) => (
          <div key={device.id} className="flex min-h-8 items-center gap-3 px-0.5">
            <RadioGroupItem value={device.id} id={`${id}-${index}`} />
            <Label
              htmlFor={`${id}-${index}`}
              className="min-w-0 flex-1 cursor-pointer py-1.5 text-xs leading-snug font-normal"
            >
              {device.label}
            </Label>
          </div>
        ))}
      </RadioGroup>
      {!available && <p className="py-1 text-xs text-muted-foreground">No microphone detected</p>}
      <div className="flex h-10 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="-ml-2 rounded-lg"
          aria-label={
            active
              ? 'Turn microphone off'
              : state.micBusy
                ? 'Cancel microphone request'
                : 'Turn microphone on'
          }
          disabled={!canCapture || (!available && !active && !state.micBusy)}
          onClick={toggle}
        >
          <MicrophoneIndicator active={active} className="size-5 [&_svg]:size-5" />
        </Button>
        <MicrophoneIndicator active={active} meter icon={false} />
      </div>
      {state.micBusy && (
        <p role="status" className="text-xs text-muted-foreground">
          Waiting for permission…
        </p>
      )}
      {state.microphoneError && (
        <p role="alert" className="text-xs text-destructive">
          {state.microphoneError}
        </p>
      )}
    </section>
  );
}

export function MicrophoneControl() {
  const hasMicrophone = useStudio((state) => state.hasMicrophone);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          size="icon-lg"
          className="size-12 shrink-0 rounded-full"
          aria-label="Microphone settings"
          title={hasMicrophone ? 'Microphone on' : 'Microphone off'}
        >
          <MicrophoneIndicator active={hasMicrophone} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        aria-label="Microphone settings"
        className="scrollbar-thin scrollbar-thumb-muted-foreground/60 scrollbar-track-transparent max-h-(--radix-popover-content-available-height) w-80 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-2xl p-5"
      >
        <MicrophoneSettings id="chat-microphone-device" scrollable />
      </PopoverContent>
    </Popover>
  );
}
