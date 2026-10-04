import { skills } from './exercise/catalog.js';
import { randomBytes, randomUUID } from 'node:crypto';
import type { SkillId } from '../../shared/types/course.js';
import type { Store } from '../db/database.js';
import { AppError } from '../errors/app-error.js';
import { roundRule, roundPlan, shuffle } from './exercise/rounds.js';
import type {
  CourseState,
  DailyActivity,
  LessonProgress,
  SkillProgress,
  PracticeRound,
  RoundResult,
  RoundSummary,
} from '../types/progress.types.js';
import type { Grade, Attempt } from '../types/grading.types.js';
import type { Exercise } from '../types/exercise.types.js';
import { seededRandom } from './exercise/music.js';

export class ProgressService {
  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async nextTarget(skillId: SkillId) {
    let round = await this.store.progress.round(skillId);
    if (!round) {
      round = this.newRound(skillId, 1, null);
      await this.store.progress.saveRound(round);
    }

    if (round.awaitingChoice) throw AppError.create('round_choice_required');
    const target = round.remaining[0];
    if (!target) throw new Error('The current round has no question left to prepare.');
    return { roundId: round.id, targetId: target.id, target: target.target };
  }

  async resetRound(skillId: SkillId, expectedId: string | null) {
    const current = await this.store.progress.round(skillId);
    if ((current?.id ?? null) !== expectedId) throw AppError.create('round_changed');
    await this.store.progress.saveRound(this.newRound(skillId, current?.number ?? 1, null));
  }

  async recordRound(
    attempt: Attempt,
    exercise: Exercise,
  ): Promise<{ lessonCompleted: boolean; roundResult?: RoundResult }> {
    const round = await this.store.progress.round(exercise.skillId);
    if (
      !round ||
      round.id !== exercise.roundId ||
      !round.remaining.some((item) => item.id === exercise.roundTargetId)
    ) {
      throw AppError.create('stale_round');
    }
    if (attempt.skipped) {
      round.remaining = shuffle(round.remaining, seededRandom(randomBytes(4).readUInt32LE()));
      await this.store.progress.saveRound(round);
      return { lessonCompleted: false };
    }
    const outcome = attempt.grade.verdict === 'correct' ? 'correct' : 'incorrect';
    round.answers.push({ attemptId: attempt.id, outcome });
    round.remaining = round.remaining.filter((item) => item.id !== exercise.roundTargetId);
    const misses = round.answers.filter((answer) => answer.outcome === 'incorrect').length;
    const correct = round.answers.length - misses;
    if (
      round.answers.length < roundRule.questions &&
      correct < roundRule.correct &&
      misses <= roundRule.questions - roundRule.correct
    ) {
      await this.store.progress.saveRound(round);
      return { lessonCompleted: false };
    }
    return await this.finishRound(round);
  }

  async closeResolvedRound(skillId: SkillId): Promise<RoundResult | null> {
    const round = await this.store.progress.round(skillId);
    if (
      !round ||
      round.awaitingChoice ||
      (round.answers.filter((answer) => answer.outcome === 'correct').length < roundRule.correct &&
        round.answers.filter((answer) => answer.outcome === 'incorrect').length <=
          roundRule.questions - roundRule.correct)
    )
      return null;
    return (await this.finishRound(round)).roundResult!;
  }

  private async finishRound(
    round: PracticeRound,
  ): Promise<{ lessonCompleted: boolean; roundResult: RoundResult }> {
    if (
      round.answers.length > roundRule.questions ||
      round.remaining.length !== roundRule.questions - round.answers.length
    )
      throw new Error('The round question allocation is inconsistent.');
    const correct = round.answers.filter((answer) => answer.outcome === 'correct').length;
    const result: RoundResult = {
      id: round.id,
      number: round.number,
      skillId: round.skillId,
      correct,
      questions: roundRule.questions,
      answered: round.answers.length,
      requiredCorrect: roundRule.correct,
      passed: correct >= roundRule.correct,
      answers: round.answers,
      completedAt: this.now().toISOString(),
    };
    const lessonCompleted =
      result.passed &&
      (await this.store.progress.completeLesson(round.skillId, result.completedAt));
    await this.store.progress.saveRound(this.newRound(round.skillId, round.number + 1, result));
    return { lessonCompleted, roundResult: result };
  }

  private newRound(skillId: SkillId, number: number, previous: RoundSummary | null): PracticeRound {
    return {
      id: randomUUID(),
      skillId,
      number,
      answers: [],
      previous,
      awaitingChoice: previous !== null,
      remaining: roundPlan(skillId, number, randomBytes(4).readUInt32LE()).map((target) => ({
        id: randomUUID(),
        target,
      })),
    };
  }

