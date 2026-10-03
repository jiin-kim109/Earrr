import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { User } from '@supabase/supabase-js';
import { WorkspaceDirectory } from '../server/services/storage/workspace.js';
import { CloudRepository } from '../server/repositories/cloud.repository.js';
import { AppError } from '../server/errors/app-error.js';
import { createApp } from '../server/app.js';
import request from 'supertest';
import type { Config } from '../server/config/environment.js';
import type { CloudSave } from '../server/repositories/cloud.repository.js';
import { exportLearning } from '../server/services/storage/archive.js';
import type { Transcript } from '../shared/types/user.js';

const config: Config = {
  port: 3105,
  databasePath: ':memory:',
  azureEndpoint: '',
  apiKey: '',
  configured: false,
  deployment: 'test',
  transcriptionDeployment: '',
  supabaseUrl: 'https://example.supabase.co',
  supabasePublishableKey: 'test-public-key',
  supabaseServiceKey: 'test-server-key',
  learningSaveKey: Buffer.alloc(32, 3).toString('base64'),
};
let directory: WorkspaceDirectory;
let saved: Map<string, CloudSave>;
const accountA = randomUUID(),
  accountB = randomUUID();
beforeEach(() => {
  saved = new Map();
  vi.spyOn(CloudRepository.prototype, 'user').mockImplementation(async (token) => {
    if (!['A', 'B'].includes(token)) throw AppError.create('invalid_auth_session');
    return {
      id: token === 'A' ? accountA : accountB,
      email: `${token}@example.com`,
      email_confirmed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
    } as User;
  });
  vi.spyOn(CloudRepository.prototype, 'get').mockImplementation(
    async (id) => saved.get(id) ?? null,
  );
  vi.spyOn(CloudRepository.prototype, 'put').mockImplementation(
    async (id, revision, payload, imported) => {
      if ((saved.get(id)?.revision ?? 0) !== revision) throw AppError.create('cloud_save_conflict');
      saved.set(id, { revision: revision + 1, payload, imported_guest_id: imported });
    },
  );
  directory = new WorkspaceDirectory(config);
});
afterEach(async () => {
  await directory.close();
  vi.restoreAllMocks();
});

function chatMessage(sessionId: string, text: string): Transcript {
  return {
    id: randomUUID(),
    sessionId,
    role: 'assistant',
    text,
    createdAt: new Date().toISOString(),
    delivery: 'spoken',
  };
}

async function practice(
  workspace: Awaited<ReturnType<WorkspaceDirectory['createGuest']>>['workspace'],
) {
  const started = await workspace.game.execute({
    callId: randomUUID(),
    name: 'start_session',
    arguments: { mode: 'solo' },
  });
  const sessionId = started.snapshot.session!.id;
  const played = await workspace.game.execute({
    callId: randomUUID(),
    sessionId,
    name: 'play_exercise',
    arguments: {},
  });
  const exercise = (await workspace.store.exercises.get(played.snapshot.current!.id))!;
  const answer = await workspace.game.execute({
    callId: randomUUID(),
    sessionId,
    name: 'submit_answer',
    arguments: { exerciseId: exercise.id, answer: exercise.expected },
  });
  return { answer, exercise, sessionId };
}

