import { randomUUID } from 'node:crypto';
import type { SkillId } from '../../shared/types/course.js';
import type { Store } from '../db/database.js';
import { AppError } from '../errors/app-error.js';
import type { ActionEffect } from '../types/action.types.js';
import type { Session, LessonPosition } from '../types/session.types.js';
import { ProgressService } from './progress.service.js';
import { newTeachingProgress } from './exercise/exercise.service.js';
import { normalizeTeachingProgress } from './exercise/teaching-progress.js';
import { getSkill, skills } from './exercise/catalog.js';
import { z } from 'zod';
import type { Snapshot } from '../types/agent.types.js';
import { agentInstructions, agentTools } from './agent/presentation.js';
import type { Config } from '../config/environment.js';
import { Log } from './log.service.js';

const secretResponse = z.object({ value: z.string().min(8) });

async function providerError(response: Response, config: Config): Promise<never> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = z
    .object({ error: z.object({ message: z.string().optional(), code: z.string().optional() }) })
    .safeParse(body);
  const detail = parsed.success
    ? parsed.data.error.message?.replaceAll(config.apiKey, '[redacted]').slice(0, 500)
    : undefined;
  throw AppError.provider(response.status, detail);
}

interface StartOptions {
  focus?: SkillId | 'adaptive';
  mode?: 'coach' | 'solo';
  teach?: boolean;
  welcome?: boolean;
}

