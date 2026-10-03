import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getSkill, skills } from '../exercise/catalog.js';
import { checkpointDescription } from '../progress.service.js';
import { lessonNotes } from '../exercise/lessons.js';
import { roundRule } from '../exercise/rounds.js';
import type { ActionEffect, ReplyPurpose } from '../../types/action.types.js';
import { toolArguments, toolNames } from '../../types/agent.types.js';
import type {
  ActionOutcome,
  AgentToolContext,
  PresentationPart,
  Snapshot,
  ToolName,
  ToolResult,
} from '../../types/agent.types.js';

import nunjucks from 'nunjucks';

type PromptName = 'agent' | 'reply' | 'tool' | 'action' | 'context';
type ResultData = ActionOutcome & { reply: ReplyPurpose; snapshot: Snapshot };
const replyPurposes = ['feedback', 'instruction', 'cue', 'teaching', 'message'] as const;
const templates = new nunjucks.Environment(
  new nunjucks.FileSystemLoader(fileURLToPath(new URL('../../../prompts/', import.meta.url))),
  { autoescape: false, throwOnUndefined: true, trimBlocks: true, lstripBlocks: true },
);

function render(name: PromptName, values: Record<string, unknown> = {}): string {
  const result = templates.render(`${name}.j2`, values).trim();
  if (!result) throw new Error(`The ${name} prompt did not produce any text.`);
  return result;
}

export function connectionPrompt(): string {
  return render('context', { event: 'connected' });
}

export function actionMessage(effect: ActionEffect, options: { hasNextLesson: boolean }): string {
  if (effect.notice.kind === 'answer_graded' && !effect.grade) {
    throw new Error('An answer result is missing its deterministic grade.');
  }
  return render('action', { notice: effect.notice, effect, ...options });
}

export function presentationInstructions(
  purpose: Exclude<ReplyPurpose, 'none'>,
): string | undefined {
  return purpose === 'feedback' || purpose === 'cue'
    ? render('reply', { purpose, scoped: true })
    : undefined;
}

export function agentInstructions(snapshot: Snapshot): string {
  const context = {
    session: snapshot.session,
    current: snapshot.current,
    feedback: snapshot.feedback,
    teaching: snapshot.teaching,
    course: snapshot.course,
    lessonChoices: lessonChoices(snapshot),
    checkpoint: snapshot.checkpoint,
    lesson: {
      ...getSkill(snapshot.course.selectedLesson),
      ...lessonNotes[snapshot.course.selectedLesson],
      checkpoint: checkpointDescription(),
    },
  };
  return render('agent', {
    contextJson: JSON.stringify(context),
    dialogueJson: JSON.stringify(snapshot.transcript.slice(-16)),
    replies: replyPurposes.map((purpose) => ({
      purpose,
      instruction: render('reply', { purpose, scoped: false }),
    })),
  });
}

function lessonChoices(snapshot: Snapshot): AgentToolContext['lessonChoices'] {
  return skills.map((skill, index) => ({
    id: skill.id,
    name: skill.shortName,
    unlocked:
      snapshot.course.lessons.find((lesson) => lesson.skillId === skill.id)?.unlocked ?? false,
    prerequisite: skills[index - 1]?.shortName ?? null,
    requiredCorrect: roundRule.correct,
    questions: roundRule.questions,
  }));
}