  async course(): Promise<CourseState> {
    const selectedLesson = await this.store.progress.selectedLesson();
    const completed = await this.store.progress.completedLessons();
    const progress = await this.store.progress.getAll();
    let previousLessonsComplete = true;

    const lessons: LessonProgress[] = skills.map((skill) => {
      const completedAt = completed.find((item) => item.skillId === skill.id)?.completedAt ?? null;
      const answered = progress.find((item) => item.skillId === skill.id)!.attempts;
      const unlocked = previousLessonsComplete || completedAt !== null;
      previousLessonsComplete &&= completedAt !== null;

      return {
        skillId: skill.id,
        status: completedAt ? 'completed' : answered ? 'in_progress' : 'not_started',
        completedAt,
        answered,
        unlocked,
      };
    });

    const round = await this.store.progress.round(selectedLesson);
    const previous = round?.previous
      ? {
          ...round.previous,
          answers:
            round.previous.answers ?? (await this.store.attempts.roundAnswers(round.previous.id)),
        }
      : null;
    return {
      welcomeSeen: await this.store.progress.introductionSeen('welcome'),
      selectedLesson,
      completedLessons: completed.length,
      lessons,
      nextLesson: nextLesson(selectedLesson),
      round: {
        id: round?.id ?? null,
        number: round?.number ?? 1,
        correct: round?.answers.filter((answer) => answer.outcome === 'correct').length ?? 0,
        answers: round?.answers ?? [],
        previous,
      },
    };
  }

  streak(activity: DailyActivity[], timezone: string): number {
    const days = new Set(activity.map((item) => item.date));
    const current = new Date(`${dateKey(this.now(), timezone)}T12:00:00Z`);
    if (!days.has(current.toISOString().slice(0, 10))) current.setUTCDate(current.getUTCDate() - 1);

    let count = 0;
    while (days.has(current.toISOString().slice(0, 10))) {
      count++;
      current.setUTCDate(current.getUTCDate() - 1);
    }
    return count;
  }
}

type Mastery = 'Unexplored' | 'Exploring' | 'Developing' | 'Secure' | 'Mastered';

export function emptyProgress(skillId: SkillId): SkillProgress {
  return {
    skillId,
    attempts: 0,
    correct: 0,
    scoreTotal: 0,
    recentScores: [],
    unassistedCorrect: 0,
    roots: [],
    registers: [],
    practiceDays: [],
    lastPracticedAt: null,
    dueAt: null,
  };
}

function strength(progress: SkillProgress): number {
  if (!progress.attempts) return 0;
  const total = progress.recentScores.reduce((sum, score) => sum + score, 0);
  return Math.round(((total + 1) / (progress.recentScores.length + 2)) * 100);
}

export function mastery(progress: SkillProgress): Mastery {
  if (!progress.attempts) return 'Unexplored';
  const score = strength(progress);
  const mastered =
    score >= 85 &&
    progress.unassistedCorrect >= 16 &&
    progress.roots.length >=
      (progress.skillId === 'chord-roots'
        ? 5
        : [
              'scale-degrees',
              'major-functions',
              'minor-functions',
              'cadences',
              'progressions',
            ].includes(progress.skillId)
          ? 3
          : 6) &&
    progress.registers.length >= (progress.skillId === 'chord-roots' ? 1 : 2) &&
    progress.practiceDays.length >= 2;
  if (mastered) return 'Mastered';
  if (score >= 75 && progress.unassistedCorrect >= 8 && progress.roots.length >= 3) return 'Secure';
  if (score >= 60 && progress.unassistedCorrect >= 4) return 'Developing';
  return 'Exploring';
}

export function dateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (name: string) => parts.find((item) => item.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function updateProgress(
  progress: SkillProgress,
  exercise: Exercise,
  grade: Grade,
  now: Date,
  timezone: string,
  skipped: boolean,
): SkillProgress {
  if (skipped) return { ...progress, dueAt: new Date(now.getTime() + 900_000).toISOString() };
  const unassisted = grade.verdict === 'correct' && exercise.hintCount === 0 && !skipped;
  const evidence = grade.score * (exercise.hintCount > 0 ? 0.6 : 1);
  const result: SkillProgress = {
    ...progress,
    attempts: progress.attempts + 1,
    correct: progress.correct + Number(grade.verdict === 'correct' && !skipped),
    scoreTotal: progress.scoreTotal + evidence,
    recentScores: [...progress.recentScores, evidence].slice(-24),
    unassistedCorrect: progress.unassistedCorrect + Number(unassisted),
    roots: unassisted ? [...new Set([...progress.roots, exercise.root])] : progress.roots,
    registers: unassisted
      ? [...new Set([...progress.registers, exercise.register])]
      : progress.registers,
    practiceDays: unassisted
      ? [...new Set([...progress.practiceDays, dateKey(now, timezone)])].slice(-60)
      : progress.practiceDays,
    lastPracticedAt: now.toISOString(),
    dueAt: null,
  };
  const level = mastery(result);
  const hours =
    skipped || grade.score < 0.5
      ? 0.25
      : grade.score < 1
        ? 4
        : exercise.hintCount > 0
          ? 12
          : level === 'Mastered'
            ? 336
            : level === 'Secure'
              ? 96
              : level === 'Developing'
                ? 24
                : 8;
  result.dueAt = new Date(now.getTime() + hours * 3_600_000).toISOString();
  return result;
}

export function nextLesson(id: SkillId): SkillId | null {
  return skills[skills.findIndex((skill) => skill.id === id) + 1]?.id ?? null;
}

export function checkpointDescription() {
  return `${roundRule.correct}/${roundRule.questions} correct answers in one round. Types are allocated in advance and shuffled. Every ten scored answers produces a result and a fresh round. Hint use is tracked separately for long-term mastery.`;
}
