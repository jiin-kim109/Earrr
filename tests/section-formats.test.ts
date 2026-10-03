import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { Store } from '../server/db/database.js';
import { defaultSettings } from '../server/repositories/user.repository.js';
import { createExercise } from '../server/services/exercise/generator.js';
import { exerciseFeedback, publicExercise } from '../server/services/exercise/exercise.service.js';
import { exerciseDiagram, teachingDiagram } from '../server/services/exercise/diagrams.js';
import {
  chordFoundation,
  functionLabel,
  normalizeTaskAnswer,
} from '../server/services/exercise/tasks.js';
import { skills } from '../server/services/exercise/catalog.js';
import { chords, parsePitch, pitchClass } from '../server/services/exercise/music.js';
import { roundPlan } from '../server/services/exercise/rounds.js';
import { teachingSteps } from '../server/services/exercise/lessons.js';
import { gradeAnswer, parseSoloAnswer } from '../server/services/grading.service.js';
import { exportLearning, importLearning } from '../server/services/storage/archive.js';
import { AgentService } from '../server/services/agent/agent.service.js';
import type { SkillId } from '../shared/types/course.js';
import type { ExerciseTarget, MusicalDiagram } from '../server/types/exercise.types.js';
import type { Attempt } from '../server/types/grading.types.js';

const now = '2026-10-03T00:00:00.000Z';
const make = (skillId: SkillId, target?: ExerciseTarget, seed = 1) =>
  createExercise({ id: randomUUID(), skillId, seed, target, settings: defaultSettings, now });
const diagramNotes = (diagram: MusicalDiagram) =>
  diagram.kind === 'degree'
    ? [{ midi: diagram.midi, note: diagram.note }]
    : diagram.kind === 'chord'
      ? diagram.tones
      : diagram.kind === 'progression'
        ? diagram.chords.flatMap((chord) =>
            chord.midi.map((midi, index) => ({ midi, note: chord.notes[index]! })),
          )
        : diagram.points;

describe('protected opening chapter', () => {
  it.each([
    ['pitch-direction', '1168380822f1b0966aacf3fabeff1f0c09e123c0b1dd108e6312da1794bbf873'],
    ['intervals-foundation', '75e0ec522631fa21f6a553ebc8dd0804a12da2beb827f74a555dfab076a0503a'],
    ['intervals-harmonic', '34a4deefd579439a6638e98cab4d875d518232e7ec6e949b4efb30ffb6924908'],
    ['intervals-chromatic', '3b6cea3fd6c5fe5b999cb97d97c7ffb9f324ab9392899b6569170ba704b7065e'],
    ['reference-pitch', 'fc243ad099e5e47d981b89728aea09e725d76857fb4325cc6fb864fc77b3b311'],
  ] satisfies Array<[SkillId, string]>)(
    'keeps %s questions, audio, tutorials and round allocations byte-identical',
    (skillId, fingerprint) => {
      const data = {
        exercises: Array.from({ length: 20 }, (_, seed) =>
          createExercise({
            id: 'protected-example',
            seed,
            skillId,
            settings: defaultSettings,
            now,
          }),
        ),
        steps: teachingSteps(skillId, 'piano'),
        round: roundPlan(skillId, 1, 42),
      };
      expect(createHash('sha256').update(JSON.stringify(data)).digest('hex')).toBe(fingerprint);
      for (const exercise of data.exercises) {
        expect(publicExercise(exercise)).not.toHaveProperty('question');
        expect(exerciseDiagram(exercise)).toBeUndefined();
      }
    },
  );

  it('retains piano for core triads, root naming and bass-inversion lessons', () => {
    for (const skillId of [
      'triads',
      'triad-colors',
      'triad-inversions',
      'chord-roots',
      'seventh-inversions',
    ] as const)
      expect(exerciseDiagram(make(skillId))).toBeUndefined();
  });
});

