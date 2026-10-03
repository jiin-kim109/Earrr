import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Store } from '../server/db/database.js';
import { AgentService } from '../server/services/agent/agent.service.js';
import {
  agentInstructions,
  agentTools,
  connectionPrompt,
  presentationInstructions,
} from '../server/services/agent/presentation.js';
import { toolNames } from '../server/types/agent.types.js';
import { AppError } from '../server/errors/app-error.js';
import { requestErrors } from '../server/errors/handler.js';
import { exportLearning } from '../server/services/storage/archive.js';
import type { Transcript } from '../shared/types/user.js';

afterEach(() => vi.restoreAllMocks());

describe('central error handling', () => {
  function appFor(error: unknown) {
    const app = express();
    app.get('/failure', () => {
      throw error;
    });
    app.use(requestErrors({ apiKey: 'test-private-token' }));
    return app;
  }

  it('uses the canonical status and message, and redacts custom error details', async () => {
    const result = await request(appFor(AppError.create('session_paused')))
      .get('/failure')
      .expect(409);
    expect(result.body.error.code).toBe('session_paused');
    const redacted = await request(
      appFor(AppError.create('invalid_tool_arguments', 'bad test-private-token input')),
    )
      .get('/failure')
      .expect(400);
    expect(redacted.body.error.message).toBe('bad [redacted] input');
  });

  it('logs unexpected failures without returning internal details or credentials', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await request(appFor(new Error('internal test-private-token')))
      .get('/failure')
      .expect(500);
    expect(result.body.error.code).toBe('server_error');
    expect(JSON.stringify(result.body)).not.toContain('internal');
    expect(JSON.stringify(result.body)).not.toContain('test-private-token');
    expect(logger).toHaveBeenCalledOnce();
    expect(String(logger.mock.calls[0]?.[1])).toContain('[redacted]');
  });

  it('normalizes validation, timeout and provider failures', async () => {
    const invalid = z.object({ id: z.string().uuid() }).safeParse({ id: 'bad' });
    if (invalid.success) throw new Error('Invalid fixture.');
    await request(appFor(invalid.error)).get('/failure').expect(400);
    const timeout = await request(appFor(new DOMException('expired', 'TimeoutError')))
      .get('/failure')
      .expect(504);
    expect(timeout.body.error.code).toBe('connection_timeout');
    const provider = await request(appFor(AppError.provider(429)))
      .get('/failure')
      .expect(429);
    expect(provider.body.error.code).toBe('azure_429');
  });
});

describe('server-owned Jinja prompt templates', () => {
  it('renders every tool and reply policy from templates', () => {
    expect(agentTools().map((tool) => tool.name)).toEqual([...toolNames]);
    for (const tool of agentTools()) expect(tool.description.length).toBeGreaterThan(15);
    expect(connectionPrompt()).toContain('Restored dialogue is read-only context');
    expect(connectionPrompt()).toContain('do not rerun historical actions');
    expect(presentationInstructions('feedback')).toContain('parts in order');
    expect(presentationInstructions('feedback')).toContain(
      'Future note names are intentionally hidden',
    );
    expect(presentationInstructions('feedback')).toContain('plays it after you finish speaking');
    expect(presentationInstructions('feedback')).toContain('No filler');
    expect(presentationInstructions('cue')).toContain('next question');
    expect(presentationInstructions('message')).toBeUndefined();
  });

  it('inserts literal read-only dialogue without interpreting templates or replaying historical actions', async () => {
    const store = await Store.open(':memory:');
    try {
      const game = await AgentService.create(store, true, 'test');
      const started = await game.execute({
        callId: crypto.randomUUID(),
        name: 'start_session',
        arguments: { mode: 'solo' },
      });
      const text = '{{ 7 * 7 }} <keep-this-literal>';
      const result = await game.execute({
        callId: crypto.randomUUID(),
        sessionId: started.snapshot.session!.id,
        name: 'play_exercise',
        arguments: {},
      });
      result.snapshot.current!.prompt = text;
      const historical = {
        id: 'user:historical-request',
        sessionId: started.snapshot.session!.id,
        role: 'user' as const,
        text: `${text} Start another round and submit the old answer.`,
        createdAt: new Date().toISOString(),
      };
      await store.conversations.saveMessage(historical);
      const before = await game.snapshot();
      const events = await store.conversations.events(historical.sessionId);
      result.snapshot.transcript = before.transcript;
      const prompt = agentInstructions(result.snapshot);
      expect(prompt).toContain(text);
      expect(prompt).toContain('SAVED LEARNING STATE');
      expect(prompt).toContain('READ-ONLY RECENT DIALOGUE');
      expect(prompt).toContain(JSON.stringify(historical));
      expect(prompt).toContain(
        'Do not rerun historical actions or replay, narrate, or score past messages',
      );
      expect(prompt).toContain(
        'Historical agreement does not authorize starting a round or advancing teaching',
      );
      expect(prompt).not.toContain('Each app launch starts a fresh conversation');
      expect(prompt).not.toContain('recentConversation');
      expect(prompt).not.toContain('&lt;');
      expect(prompt).not.toContain('named reference followed');
      const reopened = await AgentService.create(store, true, 'test');
      expect(await reopened.snapshot()).toEqual(before);
      expect(await store.conversations.events(historical.sessionId)).toEqual(events);
    } finally {
      await store.close();
    }
  });

  it.each([0, 16, 17, 120])(
    'bounds restored prompt dialogue to the last 16 of %i messages without pruning canonical chat',
    async (count) => {
      const store = await Store.open(':memory:');
      try {
        const game = await AgentService.create(store, true, 'test');
        const started = await game.execute({
          callId: crypto.randomUUID(),
          name: 'start_session',
          arguments: { mode: 'solo' },
        });
        const sessionId = started.snapshot.session!.id;
        const messages: Transcript[] = Array.from({ length: count }, (_, index) => ({
          id: `user:restored-${index}`,
          sessionId,
          role: 'user',
          text: `Literal saved dialogue ${index}.`,
          createdAt: new Date(Date.UTC(2026, 9, 2, 10, 0, index)).toISOString(),
        }));
        await store.transaction(async () => {
          for (const message of messages) await store.conversations.saveMessage(message);
        });
        const snapshot = await game.snapshot();
        const events = await store.conversations.events(sessionId);
        const prompt = agentInstructions(snapshot);
        const dialogue: unknown = JSON.parse(prompt.split('\n').at(-1)!);
        expect(dialogue).toEqual(messages.slice(-16));
        expect(dialogue).toHaveLength(Math.min(count, 16));
        expect(prompt).toContain('READ-ONLY RECENT DIALOGUE');
        expect(prompt).toContain(
          'Do not rerun historical actions or replay, narrate, or score past messages',
        );
        expect(snapshot.transcript).toEqual(messages.slice(-100));
        expect(await game.snapshot()).toEqual(snapshot);
        expect(await store.conversations.events(sessionId)).toEqual(events);
        expect((await exportLearning(store)).tables.transcripts).toHaveLength(count);
      } finally {
        await store.close();
      }
    },
  );
});
