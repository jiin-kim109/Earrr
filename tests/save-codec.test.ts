import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SaveCodec } from '../server/services/storage/save-codec.js';

describe('portable encrypted learning saves', () => {
  const codec = new SaveCodec(Buffer.alloc(32, 7).toString('base64'));
  const save = { id: randomUUID(), revision: 9, archive: { version: 1 as const, tables: {} } };
  it('round-trips authenticated checkpoints and binds them to one owner', () => {
    const encrypted = codec.seal(`account:${save.id}`, save);
    expect(codec.open(`account:${save.id}`, encrypted)).toEqual(save);
    expect(encrypted).not.toContain(save.id);
    expect(() => codec.open('guest', encrypted)).toThrow('saved progress');
    const tampered = `${encrypted.slice(0, 20)}${encrypted[20] === 'A' ? 'B' : 'A'}${encrypted.slice(21)}`;
    expect(() => codec.open(`account:${save.id}`, tampered)).toThrow('saved progress');
  });
  it('rejects archives beyond the restore limit before they can replace a valid save', () => {
    expect(() =>
      codec.seal('guest', {
        ...save,
        archive: { version: 1, tables: { transcripts: [{ data: 'x'.repeat(64_000_000) }] } },
      }),
    ).toThrow('storage limit');
  });
  it('encrypts complete canonical dialogue without changing the archive version or owner binding', () => {
    const sessionId = randomUUID();
    const message = {
      id: 'assistant:saved-response',
      sessionId,
      role: 'assistant',
      text: 'Saved literal conversation.',
      createdAt: '2026-10-02T10:00:00.000Z',
      delivery: 'interrupted',
      feedbackId: randomUUID(),
    };
    const withChat = {
      ...save,
      archive: {
        version: 1 as const,
        tables: {
          transcripts: [
            { seq: 1, id: message.id, session_id: sessionId, data: JSON.stringify(message) },
          ],
        },
      },
    };
    const encrypted = codec.seal(`account:${save.id}`, withChat);
    expect(encrypted).not.toContain(message.text);
    expect(codec.open(`account:${save.id}`, encrypted)).toEqual(withChat);
    expect(() => codec.open(`account:${randomUUID()}`, encrypted)).toThrow('saved progress');
  });
  it('requires a stable 32-byte encryption key', () => {
    expect(() => new SaveCodec('short')).toThrow('32-byte key');
  });
});
