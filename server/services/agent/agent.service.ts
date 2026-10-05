import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { nextLesson, ProgressService } from '../progress.service.js';
import type { Store } from '../../db/database.js';
import { AppError } from '../../errors/app-error.js';
import type { ActionEffect } from '../../types/action.types.js';
import type {
  ActionOutcome,
  ToolName,
  ToolRequest,
  ToolResult,
  Snapshot,
} from '../../types/agent.types.js';
import { ExerciseService, exerciseFeedback, publicExercise } from '../exercise/exercise.service.js';
import { GradingService } from '../grading.service.js';
import { SessionService } from '../session.service.js';
import { actionMessage, presentResult, connectionPrompt } from './presentation.js';
import { toolArguments, toolRequestSchema, toolNames } from '../../types/agent.types.js';
import type { ConversationEvent } from '../../types/conversation.types.js';
import type { ExerciseFeedback } from '../../types/grading.types.js';
import type { Session } from '../../types/session.types.js';
import { skills } from '../exercise/catalog.js';
import { restoreCourseRevision } from '../exercise/course-revision.js';

interface BoundTool {
  arguments: object;
  run: () => Promise<ActionEffect>;
}

function tool<Args extends object>(
  schema: z.ZodType<Args>,
  execute: (args: Args, sessionId?: string) => ActionEffect | Promise<ActionEffect>,
): (input: unknown, sessionId?: string) => BoundTool {
  return (input, sessionId) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((item) => `${item.path.join('.')}: ${item.message}`)
        .join('; ');
      throw AppError.create('invalid_tool_arguments', message);
    }
    return { arguments: parsed.data, run: async () => await execute(parsed.data, sessionId) };
  };
}

export class AgentService {
  readonly exercises: ExerciseService;
  readonly sessions: SessionService;
  private readonly progress: ProgressService;
  private readonly handlers: Record<ToolName, (input: unknown, sessionId?: string) => BoundTool>;

  static async create(
    store: Store,
    configured: boolean,
    deployment: string,
    now: () => Date = () => new Date(),
  ) {
    const game = new AgentService(store, configured, deployment, now);
    await game.restoreCheckpoint();
    return game;
  }

  private constructor(
    readonly store: Store,
    private readonly configured: boolean,
    private readonly deployment: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.progress = new ProgressService(store, now);
    this.sessions = new SessionService(store, now);
    this.exercises = new ExerciseService(
      store,
      new GradingService(store, this.progress, now),
      this.progress,
      now,
    );

    this.handlers = {
      start_session: tool(
        toolArguments.start_session,
        async (args) => await this.sessions.start(args),
      ),
      show_welcome: tool(toolArguments.show_welcome, async (_args, id) =>
        this.exercises.presentTeaching(
          await this.sessions.showWelcome(await this.sessions.require(id, true)),
        ),
      ),
      inspect_progress: tool(toolArguments.inspect_progress, () => ({
        ok: true,
        notice: { kind: 'progress' },
      })),
      play_exercise: tool(
        toolArguments.play_exercise,
        async (args, id) => await this.exercises.play(await this.sessions.require(id), args),
      ),
      replay_exercise: tool(
        toolArguments.replay_exercise,
        async (args, id) =>
          await this.exercises.replay(
            await this.sessions.require(id, Boolean(args.exerciseId)),
            args,
          ),
      ),
      submit_answer: tool(
        toolArguments.submit_answer,
        async (args, id) =>
          await this.exercises.answer(
            await this.sessions.require(id),
            args.exerciseId,
            args.answer,
          ),
      ),
      give_hint: tool(
        toolArguments.give_hint,
        async (args, id) =>
          await this.exercises.hint(await this.sessions.require(id), args.exerciseId),
      ),
      skip_exercise: tool(toolArguments.skip_exercise, async (args, id) => {
        const session = await this.sessions.require(id);
        return session.teaching?.section === 'welcome'
          ? this.exercises.startPractice(await this.leaveWelcome(session))
          : this.exercises.skip(session, args.exerciseId);
      }),
      review_answer: tool(
        toolArguments.review_answer,
        async (_args, id) => await this.exercises.review(await this.sessions.require(id, true)),
      ),
      teach_lesson: tool(
        toolArguments.teach_lesson,
        async (args, id) =>
          await this.exercises.startTeaching(
            await this.leaveWelcome(await this.sessions.require(id, true)),
            args,
          ),
      ),
      continue_teaching: tool(toolArguments.continue_teaching, async (args, id) => {
        const session = await this.sessions.require(id);
        return session.teaching?.section === 'welcome'
          ? this.exercises.play(await this.sessions.completeWelcome(session, args.presentationId))
          : this.exercises.continueTeaching(session, args.presentationId);
      }),
      start_practice: tool(toolArguments.start_practice, async (_args, id) =>
        this.exercises.startPractice(await this.leaveWelcome(await this.sessions.require(id))),
      ),
      start_round: tool(
        toolArguments.start_round,
        async (_args, id) => await this.exercises.startRound(await this.sessions.require(id)),
      ),
      pause_session: tool(
        toolArguments.pause_session,
        async (_args, id) => await this.sessions.pause(await this.sessions.require(id, true)),
      ),
      resume_session: tool(
        toolArguments.resume_session,
        async (_args, id) => await this.sessions.resume(await this.sessions.require(id, true)),
      ),
      end_session: tool(
        toolArguments.end_session,
        async (_args, id) => await this.sessions.end(await this.sessions.require(id, true)),
      ),
      select_lesson: tool(
        toolArguments.select_lesson,
        async (args, id) => await this.sessions.select(args.skillId, id),
      ),
      adjust_session: tool(
        toolArguments.adjust_session,
        async (args, id) => await this.sessions.select(args.focus, id),
      ),
    };
  }

