import { Router } from 'express';
import { z } from 'zod';
import { requestGame, reply, acknowledge } from '../request-context.js';
import { AppError } from '../errors/app-error.js';
import { parseSoloAnswer } from '../services/grading.service.js';
import { instrumentSchema, skillIdSchema } from '../../shared/schemas/course.js';
import { Log, logToolResult } from '../services/log.service.js';

const teachingDeliverySchema = z
  .object({
    sessionId: z.string().uuid(),
    presentationId: z.string().uuid(),
  })
  .strict();

const playbackSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    exerciseId: z.string().uuid(),
  })
  .strict();

const soloAnswerSchema = z
  .object({
    sessionId: z.string().uuid(),
    exerciseId: z.string().uuid(),
    text: z.string().trim().min(1).max(600),
    callId: z.string().uuid(),
  })
  .strict();

export function exerciseRoutes() {
  const router = Router();

  router.get('/curriculum', (_req, res) => {
    reply(res, requestGame(res).exercises.curriculum());
  });

  router.get('/answers/:id', async (req, res) => {
    reply(
      res,
      await requestGame(res).exercises.reviewAnswer(z.string().uuid().parse(req.params.id)),
    );
  });

  router.get('/lessons/:id/examples', async (req, res) => {
    const game = requestGame(res);
    const { store } = game;
    const id = skillIdSchema.parse(req.params.id);
    const instrument = instrumentSchema.parse(
      req.query.instrument ?? (await store.user.getSettings()).instrument,
    );
    reply(res, game.exercises.examples(id, instrument));
  });

  router.post('/playback', async (req, res) => {
    const game = requestGame(res);
    const { store } = game;
    const input = playbackSchema.parse(req.body);
    await store.transaction(async () => {
      const session = await store.sessions.get(input.sessionId);
      if (
        !session ||
        session.status === 'ended' ||
        ((await store.exercises.sessionId(input.exerciseId)) !== session.id &&
          session.currentExerciseId !== input.exerciseId &&
          !(await store.attempts.get(input.exerciseId)))
      )
        throw AppError.create('playback_session_mismatch');
      await store.sessions.recordPlayback(input.id, input.exerciseId, session);
      await game.recordEvent({
        id: `playback:${input.id}`,
        sessionId: session.id,
        type: 'audio.played',
        createdAt: new Date().toISOString(),
        payload: { exerciseId: input.exerciseId },
      });
    });
    Log.context({ sessionId: input.sessionId });
    Log.event(
      'audio.played',
      { questionId: input.exerciseId, receiptId: input.id },
      { sessionId: input.sessionId },
    );
    acknowledge(res);
  });

  router.post('/solo/answer', async (req, res) => {
    const game = requestGame(res);
    const { store } = game;
    const input = soloAnswerSchema.parse(req.body);
    const result = await store.transaction(async () => {
      const session = await store.sessions.get(input.sessionId);
      if (!session || session.mode !== 'solo') throw AppError.create('not_solo');
      const cached = await store.agent.getCall(input.callId);
      const exercise = await store.exercises.get(input.exerciseId);
      if (!exercise || (session.currentExerciseId !== exercise.id && !cached))
        throw AppError.create('stale_exercise');
      const answer = parseSoloAnswer(input.text, exercise);
      if (!answer) throw AppError.create('solo_answer_unclear');
      return game.execute({
        callId: input.callId,
        sessionId: input.sessionId,
        name: 'submit_answer',
        arguments: { exerciseId: exercise.id, answer },
      });
    });
    logToolResult({ ...input, name: 'submit_answer' }, result);
    reply(res, result);
  });
  router.post('/teaching/delivered', async (req, res) => {
    const game = requestGame(res);
    const { store } = game;
    const input = teachingDeliverySchema.parse(req.body);
    const delivered = await store.transaction(async () => {
      const done = await game.exercises.teachingDelivered(input.sessionId, input.presentationId);
      if (done) {
        await game.recordEvent({
          id: `teaching:${input.presentationId}`,
          sessionId: input.sessionId,
          type: 'teaching.delivered',
          createdAt: new Date().toISOString(),
          payload: { presentationId: input.presentationId },
        });
      }
      return done;
    });
    if (!delivered) {
      throw AppError.create('stale_teaching_delivery');
    }
    Log.context({ sessionId: input.sessionId });
    Log.event(
      'teaching.delivered',
      { presentationId: input.presentationId },
      { sessionId: input.sessionId },
    );
    reply(res, await game.snapshot());
  });

  return router;
}