export class SessionService {
  private readonly negotiations = new Map<string, number[]>();
  constructor(
    private readonly store: Store,
    private readonly progress: ProgressService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async require(sessionId: string | undefined, allowPaused = false): Promise<Session> {
    if (!sessionId) {
      throw AppError.create('session_required');
    }
    const session = await this.store.sessions.get(sessionId);
    if (!session || session.status === 'ended') {
      throw AppError.create('session_ended');
    }
    if (session.status === 'paused' && !allowPaused) {
      throw AppError.create('session_paused');
    }
    return session;
  }

  async start(options: StartOptions): Promise<ActionEffect> {
    if (options.teach && options.mode === 'solo') {
      throw AppError.create('invalid_session_options');
    }

    const existing = await this.store.sessions.active();
    if (existing) {
      if (options.mode && options.mode !== existing.mode) {
        throw AppError.create('session_mode_conflict');
      }
      if (options.teach) {
        await this.store.sessions.save({
          ...existing,
          phase: 'teaching',
          teaching: newTeachingProgress(await this.store.progress.selectedLesson()),
        });
      }
      return { ok: true, notice: { kind: 'existing_session', status: existing.status } };
    }

    const focus =
      !options.focus || options.focus === 'adaptive'
        ? await this.store.progress.selectedLesson()
        : options.focus;
    await this.requireUnlocked(focus);
    await this.store.progress.selectLesson(focus);

    const mode = options.mode ?? 'coach';
    const position = await this.restorePosition(focus, mode);
    if (options.teach) {
      position.phase = 'teaching';
      position.teaching = newTeachingProgress(focus);
    }
    const session: Session = {
      id: randomUUID(),
      mode,
      status: 'active',
      focus,
      startedAt: this.now().toISOString(),
      endedAt: null,
      answered: 0,
      correct: 0,
      listened: 0,
      ...position,
      awaitingRoundChoice: Boolean((await this.store.progress.round(focus))?.awaitingChoice),
    };
    await this.store.sessions.save(session);
    if (
      options.welcome &&
      !options.teach &&
      !(await this.store.progress.introductionSeen('welcome'))
    )
      await this.showWelcome(session);
    return { ok: true, notice: { kind: 'session_started' } };
  }

  async showWelcome(session: Session): Promise<Session> {
    if (session.teaching?.section !== 'welcome') await this.rememberPosition(session);
    const lessonId = await this.store.progress.selectedLesson();
    const welcomed: Session = {
      ...session,
      status: 'active',
      phase: 'teaching',
      teaching: { ...newTeachingProgress(lessonId, 0, null, false), section: 'welcome' },
    };
    await this.store.sessions.save(welcomed);
    return welcomed;
  }

  async completeWelcome(session: Session, presentationId: string): Promise<Session> {
    if (
      session.phase !== 'teaching' ||
      session.teaching?.section !== 'welcome' ||
      session.teaching.presentationId !== presentationId
    )
      throw AppError.create('stale_teaching_step');
    await this.store.progress.finishIntroduction('welcome', 'finished');
    await this.rememberPosition(session);
    const lessonId = await this.store.progress.selectedLesson();
    const restored: Session = {
      ...session,
      ...(await this.restorePosition(lessonId, session.mode)),
      awaitingRoundChoice: Boolean((await this.store.progress.round(lessonId))?.awaitingChoice),
    };
    await this.store.sessions.save(restored);
    return restored;
  }

  async select(skillId: SkillId, sessionId?: string): Promise<ActionEffect> {
    await this.requireUnlocked(skillId);
    const session = await this.store.sessions.active();
    if (session && sessionId !== session.id) {
      throw AppError.create('session_changed');
    }

    if (session && (session.focus !== skillId || session.teaching?.section === 'welcome')) {
      await this.rememberPosition(session);
      if (session.teaching?.section === 'welcome')
        await this.store.progress.finishIntroduction('welcome', 'finished');
      const position = await this.restorePosition(skillId, session.mode);
      await this.store.sessions.save({
        ...session,
        status: 'active',
        focus: skillId,
        ...position,
        awaitingRoundChoice: Boolean((await this.store.progress.round(skillId))?.awaitingChoice),
      });
    } else if (session?.status === 'paused')
      await this.store.sessions.save({ ...session, status: 'active' });
    await this.store.progress.selectLesson(skillId);
    return { ok: true, notice: { kind: 'lesson_selected' } };
  }

  async pause(session: Session): Promise<ActionEffect> {
    await this.store.sessions.save({ ...session, status: 'paused' });
    return { ok: true, notice: { kind: 'session_paused' } };
  }

  async resume(session: Session): Promise<ActionEffect> {
    await this.store.sessions.save({ ...session, status: 'active' });
    return { ok: true, notice: { kind: 'session_resumed' } };
  }

  async end(session: Session): Promise<ActionEffect> {
    await this.rememberPosition(session);
    await this.store.sessions.save({
      ...session,
      status: 'ended',
      endedAt: this.now().toISOString(),
    });
    return {
      ok: true,
      endConversation: true,
      notice: {
        kind: 'session_ended',
        answered: session.answered,
        correct: session.correct,
      },
    };
  }

  private async rememberPosition(session: Session) {
    const skillId =
      session.focus === 'adaptive' ? await this.store.progress.selectedLesson() : session.focus;
    if (session.phase === 'teaching' && !session.teaching)
      throw new Error('The active tutorial has no saved position.');
    await this.store.sessions.saveLessonPosition(
      session.teaching?.section === 'welcome' ? 'welcome' : skillId,
      session.mode,
      {
        phase: session.phase ?? 'practice',
        teaching: session.teaching ?? null,
        currentExerciseId: session.currentExerciseId,
        previousExerciseId: session.previousExerciseId,
        playedTutorialSteps: session.playedTutorialSteps ?? [],
      },
    );
  }

  private async restorePosition(skillId: SkillId, mode: Session['mode']): Promise<LessonPosition> {
    const saved = await this.store.sessions.lessonPosition(skillId, mode);
    if (saved) {
      if (saved.phase === 'teaching') {
        const teaching = saved.teaching ? normalizeTeachingProgress(saved.teaching) : null;
        if (!teaching || teaching.lessonId !== skillId)
          throw new Error('The saved tutorial position does not match its lesson.');
        return {
          ...saved,
          playedTutorialSteps: saved.playedTutorialSteps ?? [],
          teaching: {
            ...newTeachingProgress(
              skillId,
              teaching.index,
              teaching.lastDemoIndex,
              teaching.autoContinue,
              teaching.lastDemoExampleIndex,
            ),
            exampleIndex: teaching.exampleIndex ?? 0,
          },
        };
      }
      return { ...saved, playedTutorialSteps: saved.playedTutorialSteps ?? [] };
    }
    const teaching = mode === 'coach' && !(await this.store.progress.introductionSeen(skillId));
    return {
      phase: teaching ? 'teaching' : 'practice',
      teaching: teaching ? newTeachingProgress(skillId) : null,
      currentExerciseId: null,
      previousExerciseId: null,
      playedTutorialSteps: [],
    };
  }

  private async requireUnlocked(skillId: SkillId) {
    const lesson = (await this.progress.course()).lessons.find((item) => item.skillId === skillId);
    if (!lesson?.unlocked) {
      const index = skills.findIndex((skill) => skill.id === skillId);
      const previous = skills[index - 1];
      throw AppError.create(
        'lesson_locked',
        `${getSkill(skillId).shortName} is locked. Pass ${previous ? previous.shortName : 'the previous lesson'} exercises with 8/10 to unlock it.`,
      );
    }
  }

  async normalizeTutorialPositions() {
    await this.store.transaction(async () => {
      let changed = false;
      const active = await this.store.sessions.active();
      if (active?.teaching) {
        const teaching = normalizeTeachingProgress(active.teaching);
        if (JSON.stringify(teaching) !== JSON.stringify(active.teaching)) {
          await this.store.sessions.save({ ...active, teaching });
          changed = true;
        }
      }
      for (const lesson of skills) {
        for (const mode of ['coach', 'solo'] as const) {
          const position = await this.store.sessions.lessonPosition(lesson.id, mode);
          if (!position?.teaching) continue;
          const teaching = normalizeTeachingProgress(position.teaching);
          if (JSON.stringify(teaching) !== JSON.stringify(position.teaching)) {
            await this.store.sessions.saveLessonPosition(lesson.id, mode, {
              ...position,
              teaching,
            });
            changed = true;
          }
        }
        if (changed)
          await this.store.db.exec(
            `DELETE FROM tool_calls WHERE ${this.store.db.jsonText('data', 'teaching')} IS NOT NULL`,
          );
      }
    });
  }

  async connect(
    sessionId: string,
    config: Config,
    snapshot: Snapshot,
    offer: string,
    signal: AbortSignal,
    fetcher: typeof fetch = fetch,
    client = 'local',
  ): Promise<string> {
    const session = await this.store.sessions.get(sessionId);
    if (!session || session.status !== 'active' || session.mode !== 'coach') {
      throw AppError.create('session_not_ready');
    }
    Log.context({ sessionId });
    const now = this.now().getTime();
    const recent = (this.negotiations.get(client) ?? []).filter(
      (time: number) => now - time < 60_000,
    );
    if (recent.length >= 8) throw AppError.create('reconnect_rate_limited');
    this.negotiations.set(client, [...recent, now]);
    if (!config.configured) throw AppError.create('azure_not_configured');
    const tokenResponse = await fetcher(
      `${config.azureEndpoint}/openai/v1/realtime/client_secrets`,
      {
        method: 'POST',
        headers: { 'api-key': config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: {
            type: 'realtime',
            model: config.deployment,
            instructions: agentInstructions(snapshot),
            output_modalities: ['audio'],
            tools: agentTools(),
            tool_choice: 'auto',
            truncation: {
              type: 'retention_ratio',
              retention_ratio: 0.8,
              token_limits: { post_instructions: 12_000 },
            },
            audio: {
              input: {
                turn_detection: {
                  type: 'semantic_vad',
                  eagerness: 'low',
                  create_response: false,
                  interrupt_response: true,
                },
                noise_reduction: { type: 'near_field' },
                ...(config.transcriptionDeployment
                  ? { transcription: { model: config.transcriptionDeployment, language: 'en' } }
                  : {}),
              },
              output: { voice: snapshot.settings.voice },
            },
          },
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      },
    );
    if (!tokenResponse.ok) await providerError(tokenResponse, config);
    const parsed = secretResponse.safeParse(await tokenResponse.json());
    if (!parsed.success) throw AppError.create('azure_session_invalid');
    const response = await fetcher(`${config.azureEndpoint}/openai/v1/realtime/calls`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${parsed.data.value}`, 'Content-Type': 'application/sdp' },
      body: offer,
      signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
    });
    if (!response.ok) await providerError(response, config);
    const answer = await response.text();
    if (!answer.startsWith('v=0')) throw AppError.create('azure_sdp_invalid');
    return answer;
  }
}