describe('separate browser guest and cloud account workspaces', () => {
  it('restores guest state from an opaque local checkpoint after server restart', async () => {
    const { workspace } = await directory.createGuest();
    const initial = await practice(workspace);
    const message = {
      ...chatMessage(initial.sessionId, 'The second note was higher.'),
      feedbackId: initial.answer.snapshot.feedback!.attemptId!,
    };
    await workspace.store.conversations.saveMessage(message);
    const records = await exportLearning(workspace.store);
    const local = workspace.guestSave!;
    expect(local.learningStarted).toBe(true);
    expect(local.checkpoint).not.toContain('expected');
    await directory.close();
    directory = new WorkspaceDirectory(config);
    const restored = (await directory.createGuest(local)).workspace;
    const snapshot = await restored.game.snapshot();
    expect(snapshot.session?.id).toBe(initial.sessionId);
    expect(snapshot.current?.id).toBe(initial.exercise.id);
    expect(snapshot.totalAnswers).toBe(1);
    expect(snapshot.course.round.correct).toBe(1);
    expect(snapshot.transcript).toEqual([message]);
    expect(await exportLearning(restored.store)).toEqual(records);
    expect(restored.guestSave!.revision).toBe(local.revision);
  });

  it('imports verified guest progress once, then discards its execution workspace', async () => {
    const guest = await directory.createGuest();
    const result = await practice(guest.workspace);
    const message = chatMessage(result.sessionId, 'Keep this conversation after signup.');
    await guest.workspace.store.conversations.saveMessage(message);
    const local = guest.workspace.guestSave!;
    const imported = await directory.migrate('A', guest.token, local);
    const snapshot = await imported.game.snapshot();
    expect(snapshot.totalAnswers).toBe(1);
    expect(snapshot.current?.id).toBe(result.exercise.id);
    expect(snapshot.course.round.correct).toBe(1);
    expect(snapshot.transcript).toEqual([message]);
    expect(saved.get(accountA)?.imported_guest_id).toBe(guest.workspace.id);
    await expect(directory.guest(guest.token)).rejects.toThrow('guest session');
    expect((await directory.migrate('A', guest.token, local)).id).toBe(accountA);
    expect((await directory.account('B')).learningStarted).toBe(false);
    await directory.close();
    directory = new WorkspaceDirectory(config);
    const restored = await directory.account('A');
    expect((await restored.game.snapshot()).transcript).toEqual([message]);
    expect(restored.importedGuestId).toBe(guest.workspace.id);
    expect(saved.get(accountA)?.imported_guest_id).toBe(guest.workspace.id);
    expect((await directory.migrate('A', guest.token, local)).id).toBe(accountA);
  });

  it('restores complete learning, per-mode tutorial positions and cross-session dialogue together', async () => {
    const guest = await directory.createGuest();
    const { workspace } = guest;
    await workspace.store.transaction(async () => {
      await workspace.store.progress.completeLesson('pitch-direction', new Date().toISOString());
      await workspace.store.user.saveSettings({
        ...(await workspace.store.user.getSettings()),
        instrument: 'guitar',
        volume: 0.42,
      });
    });
    const coach = await workspace.game.execute({
      callId: randomUUID(),
      name: 'start_session',
      arguments: { mode: 'coach', focus: 'intervals-foundation' },
    });
    const coachId = coach.snapshot.session!.id;
    const demo = await workspace.game.execute({
      callId: randomUUID(),
      sessionId: coachId,
      name: 'teach_lesson',
      arguments: { stepId: 'major-third' },
    });
    const { app } = await createApp(config, directory);
    await request(app)
      .post('/api/teaching/delivered')
      .set('x-earrr-client', '1')
      .set('x-earrr-guest', guest.token)
      .send({ sessionId: coachId, presentationId: demo.teaching!.presentationId })
      .expect(200);
    await workspace.game.execute({
      callId: randomUUID(),
      sessionId: coachId,
      name: 'end_session',
      arguments: {},
    });
    const solo = await practice(workspace);
    const pending = await workspace.game.execute({
      callId: randomUUID(),
      sessionId: solo.sessionId,
      name: 'play_exercise',
      arguments: {},
    });
    await request(app)
      .post('/api/playback')
      .set('x-earrr-client', '1')
      .set('x-earrr-guest', guest.token)
      .send({
        id: randomUUID(),
        sessionId: solo.sessionId,
        exerciseId: pending.snapshot.current!.id,
      })
      .expect(200);
    await workspace.game.execute({
      callId: randomUUID(),
      sessionId: solo.sessionId,
      name: 'end_session',
      arguments: {},
    });
    const resumed = await workspace.game.execute({
      callId: randomUUID(),
      name: 'start_session',
      arguments: { mode: 'coach', focus: 'intervals-foundation' },
    });
    await workspace.store.conversations.saveMessage(
      chatMessage(coachId, 'A saved tutorial explanation.'),
    );
    await workspace.store.conversations.saveMessage({
      ...chatMessage(solo.sessionId, 'The interval sounded like a third.'),
      role: 'user',
    });
    await workspace.store.conversations.saveMessage({
      ...chatMessage(resumed.snapshot.session!.id, 'Return to the tutorial when ready.'),
      delivery: 'interrupted',
      feedbackId: solo.answer.snapshot.feedback!.attemptId!,
    });
    const before = await workspace.game.snapshot();
    const records = await exportLearning(workspace.store);
    expect(records.tables.lesson_completions).toHaveLength(1);
    expect(records.tables.playback_receipts).toHaveLength(1);
    expect(
      records.tables.lesson_positions!.some(
        (row) =>
          row.mode === 'coach' &&
          JSON.parse(String(row.data)).playedTutorialSteps.includes('major-third'),
      ),
    ).toBe(true);
    expect(
      records.tables.lesson_positions!.some(
        (row) =>
          row.mode === 'solo' &&
          JSON.parse(String(row.data)).currentExerciseId === pending.snapshot.current!.id,
      ),
    ).toBe(true);
    expect(before.teaching?.playedSteps).toContain('major-third');
    const local = workspace.guestSave!;
    await directory.close();
    directory = new WorkspaceDirectory(config);
    const restored = (await directory.createGuest(local)).workspace;
    expect(await restored.game.snapshot()).toEqual(before);
    expect(await exportLearning(restored.store)).toEqual(records);
    expect(restored.revision).toBe(local.revision);
  });

  it.each(['guest', 'account'] as const)(
    'restores version-1 %s archives without a transcript table as empty chat without changing learning',
    async (kind) => {
      const workspace =
        kind === 'guest' ? (await directory.createGuest()).workspace : await directory.account('A');
      await practice(workspace);
      const records = await exportLearning(workspace.store);
      const withoutChat = { ...records, tables: { ...records.tables } };
      delete withoutChat.tables.transcripts;
      const source = {
        id: workspace.id,
        revision: workspace.revision,
        learningStarted: workspace.learningStarted,
        checkpoint: directory.codec.encode('guest', workspace.id, workspace.revision, withoutChat),
      };
      const receipt = kind === 'account' ? randomUUID() : null;
      if (kind === 'account') {
        saved.set(accountA, {
          revision: workspace.revision,
          payload: directory.codec.encode(
            `account:${accountA}`,
            accountA,
            workspace.revision,
            withoutChat,
          ),
          imported_guest_id: receipt,
        });
      }
      const before = await workspace.game.snapshot();
      await directory.close();
      directory = new WorkspaceDirectory(config);
      const restored =
        kind === 'guest'
          ? (await directory.createGuest(source)).workspace
          : await directory.account('A');
      expect((await restored.game.snapshot()).transcript).toEqual([]);
      expect(await restored.game.snapshot()).toEqual(before);
      expect(await exportLearning(restored.store)).toEqual(records);
      expect(restored.revision).toBe(source.revision);
      expect(restored.importedGuestId).toBe(receipt);
      if (kind === 'account') expect(saved.get(accountA)?.imported_guest_id).toBe(receipt);
    },
  );

  it('rejects mismatched canonical transcript ownership without deleting the valid guest checkpoint', async () => {
    const { workspace } = await directory.createGuest();
    const initial = await practice(workspace);
    const message = chatMessage(initial.sessionId, 'The valid owner keeps this chat.');
    await workspace.store.conversations.saveMessage(message);
    const source = workspace.guestSave!;
    const archive = await exportLearning(workspace.store);
    archive.tables.transcripts![0]!.data = JSON.stringify({ ...message, sessionId: randomUUID() });
    const invalid = {
      ...source,
      checkpoint: directory.codec.encode('guest', source.id, source.revision, archive),
    };
    await directory.close();
    directory = new WorkspaceDirectory(config);
    await expect(directory.createGuest(invalid)).rejects.toThrow('invalid transcript owner');
    const restored = (await directory.createGuest(source)).workspace;
    expect((await restored.game.snapshot()).transcript).toEqual([message]);
    expect((await restored.game.snapshot()).totalAnswers).toBe(1);
    expect(restored.guestSave!.revision).toBe(source.revision);
  });

  it('rolls back an unencodable guest transcript save and retries without losing its checkpoint', async () => {
    const { workspace, token } = await directory.createGuest();
    const initial = await practice(workspace);
    const message = chatMessage(initial.sessionId, 'Retry this same message ID.');
    const previous = workspace.guestSave!;
    const records = await exportLearning(workspace.store);
    const { app } = await createApp(config, directory);
    vi.spyOn(directory.codec, 'encode').mockImplementationOnce(() => {
      throw AppError.create('learning_storage_full');
    });
    await request(app)
      .post('/api/transcript')
      .set('x-earrr-client', '1')
      .set('x-earrr-guest', token)
      .send(message)
      .expect(507);
    expect(workspace.guestSave).toEqual(previous);
    expect(workspace.revision).toBe(previous.revision);
    expect(await exportLearning(workspace.store)).toEqual(records);
    const retry = await request(app)
      .post('/api/transcript')
      .set('x-earrr-client', '1')
      .set('x-earrr-guest', token)
      .send(message)
      .expect(200);
    expect(retry.body.guestSave.revision).toBe(previous.revision + 1);
    expect((await workspace.game.snapshot()).transcript).toEqual([message]);
    expect((await workspace.game.snapshot()).totalAnswers).toBe(1);
  });

  it('saves cloud dialogue through the HTTP acknowledgement and restores it only for that account', async () => {
    const workspace = await directory.account('A');
    const initial = await practice(workspace);
    const message: Transcript = {
      ...chatMessage(initial.sessionId, 'A literal conversation saved to this account.'),
      delivery: 'interrupted',
      feedbackId: initial.answer.snapshot.feedback!.attemptId!,
    };
    const records = await exportLearning(workspace.store);
    const revision = workspace.revision;
    const { app } = await createApp(config, directory);
    const response = await request(app)
      .post('/api/transcript')
      .set('x-earrr-client', '1')
      .set('Authorization', 'Bearer A')
      .send(message)
      .expect(200);
    expect(response.body.data).toBeNull();
    expect(response.body.learningStarted).toBe(true);
    expect(response.body).not.toHaveProperty('guestSave');
    expect(saved.get(accountA)!.revision).toBe(revision + 1);
    expect(saved.get(accountA)!.payload).not.toContain(message.text);
    const committed = await exportLearning(workspace.store);
    expect({ ...committed.tables, transcripts: [] }).toEqual(records.tables);
    await directory.close();
    directory = new WorkspaceDirectory(config);
    const restored = await directory.account('A');
    expect((await restored.game.snapshot()).transcript).toEqual([message]);
    expect(await exportLearning(restored.store)).toEqual(committed);
    expect((await (await directory.account('B')).game.snapshot()).transcript).toEqual([]);
    expect((await (await directory.createGuest()).workspace.game.snapshot()).transcript).toEqual(
      [],
    );
    const next = await createApp(config, directory);
    await request(next.app)
      .post('/api/transcript')
      .set('x-earrr-client', '1')
      .set('Authorization', 'Bearer A')
      .send(message)
      .expect(200);
    expect(restored.revision).toBe(revision + 1);
    expect((await exportLearning(restored.store)).tables.transcripts).toHaveLength(1);
  });

  it.each([false, true])(
    'recovers failed cloud transcript acknowledgements idempotently (remote committed: %s)',
    async (remoteCommitted) => {
      const target = await directory.account('A');
      const initial = await practice(target);
      const message = chatMessage(
        initial.sessionId,
        'Save once even when the acknowledgement is lost.',
      );
      const original = saved.get(accountA)!;
      const learning = (await exportLearning(target.store)).tables;
      const { app } = await createApp(config, directory);
      vi.mocked(CloudRepository.prototype.put).mockImplementationOnce(
        async (id, revision, payload, imported) => {
          if (remoteCommitted)
            saved.set(id, { revision: revision + 1, payload, imported_guest_id: imported });
          throw AppError.create('cloud_storage_unavailable');
        },
      );
      await request(app)
        .post('/api/transcript')
        .set('x-earrr-client', '1')
        .set('Authorization', 'Bearer A')
        .send(message)
        .expect(503);
      expect(target.stale).toBe(true);
      expect(target.revision).toBe(original.revision);
      expect((await target.game.snapshot()).transcript).toEqual([]);
      if (!remoteCommitted) expect(saved.get(accountA)).toEqual(original);
      const restored = await directory.account('A');
      expect((await restored.game.snapshot()).transcript).toEqual(remoteCommitted ? [message] : []);
      await request(app)
        .post('/api/transcript')
        .set('x-earrr-client', '1')
        .set('Authorization', 'Bearer A')
        .send(message)
        .expect(200);
      expect((await restored.game.snapshot()).transcript).toEqual([message]);
      expect((await restored.game.snapshot()).totalAnswers).toBe(1);
      expect(saved.get(accountA)!.revision).toBe(original.revision + 1);
      const committed = (await exportLearning(restored.store)).tables;
      expect({ ...committed, transcripts: [] }).toEqual(learning);
      expect(committed.transcripts).toHaveLength(1);
    },
  );

  it('keeps cloud compare-and-swap protection when two directories save the same owner conversation', async () => {
    const primary = await directory.account('A');
    const initial = await practice(primary);
    const second = new WorkspaceDirectory(config);
    try {
      const competing = await second.account('A');
      const firstMessage = chatMessage(initial.sessionId, 'The first committed conversation wins.');
      await primary.store.conversations.saveMessage(firstMessage);
      const staleMessage = chatMessage(
        initial.sessionId,
        'Do not replace the newer cloud history.',
      );
      await expect(competing.store.conversations.saveMessage(staleMessage)).rejects.toMatchObject({
        code: 'cloud_save_conflict',
      });
      expect(competing.stale).toBe(true);
      expect((await competing.game.snapshot()).transcript).toEqual([]);
      const refreshed = await second.account('A');
      expect((await refreshed.game.snapshot()).transcript).toEqual([firstMessage]);
      expect((await refreshed.game.snapshot()).totalAnswers).toBe(1);
      expect((await primary.game.snapshot()).transcript).toEqual([firstMessage]);
      expect(
        directory.codec.open(`account:${accountA}`, saved.get(accountA)!.payload).archive.tables
          .transcripts,
      ).toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  it('keeps guest data when a cloud import fails and rolls back the partial target state', async () => {
    const guest = await directory.createGuest();
    const initial = await practice(guest.workspace);
    const message = chatMessage(initial.sessionId, 'Guest chat must survive a failed import.');
    await guest.workspace.store.conversations.saveMessage(message);
    const sourceSave = guest.workspace.guestSave!;
    vi.mocked(CloudRepository.prototype.put).mockRejectedValueOnce(
      AppError.create('cloud_storage_unavailable'),
    );
    await expect(directory.migrate('A', guest.token, guest.workspace.guestSave!)).rejects.toThrow(
      'Cloud progress',
    );
    expect((await guest.workspace.game.snapshot()).totalAnswers).toBe(1);
    expect((await guest.workspace.game.snapshot()).transcript).toEqual([message]);
    expect((await (await directory.account('A')).game.snapshot()).totalAnswers).toBe(0);
    expect((await (await directory.account('A')).game.snapshot()).transcript).toEqual([]);
    expect((await directory.guest(guest.token)).guestSave!.checkpoint).toBe(sourceSave.checkpoint);
  });

  it('verifies account access and never leaks one workspace through another guest or user', async () => {
    const guest = await directory.createGuest();
    const result = await practice(guest.workspace);
    const message = chatMessage(result.sessionId, 'Only this owner may see this conversation.');
    await guest.workspace.store.conversations.saveMessage(message);
    const { app } = await createApp(config, directory);
    const stranger = await directory.createGuest();
    await request(app)
      .post('/api/transcript')
      .set('x-earrr-client', '1')
      .set('x-earrr-guest', stranger.token)
      .send(message)
      .expect(404);
    expect((await stranger.workspace.game.snapshot()).transcript).toEqual([]);
    await request(app)
      .get(`/api/answers/${result.answer.snapshot.feedback!.attemptId}`)
      .set('x-earrr-guest', stranger.token)
      .expect(404);
    await request(app).get('/api/state').set('Authorization', 'Bearer invalid').expect(401);
    const imported = await directory.migrate('A', guest.token, guest.workspace.guestSave!);
    const other = await request(app).get('/api/state').set('Authorization', 'Bearer B').expect(200);
    expect(other.body.data.totalAnswers).toBe(0);
    expect(other.body.data.session).toBeNull();
    expect(other.body.data.transcript).toEqual([]);
    expect((await imported.game.snapshot()).totalAnswers).toBe(1);
    expect((await imported.game.snapshot()).transcript).toEqual([message]);
    const secondOwner = await directory.account('B');
    const separate = await practice(secondOwner);
    const sameId = {
      ...message,
      sessionId: separate.sessionId,
      text: 'A different owner, same ID.',
    };
    await secondOwner.store.conversations.saveMessage(sameId);
    expect((await secondOwner.game.snapshot()).transcript).toEqual([sameId]);
    expect((await imported.game.snapshot()).transcript).toEqual([message]);
    await expect(
      directory.createGuest({ ...stranger.workspace.guestSave!, checkpoint: 'tampered' }),
    ).rejects.toThrow('saved progress');
  });

  it('publishes a guest checkpoint only after the authoritative mutation commits', async () => {
    const { workspace, token } = await directory.createGuest();
    const { app } = await createApp(config, directory);
    const response = await request(app)
      .post('/api/tools')
      .set('x-earrr-client', '1')
      .set('x-earrr-guest', token)
      .send({ callId: randomUUID(), name: 'start_session', arguments: { mode: 'solo' } })
      .expect(200);
    expect(response.body.data.snapshot.session).not.toBeNull();
    expect(response.body.guestSave.learningStarted).toBe(true);
    expect(
      directory.codec.open('guest', response.body.guestSave.checkpoint).archive.tables.sessions,
    ).toHaveLength(1);
    expect(workspace.revision).toBe(response.body.guestSave.revision);
    const sessionId = response.body.data.snapshot.session.id;
    const learning = await workspace.store.conversations.latest(sessionId);
    const message = chatMessage(sessionId, 'Save this literal conversation.');
    const chat = await request(app)
      .post('/api/transcript')
      .set('x-earrr-client', '1')
      .set('x-earrr-guest', token)
      .send(message)
      .expect(200);
    expect(chat.body.data).toBeNull();
    expect(chat.body.learningStarted).toBe(true);
    expect(chat.body.guestSave.revision).toBe(response.body.guestSave.revision + 1);
    const archive = directory.codec.open('guest', chat.body.guestSave.checkpoint).archive;
    expect(archive.tables.transcripts).toHaveLength(1);
    expect(JSON.parse(String(archive.tables.transcripts![0]!.data))).toEqual(message);
    const retry = await request(app)
      .post('/api/transcript')
      .set('x-earrr-client', '1')
      .set('x-earrr-guest', token)
      .send(message)
      .expect(200);
    expect(retry.body.guestSave).toEqual(chat.body.guestSave);
    expect(await workspace.store.conversations.latest(sessionId)).toEqual(learning);
    expect((await workspace.game.snapshot()).transcript).toEqual([message]);
  });

  it('does not replace existing account progress with an unrelated guest', async () => {
    const target = await directory.account('A');
    await practice(target);
    const guest = await directory.createGuest();
    await practice(guest.workspace);
    await expect(directory.migrate('A', guest.token, guest.workspace.guestSave!)).rejects.toThrow(
      'already has learning progress',
    );
    expect((await target.game.snapshot()).totalAnswers).toBe(1);
    expect((await directory.guest(guest.token)).learningStarted).toBe(true);
  });

  it('serializes competing guest imports without assigning the wrong migration receipt', async () => {
    const first = await directory.createGuest();
    const second = await directory.createGuest();
    await practice(first.workspace);
    await practice(second.workspace);
    const results = await Promise.allSettled([
      directory.migrate('A', first.token, first.workspace.guestSave!),
      directory.migrate('A', second.token, second.workspace.guestSave!),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const receipt = saved.get(accountA)!.imported_guest_id;
    const winner = receipt === first.workspace.id ? first : second;
    const retained = winner === first ? second : first;
    expect((await directory.account('A')).importedGuestId).toBe(winner.workspace.id);
    await expect(directory.guest(winner.token)).rejects.toThrow('guest session');
    expect(await directory.guest(retained.token)).toBe(retained.workspace);
  });

  it('reloads after a cloud commit loses its acknowledgement and never grades the retry twice', async () => {
    const target = await directory.account('A');
    const initial = await practice(target);
    const played = await target.game.execute({
      callId: randomUUID(),
      sessionId: initial.sessionId,
      name: 'play_exercise',
      arguments: {},
    });
    const exercise = (await target.store.exercises.get(played.snapshot.current!.id))!;
    const action = {
      callId: randomUUID(),
      sessionId: initial.sessionId,
      name: 'submit_answer',
      arguments: { exerciseId: exercise.id, answer: exercise.expected },
    };
    vi.mocked(CloudRepository.prototype.put).mockImplementationOnce(
      async (id, revision, payload, imported) => {
        saved.set(id, { revision: revision + 1, payload, imported_guest_id: imported });
        throw AppError.create('cloud_storage_unavailable');
      },
    );
    await expect(target.game.execute(action)).rejects.toThrow('could not be confirmed');
    expect(target.stale).toBe(true);
    expect((await target.game.snapshot()).totalAnswers).toBe(1);
    const [restored, simultaneous] = await Promise.all([
      directory.account('A'),
      directory.account('A'),
    ]);
    expect(restored).toBe(simultaneous);
    expect(restored).not.toBe(target);
    expect((await restored.game.snapshot()).totalAnswers).toBe(2);
    expect((await restored.game.execute(action)).snapshot.totalAnswers).toBe(2);
  });

  it('invalidates a remotely committed workspace if the subsequent local SQL commit fails', async () => {
    const target = await directory.account('A');
    const revision = target.revision;
    await target.store.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE commit_parent(id INTEGER PRIMARY KEY);
      CREATE TABLE commit_child(parent_id INTEGER REFERENCES commit_parent(id)
        DEFERRABLE INITIALLY DEFERRED);
    `);
    await expect(
      target.store.transaction(async () => {
        await target.store.user.saveSettings({
          ...(await target.store.user.getSettings()),
          volume: 0.31,
        });
        await target.store.db.prepare('INSERT INTO commit_child(parent_id) VALUES (?)').run(7);
      }),
    ).rejects.toThrow('FOREIGN KEY');
    expect(target.revision).toBe(revision);
    expect(target.stale).toBe(true);
    expect(saved.get(accountA)!.revision).toBe(revision + 1);
    const restored = await directory.account('A');
    expect((await restored.store.user.getSettings()).volume).toBe(0.31);
  });

  it('rejects altered save metadata and account-bound payloads without deleting the source', async () => {
    const guest = await directory.createGuest();
    await practice(guest.workspace);
    await expect(
      directory.migrate('A', guest.token, {
        ...guest.workspace.guestSave!,
        revision: guest.workspace.revision + 1,
      }),
    ).rejects.toThrow('saved progress');
    await practice(await directory.account('A'));
    saved.set(accountB, saved.get(accountA)!);
    await expect(directory.account('B')).rejects.toThrow('saved progress');
    expect(await directory.guest(guest.token)).toBe(guest.workspace);
  });

  it('retries a committed solo HTTP answer after restart without duplicating its grade or chat', async () => {
    const guest = await directory.createGuest();
    const started = await practice(guest.workspace);
    const played = await guest.workspace.game.execute({
      callId: randomUUID(),
      sessionId: started.sessionId,
      name: 'play_exercise',
      arguments: {},
    });
    const [first, second] = played.audio!.events;
    const body = {
      callId: randomUUID(),
      sessionId: started.sessionId,
      exerciseId: played.snapshot.current!.id,
      text: second!.midi > first!.midi ? 'up' : 'down',
    };
    const { app } = await createApp(config, directory);
    const response = await request(app)
      .post('/api/solo/answer')
      .set('x-earrr-client', '1')
      .set('x-earrr-guest', guest.token)
      .send(body)
      .expect(200);
    expect(response.body.data.snapshot.transcript).toEqual([]);
    expect(response.body.data.snapshot.totalAnswers).toBe(2);
    await directory.close();
    directory = new WorkspaceDirectory(config);
    const restored = await directory.createGuest(response.body.guestSave);
    const next = await createApp(config, directory);
    const retry = await request(next.app)
      .post('/api/solo/answer')
      .set('x-earrr-client', '1')
      .set('x-earrr-guest', restored.token)
      .send(body)
      .expect(200);
    expect(retry.body.data.snapshot.totalAnswers).toBe(2);
    expect(retry.body.data.snapshot.transcript).toEqual([]);
    expect(retry.body.data.snapshot.current.id).toBe(response.body.data.snapshot.current.id);
    expect(retry.body.guestSave.revision).toBe(restored.workspace.revision);
    const archive = directory.codec.open('guest', retry.body.guestSave.checkpoint).archive;
    expect(archive.tables.transcripts).toEqual([]);
    expect(
      archive.tables.session_checkpoints!.every(
        (row) => !('messages' in JSON.parse(String(row.state))),
      ),
    ).toBe(true);
  });

  it('retains canonical browser chat while removing duplicate legacy context and restoring exact learning', async () => {
    const guest = await directory.createGuest();
    const learned = await practice(guest.workspace);
    const archive = await exportLearning(guest.workspace.store);
    const marker = 'CANONICAL SAVED CHAT';
    const duplicate = 'DUPLICATE CHECKPOINT CHAT';
    const message = chatMessage(learned.sessionId, marker);
    archive.tables.transcripts = [
      {
        seq: 1,
        id: message.id,
        session_id: learned.sessionId,
        data: JSON.stringify(message),
      },
    ];
    const last = archive.tables.session_checkpoints!.at(-1)!;
    const state = JSON.parse(String(last.state));
    state.messages = [{ role: 'user', text: duplicate }];
    last.state = JSON.stringify(state);
    const sequence = Number(archive.tables.conversation_events!.at(-1)!.sequence) + 1;
    archive.tables.conversation_events!.push({
      sequence,
      event_id: randomUUID(),
      session_id: learned.sessionId,
      kind: 'message.saved',
      created_at: new Date().toISOString(),
      payload: JSON.stringify({ message: { text: duplicate } }),
    });
    archive.tables.session_checkpoints!.push({
      ...last,
      sequence: Number(last.sequence) + 1,
      event_sequence: sequence,
    });
    const save = {
      ...guest.workspace.guestSave!,
      checkpoint: directory.codec.encode(
        'guest',
        guest.workspace.id,
        guest.workspace.revision,
        archive,
      ),
    };
    const before = await guest.workspace.game.snapshot();
    await directory.close();
    directory = new WorkspaceDirectory(config);
    const restored = (await directory.createGuest(save)).workspace;
    const snapshot = await restored.game.snapshot();
    expect(snapshot.session).toEqual(before.session);
    expect(snapshot.current).toEqual(before.current);
    expect(snapshot.course).toEqual(before.course);
    expect(snapshot.totalAnswers).toBe(before.totalAnswers);
    expect(snapshot.transcript).toEqual([message]);
    expect(
      (await restored.store.conversations.latest(learned.sessionId))?.state,
    ).not.toHaveProperty('messages');
    const cleaned = directory.codec.open('guest', restored.guestSave!.checkpoint).archive;
    expect(cleaned.tables.transcripts).toEqual(archive.tables.transcripts);
    expect(JSON.stringify(cleaned)).toContain(marker);
    expect(JSON.stringify(cleaned)).not.toContain(duplicate);
    for (const table of [
      'settings',
      'course',
      'sessions',
      'exercises',
      'attempts',
      'progress',
      'practice_rounds',
      'lesson_completions',
      'lesson_introductions',
      'lesson_positions',
      'tool_calls',
      'playback_receipts',
    ]) {
      expect(cleaned.tables[table]).toEqual(archive.tables[table]);
    }
    expect(
      cleaned.tables.conversation_events!.some((event) => event.kind === 'message.saved'),
    ).toBe(false);
  });

  it('commits duplicate-context cleanup without losing canonical cloud chat or the guest import receipt', async () => {
    const workspace = await directory.account('A');
    const learned = await practice(workspace);
    const archive = await exportLearning(workspace.store);
    const marker = 'CANONICAL CLOUD HISTORY';
    const duplicate = 'DUPLICATE CLOUD HISTORY';
    const message = chatMessage(learned.sessionId, marker);
    const last = archive.tables.session_checkpoints!.at(-1)!;
    last.state = JSON.stringify({
      ...JSON.parse(String(last.state)),
      messages: [{ text: duplicate }],
    });
    archive.tables.transcripts = [
      {
        seq: 1,
        id: message.id,
        session_id: learned.sessionId,
        data: JSON.stringify(message),
      },
    ];
    const receipt = randomUUID();
    const original = saved.get(accountA)!;
    saved.set(accountA, {
      ...original,
      payload: directory.codec.encode(`account:${accountA}`, accountA, original.revision, archive),
      imported_guest_id: receipt,
    });
    await directory.close();
    directory = new WorkspaceDirectory(config);
    const restored = await directory.account('A');
    const snapshot = await restored.game.snapshot();
    expect(snapshot.totalAnswers).toBe(1);
    expect(snapshot.current?.id).toBe(learned.exercise.id);
    expect(snapshot.transcript).toEqual([message]);
    expect(restored.importedGuestId).toBe(receipt);
    expect(saved.get(accountA)?.imported_guest_id).toBe(receipt);
    expect(saved.get(accountA)!.revision).toBeGreaterThan(original.revision);
    const cleaned = directory.codec.open(
      `account:${accountA}`,
      saved.get(accountA)!.payload,
    ).archive;
    expect(cleaned.tables.transcripts).toEqual(archive.tables.transcripts);
    expect(JSON.stringify(cleaned)).toContain(marker);
    expect(JSON.stringify(cleaned)).not.toContain(duplicate);
  });

  it('restores chat from ended sessions without resuming learning or committing a new cloud revision', async () => {
    const workspace = await directory.account('A');
    const learned = await practice(workspace);
    await workspace.game.execute({
      callId: randomUUID(),
      sessionId: learned.sessionId,
      name: 'end_session',
      arguments: {},
    });
    const archive = await exportLearning(workspace.store);
    const message = chatMessage(learned.sessionId, 'PAST SESSION CHAT');
    archive.tables.transcripts = [
      {
        seq: 1,
        id: message.id,
        session_id: learned.sessionId,
        data: JSON.stringify(message),
      },
    ];
    const original = saved.get(accountA)!;
    saved.set(accountA, {
      ...original,
      payload: directory.codec.encode(`account:${accountA}`, accountA, original.revision, archive),
    });
    await directory.close();
    directory = new WorkspaceDirectory(config);
    const restored = await directory.account('A');
    expect((await restored.game.snapshot()).session).toBeNull();
    expect((await restored.game.snapshot()).totalAnswers).toBe(1);
    expect((await restored.game.snapshot()).transcript).toEqual([message]);
    expect(saved.get(accountA)!.revision).toBe(original.revision);
    expect(
      JSON.stringify(
        directory.codec.open(`account:${accountA}`, saved.get(accountA)!.payload).archive,
      ),
    ).toContain('PAST SESSION CHAT');
  });

  it('rejects an unknown archived event instead of silently deleting learning data', async () => {
    const guest = await directory.createGuest();
    await practice(guest.workspace);
    const source = guest.workspace.guestSave!;
    const archive = await exportLearning(guest.workspace.store);
    archive.tables.conversation_events!.at(-1)!.kind = 'unsupported-learning-event';
    const invalid = {
      ...source,
      checkpoint: directory.codec.encode('guest', source.id, source.revision, archive),
    };
    await directory.close();
    directory = new WorkspaceDirectory(config);
    await expect(directory.createGuest(invalid)).rejects.toThrow('unknown event type');
    const recovered = (await directory.createGuest(source)).workspace;
    expect((await recovered.game.snapshot()).totalAnswers).toBe(1);
  });

  it('retains the authoritative cloud save and canonical chat if duplicate-context cleanup cannot commit', async () => {
    const workspace = await directory.account('A');
    const initial = await practice(workspace);
    const message = chatMessage(initial.sessionId, 'CANONICAL CHAT SURVIVES CLEANUP FAILURE');
    await workspace.store.conversations.saveMessage(message);
    const archive = await exportLearning(workspace.store);
    const checkpoint = archive.tables.session_checkpoints!.at(-1)!;
    checkpoint.state = JSON.stringify({
      ...JSON.parse(String(checkpoint.state)),
      messages: [{ text: 'OLD CLOUD CHAT' }],
    });
    const original = saved.get(accountA)!;
    const legacy = {
      ...original,
      payload: directory.codec.encode(`account:${accountA}`, accountA, original.revision, archive),
    };
    saved.set(accountA, legacy);
    await directory.close();
    directory = new WorkspaceDirectory(config);
    vi.mocked(CloudRepository.prototype.put).mockRejectedValueOnce(
      AppError.create('cloud_storage_unavailable'),
    );
    await expect(directory.account('A')).rejects.toThrow('Cloud progress');
    expect(saved.get(accountA)).toEqual(legacy);
    const restored = await directory.account('A');
    expect((await restored.game.snapshot()).totalAnswers).toBe(1);
    expect((await restored.game.snapshot()).transcript).toEqual([message]);
    expect(
      JSON.stringify(
        directory.codec.open(`account:${accountA}`, saved.get(accountA)!.payload).archive,
      ),
    ).not.toContain('OLD CLOUD CHAT');
  });
});
