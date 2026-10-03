import { describe, expect, it, vi } from 'vitest';
import { createStudioStore } from '../frontend/studio/store.js';

describe('one Zustand studio state', () => {
  it('merges device and UI changes without duplicating state or mutating prior snapshots', () => {
    const store = createStudioStore();
    const initial = store.getState();
    const changes = vi.fn();
    const unsubscribe = store.subscribe(changes);
    store.setState({ busy: true, microphoneDevice: 'usb' });
    expect(changes).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      busy: true,
      microphoneDevice: 'usb',
      phase: 'ready',
      setupOpen: true,
    });
    expect(initial.busy).toBe(false);
    expect(initial.microphoneDevice).toBe('none');
    store.setState({ phase: 'speaking' });
    expect(store.getState().microphoneDevice).toBe('usb');
    expect(changes).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.setState({ busy: false });
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('keeps fresh stores independent without storing AudioContext or Realtime transport in state', () => {
    const first = createStudioStore();
    const second = createStudioStore();
    first.setState({
      messages: [
        {
          id: 'one',
          sessionId: 'session',
          role: 'assistant',
          text: 'Listen.',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(second.getState().messages).toEqual([]);
    expect(first.getState()).not.toHaveProperty('audio');
    expect(first.getState()).not.toHaveProperty('transport');
    expect(first.getState()).not.toHaveProperty('feedback');
  });
});
