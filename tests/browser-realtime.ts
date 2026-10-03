import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

interface TraceEvent {
  type: string;
  id?: string;
  turn?: string;
  status?: string;
  tools?: string[];
  audio?: boolean;
}

export const realtimeTraceScript = `(() => {
  window.earrrProtocolTrace = [];
  const create = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (...args) {
    const channel = create.apply(this, args);
    channel.addEventListener('message', (message) => {
      const event = JSON.parse(message.data);
      if (['response.created', 'response.done', 'output_audio_buffer.started', 'output_audio_buffer.stopped', 'output_audio_buffer.cleared', 'input_audio_buffer.committed', 'error'].includes(event.type)) {
        window.earrrProtocolTrace.push({
          type: event.type, id: event.response_id || event.response?.id, status: event.response?.status,
          turn: event.response?.metadata?.earrr_turn,
          tools: event.response?.output?.filter(item => item.type === 'function_call').map(item => item.name),
          audio: event.response?.output?.some(item => item.content?.some(part => part.type === 'audio' || part.type === 'output_audio')),
          error: event.error?.message
        });
      }
    });
    return channel;
  };
})();`;

const trace = (page: Page): Promise<TraceEvent[]> =>
  page.evaluate(() => Reflect.get(window, 'earrrProtocolTrace'));
export async function turnMarker(page: Page): Promise<number> {
  return (await trace(page)).length;
}

export async function expectOneSpokenReply(page: Page, marker: number, label: string) {
  await expect
    .poll(
      async () => {
        const events = (await trace(page)).slice(marker);
        return events.some(
          (item) =>
            item.type === 'response.done' &&
            item.status === 'completed' &&
            item.audio &&
            events.some(
              (other) => other.type === 'output_audio_buffer.stopped' && other.id === item.id,
            ),
        );
      },
      { timeout: 60_000, message: `${label}: wait for final spoken playback` },
    )
    .toBe(true);
  const events = (await trace(page)).slice(marker);
  const generated = events.filter((item) => item.type === 'response.created');
  const spoken = events.filter(
    (item) => item.type === 'response.done' && item.status === 'completed' && item.audio,
  );
  expect(spoken, `${label}: exactly one audio reply`).toHaveLength(1);
  expect(
    generated.every((item) => item.turn !== undefined),
    `${label}: responses must belong to controlled turns`,
  ).toBe(true);
  const audio = [
    ...new Set(
      events.filter((item) => item.type === 'output_audio_buffer.started').map((item) => item.id),
    ),
  ];
  expect(
    audio.some((id) => generated.some((response) => response.id === id)),
    `${label}: native audio must start in this turn`,
  ).toBe(true);
  expect(
    events.some(
      (event) => event.type === 'output_audio_buffer.stopped' && event.id === spoken[0]!.id,
    ),
    `${label}: the final shared audio buffer must drain`,
  ).toBe(true);
  expect(
    events
      .filter((event) => event.type === 'response.done' && event.tools?.length)
      .every((event) => !event.audio),
    `${label}: tool selection must be silent`,
  ).toBe(true);
  console.log(`PASS ${label}: native realtime reply after ordered tool processing`);
}

export async function expectDirectPlayback(
  page: Page,
  marker: number,
  tool: string,
  label: string,
) {
  await expect
    .poll(
      async () =>
        (await trace(page))
          .slice(marker)
          .some(
            (event) =>
              event.type === 'response.done' &&
              event.status === 'completed' &&
              event.tools?.includes(tool),
          ),
      { timeout: 30_000, message: `${label}: action completed` },
    )
    .toBe(true);
  await expect(page.getByLabel('Exercise player', { exact: true })).toHaveAttribute(
    'data-phase',
    'listening',
    { timeout: 20_000 },
  );
  const events = (await trace(page)).slice(marker);
  const action = events
    .filter(
      (event) =>
        event.type === 'response.done' &&
        event.status === 'completed' &&
        event.tools?.includes(tool),
    )
    .at(-1)!;
  expect(
    events.filter((event) => event.type === 'response.created' && event.turn === action.turn),
    `${label}: no redundant follow-up generation`,
  ).toHaveLength(1);
  expect(
    events.filter(
      (event) =>
        event.type === 'response.done' &&
        event.turn === action.turn &&
        event.status === 'completed' &&
        !event.tools?.length,
    ),
    `${label}: no second spoken response`,
  ).toHaveLength(0);
  console.log(`PASS ${label}: one model tool turn, then direct piano playback`);
}
