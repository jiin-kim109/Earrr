import { randomBytes, randomUUID } from 'node:crypto';
import type {
  MusicalAnswer,
  SkillId,
  Curriculum,
  Instrument,
} from '../../../shared/types/course.js';
import type { Store } from '../../db/database.js';
import { AppError } from '../../errors/app-error.js';
import { createExercise, exerciseFingerprint, arpeggiate } from './generator.js';
import { gradeAnswer, skippedGrade, GradingService } from '../grading.service.js';
import type { ActionEffect, ReplyPurpose } from '../../types/action.types.js';
import type {
  Exercise,
  PlayedExample,
  PublicExercise,
  TeachingProgress,
  TeachingView,
} from '../../types/exercise.types.js';
import type { Session } from '../../types/session.types.js';
import type { Attempt, AnswerReview } from '../../types/grading.types.js';
import { intervalNoteNames, noteName } from './music.js';
import { chapters, skills, welcome } from './catalog.js';
import { checkpointDescription } from '../progress.service.js';
import { roundRule } from './rounds.js';
import type { ProgressService } from '../progress.service.js';
import { lessonExamples, lessonNotes, teachingSteps } from './lessons.js';
import { normalizeTaskAnswer, questionDisplay } from './tasks.js';
import { exerciseDiagram, teachingDiagram } from './diagrams.js';

export function newTeachingProgress(
  lessonId: SkillId,
  index = 0,
  lastDemoIndex: number | null = null,
  autoContinue = true,
): TeachingProgress {
  const steps = teachingSteps(lessonId, 'piano');
  if (!steps[index]) throw new Error('The requested tutorial position does not exist.');
  return {
    lessonId,
    index,
    stepId: steps[index]!.id,
    presentationId: randomUUID(),
    delivered: false,
    lastDemoIndex,
    lastDemoStepId: lastDemoIndex === null ? null : (steps[lastDemoIndex]?.id ?? null),
    autoContinue,
  };
}

interface PlaybackOptions {
  notice: ActionEffect['notice'];
  reply?: ReplyPurpose;
  arpeggiate?: boolean;
}