  private async leaveWelcome(session: Session): Promise<Session> {
    return session.teaching?.section === 'welcome'
      ? this.sessions.completeWelcome(session, session.teaching.presentationId)
      : session;
  }

  async execute(input: unknown, agent = false): Promise<ToolResult> {
    const request = toolRequestSchema.parse(input);
    const bound = this.handlers[request.name](request.arguments, request.sessionId);
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          name: request.name,
          arguments: bound.arguments,
          sessionId: request.sessionId,
          agent,
        }),
      )
      .digest('hex');

    return await this.store.transaction(async () => {
      const cached = await this.store.agent.getCall(request.callId);
      if (cached) {
        if (cached.hash !== hash) {
          throw AppError.create('call_id_reused');
        }
        const snapshot = await this.snapshot();
        if (
          snapshot.session?.awaitingRoundChoice &&
          cached.payload.playbackExerciseId &&
          !(await this.store.attempts.get(cached.payload.playbackExerciseId))
        ) {
          const {
            audio: _audio,
            playbackExerciseId: _playback,
            nextQuestion: _next,
            ...stopped
          } = cached.payload;
          const previous = snapshot.course.round.previous;
          return presentResult(
            {
              ...stopped,
              ...(previous && cached.payload.gradedExerciseId === snapshot.feedback?.exerciseId
                ? { roundResult: { ...previous, answers: previous.answers ?? [] } }
                : {}),
            },
            snapshot,
          );
        }
        return presentResult(cached.payload, snapshot);
      }

      const effect = await this.prepareNext(await bound.run(), request.name, agent);
      const { notice: _notice, ...result } = effect;
      const outcome: ActionOutcome = {
        ...result,
        reply: result.grade
          ? 'feedback'
          : (result.reply ?? (result.teaching ? 'teaching' : result.audio ? 'none' : 'message')),
        message: actionMessage(effect, {
          hasNextLesson: nextLesson(await this.store.progress.selectedLesson()) !== null,
        }),
      };
      await this.store.agent.saveCall(request.callId, hash, outcome);
      await this.checkpoint(request, bound.arguments, outcome);
      return presentResult(outcome, await this.snapshot());
    });
  }

  private async prepareNext(
    effect: ActionEffect,
    name: ToolName,
    agent: boolean,
  ): Promise<ActionEffect> {
    const session = await this.store.sessions.active();
    if (
      !agent ||
      session?.status !== 'active' ||
      (session.awaitingRoundChoice && session.phase !== 'teaching') ||
      effect.audio ||
      effect.teaching
    ) {
      return effect;
    }
    const graded =
      (name === 'submit_answer' || name === 'skip_exercise') &&
      effect.grade &&
      effect.grade.verdict !== 'incomplete';
    const resumed = ['resume_session', 'select_lesson', 'adjust_session'].includes(name);
    if (!resumed && !graded) {
      return effect;
    }
    const next = await this.exercises.play(session);
    return {
      ...effect,
      ...next,
      grade: effect.grade,
      gradedExerciseId: effect.gradedExerciseId,
      lessonCompleted: effect.lessonCompleted,
      notice: { kind: 'next_prepared' },
    };
  }

  private async checkpoint(request: ToolRequest, args: object, outcome: ActionOutcome) {
    const sessionId = request.sessionId ?? (await this.store.sessions.active())?.id;
    if (!sessionId) return;
    await this.recordEvent({
      id: `tool:${request.callId}`,
      sessionId,
      type: 'tool.completed',
      createdAt: this.now().toISOString(),
      payload: {
        name: request.name,
        arguments: args,
        result: { ...outcome, audio: undefined },
      },
    });
  }

  async restoreCheckpoint() {
    await restoreCourseRevision(this.store);
    await this.sessions.normalizeTutorialPositions();
    await this.store.transaction(async () => {
      for (const skill of skills) {
        const result = await this.progress.closeResolvedRound(skill.id);
        if (!result) continue;
        const session = await this.store.sessions.active();
        if (session?.focus === skill.id) {
          const last = await this.store.attempts.byId(result.answers.at(-1)!.attemptId);
          if (!last) throw new Error('The completed round is missing its last graded answer.');
          await this.store.sessions.save({
            ...session,
            currentExerciseId: last.exerciseId,
            awaitingRoundChoice: true,
          });
        }
      }
    });
    const active = await this.store.sessions.active();
    if (!active) return;
    const previous = await this.store.conversations.latest(active.id);
    const course = await this.progress.course();
    if (
      !previous ||
      JSON.stringify(previous.state.session) !== JSON.stringify(active) ||
      previous.state.course.selectedLesson !== course.selectedLesson ||
      previous.state.course.lessons.map((lesson) => lesson.skillId).join() !==
        course.lessons.map((lesson) => lesson.skillId).join()
    ) {
      await this.store.transaction(
        async () =>
          await this.recordEvent({
            id: `checkpoint:restore:${randomUUID()}`,
            sessionId: active.id,
            type: 'session.restored',
            createdAt: this.now().toISOString(),
            payload: { source: previous ? 'migrated-sqlite-state' : 'existing-sqlite-state' },
          }),
      );
    }
  }

  async latestFeedback(sessionId: string): Promise<ExerciseFeedback | null> {
    const attempt = await this.store.attempts.latest(sessionId);
    if (!attempt) return null;
    const exercise = await this.store.exercises.get(attempt.exerciseId);
    if (!exercise)
      throw new Error('The graded exercise is missing from the saved learning record.');
    return exerciseFeedback(attempt, exercise);
  }

  async recordEvent(event: ConversationEvent) {
    const session = await this.store.sessions.get(event.sessionId);
    if (!session) throw new Error('Cannot checkpoint a missing session.');
    const exercise = session.currentExerciseId
      ? await this.store.exercises.get(session.currentExerciseId)
      : null;
    await this.store.conversations.append(event, {
      session,
      current: exercise ? publicExercise(exercise) : null,
      feedback: await this.latestFeedback(session.id),
      teaching: await this.exercises.teachingView(session),
      course: await this.progress.course(),
    });
  }

  async snapshot(): Promise<Snapshot> {
    return this.store.transaction(() => this.readSnapshot());
  }

  private async readSnapshot(): Promise<Snapshot> {
    const settings = await this.store.user.getSettings();
    const session = await this.store.sessions.active();
    const exercise = session?.currentExerciseId
      ? await this.store.exercises.get(session.currentExerciseId)
      : null;
    const activity = await this.store.attempts.activity();
    const totals = await this.store.attempts.totals();
    const course = await this.progress.course();
    const canAdvance =
      course.lessons.find((lesson) => lesson.skillId === course.selectedLesson)?.status ===
      'completed';

    return {
      checkpoint: session
        ? ((await this.store.conversations.latest(session.id))?.sequence ?? null)
        : null,
      transcript: await this.store.conversations.messages(),
      feedback: session ? await this.latestFeedback(session.id) : null,
      teaching: session ? await this.exercises.teachingView(session) : null,
      course,
      settings,
      session,
      current: exercise ? publicExercise(exercise) : null,
      progress: await this.store.progress.getAll(),
      recentAttempts: await this.store.attempts.recent(),
      recentSessions: await this.store.sessions.recent(),
      activity,
      totalAnswers: totals.answers,
      streak: this.progress.streak(activity, settings.timezone),
      recommendation: {
        skillId: canAdvance && course.nextLesson ? course.nextLesson : course.selectedLesson,
        reason: canAdvance
          ? 'Checkpoint passed. Continue when you choose, or review this lesson.'
          : 'Stay with the selected lesson until its checkpoint is passed.',
      },
      configured: this.configured,
      deployment: this.deployment,
      agent: { toolNames: [...toolNames], connectionPrompt: connectionPrompt() },
    };
  }
}