export function publicToolResult(result: ResultData): AgentToolContext {
  const { snapshot, audio, grade } = result;
  let current: AgentToolContext['current'] = null;
  if (snapshot.current) {
    const { prompt, ...question } = snapshot.current;
    current = { ...question, ...(result.reply === 'instruction' ? { prompt } : {}) };
  }
  const roundResult = result.roundResult
    ? {
        id: result.roundResult.id,
        number: result.roundResult.number,
        skillId: result.roundResult.skillId,
        correct: result.roundResult.correct,
        questions: result.roundResult.questions,
        requiredCorrect: result.roundResult.requiredCorrect,
        answered: result.roundResult.answered,
        passed: result.roundResult.passed,
        completedAt: result.roundResult.completedAt,
      }
    : undefined;
  return {
    ok: result.ok,
    reply: result.reply,
    ...(result.reply === 'message' ? { message: result.message } : {}),
    nextQuestion: result.nextQuestion,
    grade: grade
      ? {
          verdict: grade.verdict,
          expectedAnswer: grade.expectedLabel,
          missing: grade.missing,
          details: grade.details,
          played:
            grade.verdict !== 'incomplete' &&
            snapshot.feedback?.exerciseId === result.gradedExerciseId
              ? snapshot.feedback?.example
              : undefined,
        }
      : undefined,
    gradedExerciseId: result.gradedExerciseId,
    hint: result.hint,
    hasAudio: Boolean(audio),
    playbackExerciseId: result.playbackExerciseId,
    endConversation: result.endConversation,
    lessonCompleted: result.lessonCompleted,
    roundResult,
    review: result.review,
    session: snapshot.session,
    current,
    teaching: snapshot.teaching,
    course: snapshot.course,
    lessonChoices: lessonChoices(snapshot),
    totals: { answers: snapshot.totalAnswers },
  };
}

export function presentationContext(result: ResultData): { parts: PresentationPart[] } {
  const parts: PresentationPart[] = [];
  const grade = publicToolResult(result).grade;
  if (grade) parts.push({ kind: 'feedback', ...grade });
  if (result.reply === 'instruction')
    parts.push({ kind: 'instruction', text: result.snapshot.current?.prompt });
  if (result.teaching) {
    parts.push({
      kind: 'teaching',
      title: result.teaching.title,
      explanation: result.teaching.narration,
      demoLabel: result.teaching.demoLabel,
      awaitingPractice: result.teaching.awaitingPractice,
      ...(result.teaching.section ? { section: result.teaching.section } : {}),
    });
  }
  if (result.roundResult) {
    const { passed, correct, questions, requiredCorrect, answered } = result.roundResult;
    parts.push({ kind: 'round_result', passed, correct, questions, requiredCorrect, answered });
  }
  if (result.lessonCompleted)
    parts.push({ kind: 'checkpoint', nextLesson: result.snapshot.course.nextLesson });
  if (result.nextQuestion) parts.push({ kind: 'next_question', cue: result.snapshot.current?.cue });
  else if (result.reply === 'cue' && result.audio)
    parts.push({ kind: 'listening_cue', cue: result.snapshot.current?.cue });
  return { parts };
}

export function presentResult(outcome: ActionOutcome, snapshot: Snapshot): ToolResult {
  const reply =
    outcome.reply ??
    (outcome.grade
      ? 'feedback'
      : outcome.teaching
        ? 'teaching'
        : outcome.audio
          ? 'none'
          : 'message');
  const data = { ...outcome, reply, snapshot };
  const context = publicToolResult(data);
  return {
    ...data,
    agent: {
      context,
      update: render('context', { event: 'updated', contextJson: JSON.stringify(context) }),
      ...(reply !== 'none'
        ? {
            presentation: {
              purpose: reply,
              context: presentationContext(data),
              instructions: presentationInstructions(reply),
            },
          }
        : {}),
    },
  };
}

export function agentTools() {
  return toolNames.map((name) => ({
    type: 'function' as const,
    name,
    description: render('tool', { name }),
    parameters: realtimeParameters(name),
  }));
}

export function realtimeParameters(name: ToolName): Record<string, unknown> {
  function clean(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !['$schema', 'format', 'pattern'].includes(key))
          .map(([key, item]) => [key, clean(item)]),
      );
    }
    return value;
  }
  return z
    .record(z.string(), z.unknown())
    .parse(clean(z.toJSONSchema(toolArguments[name], { target: 'draft-7' })));
}