export class ExerciseService {
  constructor(
    private readonly store: Store,
    private readonly grading: GradingService,
    private readonly progress: ProgressService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  curriculum(): Curriculum {
    return {
      welcome,
      chapters,
      lessons: skills.map((skill) => ({
        ...skill,
        notes: lessonNotes[skill.id],
        checkpoint: roundRule,
        checkpointDescription: checkpointDescription(),
      })),
    };
  }

  examples(skillId: SkillId, instrument: Instrument) {
    return lessonExamples(skillId, instrument);
  }

  async play(session: Session, options: { skillId?: SkillId } = {}): Promise<ActionEffect> {
    if (session.phase === 'teaching') return await this.presentTeaching(session);
    const skillId = await this.store.progress.selectedLesson();
    if (options.skillId && options.skillId !== skillId) {
      throw AppError.create('lesson_change_required');
    }
    const round = await this.store.progress.round(skillId);
    if (session.awaitingRoundChoice || round?.awaitingChoice) {
      return {
        ok: true,
        notice: {
          kind: 'round_choice',
          passed: Boolean(round?.previous?.passed),
        },
      };
    }
    if (session.currentExerciseId) {
      const current = await this.current(session);
      if (current.status === 'unanswered') {
        if (
          round &&
          current.roundId === round.id &&
          round.remaining.some((target) => target.id === current.roundTargetId)
        )
          return await this.present(current, { notice: { kind: 'unanswered_question' } });
        session = { ...session, currentExerciseId: null, previousExerciseId: null };
      }
    }

    const exercise = await this.freshExercise(skillId);
    await this.store.exercises.save(exercise, session.id);
    const updated = {
      ...session,
      previousExerciseId: session.currentExerciseId,
      currentExerciseId: exercise.id,
    };
    await this.store.sessions.save(updated);
    return {
      ...(await this.present(exercise, {
        notice: { kind: 'fresh_example' },
        reply: session.currentExerciseId ? 'cue' : 'instruction',
      })),
      nextQuestion: Boolean(session.currentExerciseId),
    };
  }

  async replay(
    session: Session,
    options: { target?: 'current' | 'previous'; arpeggiate?: boolean; exerciseId?: string },
  ): Promise<ActionEffect> {
    if (!options.exerciseId && session.phase === 'teaching' && session.teaching) {
      return await this.replayTeaching(session, options.target === 'previous');
    }
    const previous = options.target === 'previous';
    const id =
      options.exerciseId ?? (previous ? session.previousExerciseId : session.currentExerciseId);
    if (!id) throw AppError.create('nothing_to_replay');
    const exercise = await this.store.exercises.get(id);
    if (!exercise) throw new Error('The requested replay is missing from the local database.');
    const attempt = options.exerciseId ? await this.store.attempts.get(id) : null;
    if (options.exerciseId && !attempt) throw AppError.create('answer_not_found');

    exercise.replayCount++;
    if (options.arpeggiate && exercise.kind === 'chord' && exercise.status === 'unanswered') {
      exercise.hintCount = Math.max(1, exercise.hintCount);
    }
    await this.store.exercises.save(exercise, session.id);
    return {
      ...(await this.present(exercise, {
        notice: { kind: 'replayed', previous, arpeggiated: Boolean(options.arpeggiate) },
        arpeggiate: options.arpeggiate,
      })),
      ...(attempt ? { review: exerciseFeedback(attempt, exercise) } : {}),
    };
  }

  async reviewAnswer(attemptId: string): Promise<AnswerReview> {
    const attempt = await this.store.attempts.byId(attemptId);
    if (!attempt) throw AppError.create('answer_not_found');
    const exercise = await this.store.exercises.get(attempt.exerciseId);
    if (!exercise) throw new Error('The saved answer has no corresponding exercise.');
    return exerciseFeedback(attempt, exercise);
  }

  async startRound(session: Session): Promise<ActionEffect> {
    if (session.phase === 'teaching') throw AppError.create('demonstration_not_scored');
    const round = await this.store.progress.round(await this.store.progress.selectedLesson());
    if (!round?.awaitingChoice) throw AppError.create('round_in_progress');
    await this.store.progress.saveRound({ ...round, awaitingChoice: false });
    const resumed = { ...session, awaitingRoundChoice: false };
    await this.store.sessions.save(resumed);
    return await this.play(resumed);
  }

  async answer(session: Session, exerciseId: string, answer: MusicalAnswer): Promise<ActionEffect> {
    if (session.phase === 'teaching') {
      throw AppError.create('demonstration_not_scored');
    }
    const exercise = await this.current(session, exerciseId);
    const previous = await this.store.attempts.get(exercise.id);
    if (previous) {
      return {
        ok: true,
        notice: { kind: 'already_scored' },
        grade: previous.grade,
        gradedExerciseId: exercise.id,
      };
    }
    const normalized = normalizeTaskAnswer(exercise, answer);
    const grade = gradeAnswer(exercise, normalized);
    const progress =
      grade.verdict === 'incomplete'
        ? { lessonCompleted: false }
        : await this.grading.record(session, exercise, normalized, grade, false);
    return {
      ok: true,
      notice: { kind: 'answer_graded' },
      ...progress,
      grade,
      gradedExerciseId: exercise.id,
    };
  }

  async hint(session: Session, exerciseId: string): Promise<ActionEffect> {
    if (session.phase === 'teaching') return await this.presentTeaching(session);
    const exercise = await this.current(session, exerciseId);
    if (exercise.status !== 'unanswered') {
      return {
        ok: true,
        notice: {
          kind: 'resolved_question',
          label: exercise.label,
          explanation: exercise.explanation,
        },
      };
    }
    const index = Math.min(exercise.hintCount, exercise.hints.length - 1);
    exercise.hintCount++;
    await this.store.exercises.save(exercise, session.id);
    return { ok: true, notice: { kind: 'hint' }, hint: exercise.hints[index]! };
  }

  async skip(session: Session, exerciseId: string): Promise<ActionEffect> {
    if (session.phase === 'teaching') return await this.startPractice(session);
    const exercise = await this.current(session, exerciseId);
    const previous = await this.store.attempts.get(exercise.id);
    if (previous) {
      return {
        ok: true,
        notice: { kind: 'already_resolved' },
        grade: previous.grade,
        gradedExerciseId: exercise.id,
      };
    }
    const grade = skippedGrade(exercise);
    await this.grading.record(session, exercise, null, grade, true);
    return { ok: true, notice: { kind: 'skipped' }, grade, gradedExerciseId: exercise.id };
  }

  async review(session: Session): Promise<ActionEffect> {
    const attempt = await this.store.attempts.latest(session.id);
    return attempt
      ? {
          ok: true,
          notice: { kind: 'saved_answer' },
          grade: attempt.grade,
          gradedExerciseId: attempt.exerciseId,
        }
      : { ok: true, notice: { kind: 'no_saved_answer' } };
  }

  async startPractice(session: Session): Promise<ActionEffect> {
    if (session.phase === 'teaching' && session.teaching) {
      const finished =
        session.teaching.index === (await this.steps(session.teaching.lessonId)).length - 1;
      await this.store.progress.finishIntroduction(
        session.teaching.lessonId,
        finished ? 'finished' : 'skipped',
      );
    }
    const practice: Session = {
      ...session,
      phase: 'practice',
      teaching: null,
      awaitingRoundChoice: Boolean(
        (await this.store.progress.round(await this.store.progress.selectedLesson()))
          ?.awaitingChoice,
      ),
    };
    await this.store.sessions.save(practice);
    return await this.play(practice);
  }

  private async current(session: Session, expectedId?: string): Promise<Exercise> {
    if (!session.currentExerciseId) {
      throw AppError.create('no_exercise');
    }
    if (expectedId && session.currentExerciseId !== expectedId) {
      throw AppError.create('stale_exercise');
    }
    const exercise = await this.store.exercises.get(session.currentExerciseId);
    if (!exercise)
      throw new Error('The current exercise could not be found in the local database.');
    return exercise;
  }

  private async freshExercise(skillId: SkillId): Promise<Exercise> {
    const planned = await this.progress.nextTarget(skillId);
    const pending = await this.store.exercises.pendingForTarget(
      skillId,
      planned.roundId,
      planned.targetId,
    );
    if (pending) return pending;
    const fingerprints = new Set(
      (await this.store.exercises.recent())
        .filter((exercise) => exercise.roundTargetId !== planned.targetId)
        .slice(0, 8)
        .map(exerciseFingerprint),
    );
    const settings = await this.store.user.getSettings();
    for (let attempt = 0; attempt < 32; attempt++) {
      const candidate = createExercise({
        id: randomUUID(),
        seed: randomBytes(4).readUInt32LE(),
        skillId,
        settings,
        now: this.now().toISOString(),
        target: planned.target,
      });
      if (!fingerprints.has(exerciseFingerprint(candidate)))
        return {
          ...candidate,
          roundId: planned.roundId,
          roundTargetId: planned.targetId,
        };
    }
    throw AppError.create('exercise_generation_failed');
  }

  private async present(exercise: Exercise, options: PlaybackOptions): Promise<ActionEffect> {
    const audio = {
      ...exercise.audio,
      instrument: (await this.store.user.getSettings()).instrument,
    };
    return {
      ok: true,
      notice: options.notice,
      reply: options.reply ?? 'none',
      audio: options.arpeggiate && exercise.kind === 'chord' ? arpeggiate(audio) : audio,
      playbackExerciseId: exercise.id,
    };
  }

  async teachingView(session: Session): Promise<TeachingView | null> {
    if (session.phase !== 'teaching' || !session.teaching) return null;
    const progress = session.teaching;
    if (progress.section === 'welcome') {
      return {
        section: 'welcome',
        lessonId: progress.lessonId,
        presentationId: progress.presentationId,
        stepId: 'welcome',
        index: 0,
        total: 1,
        title: 'Welcome',
        narration:
          "Welcome to ear training. I'm your AI coach. We'll progress from basic pitch and intervals to advanced chords and harmony. Shall we start ear training?",
        demoLabel: null,
        example: null,
        delivered: progress.delivered,
        autoContinue: false,
        awaitingPractice: false,
        lastDemoId: null,
        steps: [{ id: 'welcome', title: welcome.name }],
      };
    }
    const steps = await this.steps(progress.lessonId);
    const step = steps[progress.index];
    if (!step) throw new Error('The saved teaching step does not exist in this lesson.');
    const awaitingPractice = progress.index === steps.length - 1;
    const diagram = teachingDiagram(progress.lessonId, step);

    return {
      lessonId: progress.lessonId,
      presentationId: progress.presentationId,
      stepId: step.id,
      index: progress.index,
      total: steps.length,
      title: step.title,
      narration: step.narration,
      demoLabel: step.demoLabel ?? null,
      example: step.audio
        ? {
            ...describePlayedExample({ audio: step.audio }, 'all'),
            ...(diagram ? { diagram } : {}),
          }
        : null,
      delivered: progress.delivered,
      autoContinue: progress.autoContinue && !awaitingPractice,
      awaitingPractice,
      lastDemoId:
        progress.lastDemoIndex === null ? null : (steps[progress.lastDemoIndex]?.id ?? null),
      steps: steps.map(({ id, title }) => ({ id, title })),
      playedSteps: session.playedTutorialSteps ?? [],
    };
  }

  async presentTeaching(session: Session): Promise<ActionEffect> {
    const teaching = await this.teachingView(session);
    if (!teaching) {
      throw AppError.create('teaching_not_active');
    }
    const step =
      teaching.section === 'welcome'
        ? null
        : (await this.steps(teaching.lessonId))[teaching.index]!;
    return {
      ok: true,
      reply: 'teaching',
      notice: { kind: 'teaching' },
      teaching,
      ...(step?.audio ? { audio: step.audio } : {}),
    };
  }

  async startTeaching(
    session: Session,
    options: { restart?: boolean; stepId?: string; discardRoundId?: string | null },
  ): Promise<ActionEffect> {
    if (session.mode !== 'coach') {
      throw AppError.create('coach_required');
    }
    const lessonId = await this.store.progress.selectedLesson();
    const steps = await this.steps(lessonId);
    const index = options.stepId
      ? steps.findIndex((step) => step.id === options.stepId)
      : options.restart
        ? 0
        : (session.teaching?.index ?? 0);
    if (index < 0) {
      throw AppError.create('unknown_teaching_step');
    }
    if (options.discardRoundId !== undefined) {
      await this.progress.resetRound(lessonId, options.discardRoundId);
      session = {
        ...session,
        currentExerciseId: null,
        previousExerciseId: null,
        awaitingRoundChoice: false,
      };
    }

    const updated: Session = {
      ...session,
      status: 'active',
      phase: 'teaching',
      teaching: newTeachingProgress(
        lessonId,
        index,
        options.restart ? null : (session.teaching?.lastDemoIndex ?? null),
        index < steps.length - 1,
      ),
    };
    await this.store.sessions.save(updated);
    return await this.presentTeaching(updated);
  }

  async replayTeaching(session: Session, previous = false): Promise<ActionEffect> {
    const progress = session.teaching;
    if (!progress) {
      throw AppError.create('teaching_not_active');
    }
    if (progress.section === 'welcome') {
      const updated: Session = {
        ...session,
        teaching: { ...progress, presentationId: randomUUID(), delivered: false },
      };
      await this.store.sessions.save(updated);
      return this.presentTeaching(updated);
    }
    const steps = await this.steps(progress.lessonId);
    let index = progress.lastDemoIndex ?? progress.index;
    if (previous) {
      const earlier = steps
        .map((step, position) => ({ step, position }))
        .filter(({ step, position }) => step.audio && position < index)
        .pop();
      if (earlier) index = earlier.position;
    }

    const updated = {
      ...session,
      teaching: newTeachingProgress(progress.lessonId, index, progress.lastDemoIndex, false),
    };
    await this.store.sessions.save(updated);
    const result = await this.presentTeaching(updated);
    return { ...result, reply: result.audio ? 'none' : 'teaching' };
  }

  async continueTeaching(session: Session, presentationId: string): Promise<ActionEffect> {
    const progress = session.teaching;
    if (session.phase !== 'teaching' || !progress || progress.presentationId !== presentationId) {
      throw AppError.create('stale_teaching_step');
    }
    const lastIndex = (await this.steps(progress.lessonId)).length - 1;
    if (!progress.delivered || progress.index === lastIndex)
      return await this.presentTeaching(session);

    const next = {
      ...session,
      teaching: newTeachingProgress(
        progress.lessonId,
        progress.index + 1,
        progress.lastDemoIndex,
        progress.index + 1 < lastIndex,
      ),
    };
    await this.store.sessions.save(next);
    return await this.presentTeaching(next);
  }

  async teachingDelivered(sessionId: string, presentationId: string): Promise<boolean> {
    const session = await this.store.sessions.get(sessionId);
    if (
      !session ||
      session.status !== 'active' ||
      session.phase !== 'teaching' ||
      session.teaching?.presentationId !== presentationId
    ) {
      return false;
    }
    const step =
      session.teaching.section === 'welcome'
        ? null
        : (await this.steps(session.teaching.lessonId))[session.teaching.index];
    if (!step && session.teaching.section !== 'welcome')
      throw new Error('The saved teaching step does not exist in this lesson.');
    await this.store.sessions.save({
      ...session,
      playedTutorialSteps: step
        ? [...new Set([...(session.playedTutorialSteps ?? []), step.id])]
        : session.playedTutorialSteps,
      teaching: {
        ...session.teaching,
        delivered: true,
        lastDemoIndex: step?.audio ? session.teaching.index : session.teaching.lastDemoIndex,
        lastDemoStepId: step?.audio ? step.id : (session.teaching.lastDemoStepId ?? null),
      },
    });
    return true;
  }

  private async steps(lessonId: SkillId) {
    return teachingSteps(lessonId, (await this.store.user.getSettings()).instrument);
  }
}

export function exerciseFeedback(attempt: Attempt, exercise: Exercise): AnswerReview {
  const diagram = exerciseDiagram(exercise);
  return {
    attemptId: attempt.id,
    exerciseId: attempt.exerciseId,
    grade: attempt.grade,
    skipped: attempt.skipped,
    example: { ...describePlayedExample(exercise), ...(diagram ? { diagram } : {}) },
  };
}

export function describePlayedExample(
  exercise: Pick<Exercise, 'audio'> & Partial<Pick<Exercise, 'kind'>>,
  scope: 'exercise' | 'all' = 'exercise',
): PlayedExample {
  const notes = exercise.audio.events
    .filter((note) => scope === 'all' || note.role === 'exercise')
    .sort((a, b) => a.at - b.at);
  const pair = notes.length === 2 ? notes[1]!.midi - notes[0]!.midi : undefined;
  const unique = [...new Set(notes.map((note) => note.midi))];
  const distance =
    pair !== undefined
      ? Math.abs(pair)
      : scope === 'all' && unique.length === 2
        ? Math.abs(unique[1]! - unique[0]!)
        : undefined;
  const presentation =
    notes.length === 1
      ? 'single'
      : new Set(notes.map((note) => note.at)).size === 1
        ? 'together'
        : pair !== undefined
          ? pair > 0
            ? 'ascending'
            : pair < 0
              ? 'descending'
              : 'repeated'
          : 'sequence';
  return {
    midi: notes.map((note) => note.midi),
    notes:
      exercise.kind === 'interval' && notes.length === 2
        ? intervalNoteNames(notes[0]!.midi, notes[1]!.midi)
        : notes.map((note) => noteName(note.midi, true)),
    presentation,
    ...(distance !== undefined ? { semitones: distance } : {}),
  };
}

export function publicExercise(exercise: Exercise): PublicExercise {
  const { id, skillId, kind, prompt, required, status, replayCount, hintCount } = exercise;
  const cue =
    exercise.cue ??
    (kind === 'interval'
      ? `Two notes ${describePlayedExample(exercise).presentation}.`
      : undefined);
  const question = questionDisplay(exercise);
  return {
    id,
    skillId,
    kind,
    prompt,
    ...(cue ? { cue } : {}),
    required,
    status,
    replayCount,
    hintCount,
    ...(question ? { question } : {}),
    ...(status !== 'unanswered'
      ? {
          reveal: {
            label: exercise.label,
            explanation: exercise.explanation,
            notes: exercise.audio.events
              .filter((note) => note.role === 'exercise')
              .map((note) => noteName(note.midi, true)),
          },
        }
      : {}),
  };
}
