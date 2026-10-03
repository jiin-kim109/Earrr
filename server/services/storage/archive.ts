import { z } from 'zod';
import type { Store } from '../../db/database.js';
import { learningEventTypes, transcriptSchema } from '../../types/conversation.types.js';

const tables = [
  ['settings', ['id', 'data']],
  ['course', ['id', 'skill_id']],
  ['sessions', ['id', 'status', 'started_at', 'data']],
  ['exercises', ['id', 'session_id', 'created_at', 'data']],
  [
    'attempts',
    [
      'id',
      'exercise_id',
      'session_id',
      'skill_id',
      'day',
      'correct',
      'skipped',
      'score',
      'created_at',
      'data',
    ],
  ],
  ['progress', ['skill_id', 'data']],
  ['practice_rounds', ['skill_id', 'data']],
  ['lesson_completions', ['skill_id', 'completed_at']],
  ['lesson_introductions', ['skill_id', 'disposition', 'finished_at']],
  ['lesson_positions', ['skill_id', 'mode', 'data']],
  ['tool_calls', ['id', 'request_hash', 'created_at', 'data']],
  ['playback_receipts', ['id', 'exercise_id']],
  ['transcripts', ['seq', 'id', 'session_id', 'data']],
  ['conversation_events', ['sequence', 'event_id', 'session_id', 'kind', 'created_at', 'payload']],
  ['session_checkpoints', ['sequence', 'session_id', 'event_sequence', 'created_at', 'state']],
] as const;
const value = z.union([z.string(), z.number().finite(), z.null()]);
const row = z.record(z.string(), value);
export const archiveSchema = z
  .object({
    version: z.literal(1),
    tables: z.record(z.string(), z.array(row)),
  })
  .strict();
export type LearningArchive = z.infer<typeof archiveSchema>;
const legacyChatEventTypes = [
  'message.saved',
  'connection.opened',
  'connection.closed',
  'response.completed',
  'response.interrupted',
];
const object = z.record(z.string(), z.unknown());

function validateRecords(records: LearningArchive['tables'][string], columns: readonly string[]) {
  for (const record of records) {
    if (
      Object.keys(record).length !== columns.length ||
      columns.some((column) => !(column in record))
    )
      throw new Error('The learning archive contains an invalid record.');
  }
}

export function sanitizeLearning(input: LearningArchive) {
  const archive = archiveSchema.parse(input);
  if (Object.keys(archive.tables).some((name) => !tables.some(([table]) => table === name)))
    throw new Error('The learning archive contains an unknown table.');
  let removedLegacyContext = false;
  const records: LearningArchive['tables'] = {};
  for (const [name, columns] of tables) {
    records[name] = archive.tables[name] ?? [];
    validateRecords(records[name], columns);
  }
  records.transcripts = records.transcripts!.map((record) => {
    if (typeof record.data !== 'string')
      throw new Error('The learning archive contains an invalid transcript.');
    const message = transcriptSchema.parse(JSON.parse(record.data));
    if (message.id !== record.id || message.sessionId !== record.session_id)
      throw new Error('The learning archive contains an invalid transcript owner.');
    z.coerce.number().int().positive().parse(record.seq);
    const original = object.parse(JSON.parse(record.data));
    return original.createdAt === message.createdAt
      ? record
      : { ...record, data: JSON.stringify(message) };
  });
  const removedEvents = new Set<string>();
  records.conversation_events = records.conversation_events!.filter((event) => {
    if (learningEventTypes.some((kind) => event.kind === kind)) return true;
    if (!legacyChatEventTypes.some((kind) => event.kind === kind))
      throw new Error('The learning archive contains an unknown event type.');
    removedEvents.add(String(event.sequence));
    removedLegacyContext = true;
    return false;
  });
  records.session_checkpoints = records
    .session_checkpoints!.filter(
      (checkpoint) => !removedEvents.has(String(checkpoint.event_sequence)),
    )
    .map((checkpoint) => {
      if (typeof checkpoint.state !== 'string')
        throw new Error('The learning archive contains an invalid checkpoint.');
      const state = object.parse(JSON.parse(checkpoint.state));
      if (!('messages' in state)) return checkpoint;
      delete state.messages;
      removedLegacyContext = true;
      return { ...checkpoint, state: JSON.stringify(state) };
    });
  records.tool_calls = records.tool_calls!.map((call) => {
    if (typeof call.data !== 'string')
      throw new Error('The learning archive contains an invalid tool result.');
    const data = object.parse(JSON.parse(call.data));
    if (!['snapshot', 'messages', 'transcript', 'recentConversation'].some((key) => key in data))
      return call;
    for (const key of ['snapshot', 'messages', 'transcript', 'recentConversation'])
      delete data[key];
    removedLegacyContext = true;
    return { ...call, data: JSON.stringify(data) };
  });
  return { archive: { version: 1 as const, tables: records }, removedLegacyContext };
}

export async function exportLearning(store: Store): Promise<LearningArchive> {
  const records: LearningArchive['tables'] = {};
  for (const [name, columns] of tables) {
    records[name] = z
      .array(row)
      .parse(await store.db.prepare(`SELECT ${columns.join(',')} FROM ${name}`).all());
  }
  return sanitizeLearning({ version: 1, tables: records }).archive;
}

export async function importLearning(store: Store, input: LearningArchive) {
  const { archive, removedLegacyContext } = sanitizeLearning(input);
  await store.transaction(async () => {
    for (const [name] of [...tables].reverse()) await store.db.exec(`DELETE FROM ${name}`);
    for (const [name, columns] of tables) {
      for (const record of archive.tables[name] ?? []) {
        await store.db
          .prepare(
            `INSERT INTO ${name} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          )
          .run(...columns.map((column) => record[column]!));
      }
    }
    if (store.db.kind === 'postgres') {
      for (const [name, column] of [
        ['transcripts', 'seq'],
        ['conversation_events', 'sequence'],
        ['session_checkpoints', 'sequence'],
      ]) {
        await store.db.exec(
          `SELECT setval(pg_get_serial_sequence('${name}', '${column}'),
            COALESCE(MAX(${column}), 1), MAX(${column}) IS NOT NULL) FROM ${name}`,
        );
      }
    }
  });
  return removedLegacyContext;
}

export const hasLearning = (archive: LearningArchive) => Boolean(archive.tables.sessions?.length);