describe('task-led practice', () => {
  it.each(['melodies', 'progressions', 'jazz-progressions'] as const)(
    'balances complete and recall tasks in each %s round',
    (skillId) => {
      for (let round = 1; round < 10; round++) {
        const plan = roundPlan(skillId, round, round);
        expect(plan.filter((target) => target.format === 'complete')).toHaveLength(5);
        expect(plan.filter((target) => target.format === 'identify')).toHaveLength(5);
        expect(plan.filter((target) => target.length === 3)).toHaveLength(4);
        expect(plan.filter((target) => target.length === 4)).toHaveLength(3);
        expect(plan.filter((target) => target.length === 5)).toHaveLength(3);
      }
    },
  );

  it.each(['melodies', 'progressions', 'jazz-progressions'] as const)(
    'masks only the requested %s position and grades a single degree or complete reply',
    (skillId) => {
      for (let seed = 0; seed < 30; seed++) {
        const exercise = make(skillId, { format: 'complete', length: 4 }, seed);
        expect(exercise.task?.kind).toBe('complete');
        if (exercise.task?.kind !== 'complete') throw new Error('Missing task.');
        const sequence =
          exercise.kind === 'melody' ? exercise.expected.melody! : exercise.expected.progression!;
        const gap = exercise.task.gapIndex;
        const visible = publicExercise(exercise);
        expect(visible.required).toEqual(['degree']);
        expect(visible).not.toHaveProperty('expected');
        expect(visible).not.toHaveProperty('reveal');
        expect(visible.question?.kind).toBe('sequence');
        if (visible.question?.kind !== 'sequence') throw new Error('Missing visual clue.');
        expect(visible.question.targetIndex).toBe(gap);
        expect(visible.question.labels[gap]).toBeNull();
        expect(visible.question.labels.filter((item) => item === null)).toHaveLength(1);
        for (const [index, degree] of sequence.entries())
          if (index !== gap)
            expect(visible.question.labels[index]).toBe(
              exercise.kind === 'melody' ? String(degree) : functionLabel(degree),
            );
        expect(JSON.stringify(visible.question)).not.toMatch(/"midi"|"notes"|"diagram"|"expected"/);
        expect(gradeAnswer(exercise, { degree: sequence[gap] }).verdict).toBe('correct');
        expect(
          gradeAnswer(
            exercise,
            exercise.kind === 'melody' ? { melody: sequence } : { progression: sequence },
          ).verdict,
        ).toBe('correct');
        expect(gradeAnswer(exercise, { degree: (sequence[gap]! % 7) + 1 }).verdict).toBe(
          'incorrect',
        );
        expect(gradeAnswer(exercise, {}).verdict).toBe('incomplete');
        const parsed = parseSoloAnswer(String(sequence[gap]), exercise);
        expect(parsed).toEqual({ degree: sequence[gap] });
        expect(exercise.cue).toContain(`missing ${exercise.kind === 'melody' ? 'note' : 'chord'}`);
        expect(exercise.cue).toContain(`${gap + 1}'s scale degree`);
      }
    },
  );

  it('accepts a missing chord as a numeral or a diatonic chord root without grading by model intuition', () => {
    const exercise = make('jazz-progressions', { format: 'complete', root: 0 });
    const display = exerciseDiagram(exercise);
    if (display?.kind !== 'progression' || exercise.task?.kind !== 'complete')
      throw new Error('Invalid test fixture.');
    const chord = display.chords[exercise.task.gapIndex]!;
    const root = chord.notes[0]!.replace(/-?\d+$/, '');
    expect(gradeAnswer(exercise, { root }).verdict).toBe('correct');
    expect(parseSoloAnswer('V7', exercise)).toEqual({ degree: 5 });
    expect(parseSoloAnswer('ii7', exercise)).toEqual({ degree: 2 });
    expect(parseSoloAnswer('C minor', exercise)).toMatchObject({ root: 'C', quality: 'minor' });
    expect(gradeAnswer(exercise, { progression: [1, 2] }).verdict).toBe('incomplete');
    expect(normalizeTaskAnswer(exercise, { degree: 4, root })).toMatchObject({ degree: 4 });
  });

  it.each(['seventh-colors', 'added-tones', 'extensions', 'altered-dominants', 'modes'] as const)(
    'balances comparative and unaided %s questions without changing the scored vocabulary',
    (skillId) => {
      const plan = roundPlan(skillId, 1, 9);
      expect(plan.filter((target) => target.format === 'compare')).toHaveLength(4);
      expect(plan.filter((target) => target.format === 'identify')).toHaveLength(6);
      for (const [index, target] of plan.entries()) {
        const exercise = make(skillId, target, index);
        expect(gradeAnswer(exercise, exercise.expected).verdict).toBe('correct');
        if (target.format !== 'compare') continue;
        const references = exercise.audio.events.filter((note) => note.role === 'reference');
        const targets = exercise.audio.events.filter((note) => note.role === 'exercise');
        expect(references.length).toBeGreaterThan(0);
        expect(Math.max(...references.map((note) => note.at + note.duration))).toBeLessThan(
          Math.min(...targets.map((note) => note.at)),
        );
        expect(exercise.cue).toContain('second');
        expect(publicExercise(exercise).question?.kind).toBe('comparison');
        if (exercise.task?.kind === 'compare-chords') {
          const baseline = chords[chordFoundation(exercise.expected.quality!)];
          expect(references.map((note) => pitchClass(note.midi - exercise.root))).toEqual(
            baseline.intervals.map(pitchClass),
          );
          expect(exercise.required).toEqual(['quality']);
        } else expect(exercise.required).toEqual(['scale']);
      }
    },
  );
});

describe('musically faithful displays', () => {
  it.each(skills.filter((skill) => skill.chapter > 1).map((skill) => skill.id))(
    'builds %s feedback and tutorial graphics from actual target audio',
    (skillId) => {
      for (let seed = 0; seed < 30; seed++) {
        const exercise = make(skillId, roundPlan(skillId, 1, seed)[0], seed);
        const display = exerciseDiagram(exercise);
        if (!display) continue;
        const actual = exercise.audio.events
          .filter((note) => note.role === 'exercise')
          .sort((a, b) => a.at - b.at || a.midi - b.midi)
          .map((note) => note.midi);
        const represented = diagramNotes(display);
        expect(represented.map((note) => note.midi)).toEqual(actual);
        for (const note of represented) expect(parsePitch(note.note)).toBe(pitchClass(note.midi));
      }
      for (const step of teachingSteps(skillId, 'piano')) {
        const display = teachingDiagram(skillId, step);
        if (!display) continue;
        expect(diagramNotes(display).map((note) => note.midi)).toEqual(
          step
            .audio!.events.filter((note) => note.role === 'exercise')
            .sort((a, b) => a.at - b.at || a.midi - b.midi)
            .map((note) => note.midi),
        );
      }
    },
  );

  it('distinguishes altered fifths from upper colors rather than flattening them into one piano shape', () => {
    const flat5 = exerciseDiagram(make('altered-dominants', { root: 0, quality: '7b5' }));
    const sharp11 = exerciseDiagram(make('altered-dominants', { root: 0, quality: '7#11' }));
    expect(flat5?.kind).toBe('chord');
    expect(sharp11?.kind).toBe('chord');
    if (flat5?.kind !== 'chord' || sharp11?.kind !== 'chord')
      throw new Error('Invalid chord fixture.');
    expect(flat5.tones.map((tone) => tone.degree)).toContain('b5');
    expect(flat5.tones.map((tone) => tone.degree)).not.toContain('5');
    expect(sharp11.tones.map((tone) => tone.degree)).toEqual(expect.arrayContaining(['5', '#11']));
    expect(sharp11.tones.find((tone) => tone.degree === '#11')?.color).toBe(true);
  });

  it('keeps an older unanswered sequence intact while adding only safe masks and deriving later review graphics', () => {
    const old = make('progressions', { length: 4 });
    expect(old).not.toHaveProperty('task');
    expect(old.required).toEqual(['progression']);
    const view = publicExercise(old);
    if (view.question?.kind !== 'sequence') throw new Error('Missing sequence mask.');
    expect(view.question.labels).toEqual([null, null, null, null]);
    const attempt: Attempt = {
      id: randomUUID(),
      exerciseId: old.id,
      sessionId: randomUUID(),
      skillId: old.skillId,
      answer: old.expected,
      grade: gradeAnswer(old, old.expected),
      skipped: false,
      assisted: false,
      createdAt: now,
    };
    expect(exerciseFeedback(attempt, old).example.diagram?.kind).toBe('progression');
  });

  it('persists and restores the exact new question format, with idempotent HTTP grading', async () => {
    let store = await Store.open(':memory:');
    try {
      for (const skill of skills) await store.progress.completeLesson(skill.id, now);
      let { app, game } = await createApp(
        {
          port: 3101,
          databasePath: ':memory:',
          azureEndpoint: '',
          apiKey: '',
          deployment: 'test',
          transcriptionDeployment: '',
          configured: false,
        },
        store,
      );
      const started = await game.execute({
        callId: randomUUID(),
        name: 'start_session',
        arguments: { mode: 'solo', focus: 'progressions' },
      });
      const session = started.snapshot.session!;
      await game.execute({
        callId: randomUUID(),
        sessionId: session.id,
        name: 'play_exercise',
        arguments: {},
      });
      const round = (await store.progress.round('progressions'))!;
      const exercise = {
        ...make('progressions', { format: 'complete', length: 4 }),
        roundId: round.id,
        roundTargetId: round.remaining[0]!.id,
      };
      await store.exercises.save(exercise, session.id);
      await store.sessions.save({ ...session, currentExerciseId: exercise.id });
      const archive = await exportLearning(store);
      await store.close();
      store = await Store.open(':memory:');
      await importLearning(store, archive);
      ({ app, game } = await createApp(
        {
          port: 3101,
          databasePath: ':memory:',
          azureEndpoint: '',
          apiKey: '',
          deployment: 'test',
          transcriptionDeployment: '',
          configured: false,
        },
        store,
      ));
      expect((await game.snapshot()).current?.question).toEqual(publicExercise(exercise).question);
      const body = {
        callId: randomUUID(),
        sessionId: session.id,
        exerciseId: exercise.id,
        text: String(exercise.expected.degree),
      };
      const scored = await request(app)
        .post('/api/solo/answer')
        .set('x-earrr-client', '1')
        .send(body)
        .expect(200);
      expect(scored.body.grade.verdict).toBe('correct');
      expect(scored.body.snapshot.feedback.example.diagram.kind).toBe('progression');
      const retry = await request(app)
        .post('/api/solo/answer')
        .set('x-earrr-client', '1')
        .send(body)
        .expect(200);
      expect(retry.body.snapshot.totalAnswers).toBe(1);
      expect(retry.body.snapshot.course.round.answers).toHaveLength(1);
      await expect(
        (await AgentService.create(store, false, 'test')).snapshot(),
      ).resolves.toMatchObject({ totalAnswers: 1 });
    } finally {
      await store.close();
    }
  });
});
