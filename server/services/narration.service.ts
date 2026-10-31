import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config/environment.js';
import type { Presentation, ToolName, ToolResult } from '../types/agent.types.js';
import { settingsSchema } from '../../shared/schemas/user.js';
import { narrationText, presentationInstructions } from './agent/presentation.js';

type Narration = NonNullable<Presentation['narration']>;
interface Entry {
  key: string;
  text: string;
  voice: Narration['voice'];
  speed: Narration['speed'];
  seconds: number;
  audio: Buffer;
}
const maxAudioBytes = 48_000 * 45;
const maxMemoryBytes = 16 * 1024 * 1024;
const maxDiskBytes = 64 * 1024 * 1024;
const keyPattern = /^[a-f0-9]{64}$/;
const storedSchema = z.object({
  key: z.string().regex(keyPattern),
  text: z.string().min(1).max(1600),
  voice: settingsSchema.shape.voice,
  speed: settingsSchema.shape.voiceSpeed,
  pcm: z.string().max(Math.ceil((maxAudioBytes * 4) / 3)),
  pcmHash: z.string().regex(keyPattern),
});
const spokenWords = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

export class NarrationService {
  private readonly candidates = new Map<string, { narration: Narration; until: number }>();
  private readonly memory = new Map<string, Entry>();
  private memoryBytes = 0;
  private writes = Promise.resolve();
  private warned = false;

  constructor(private readonly config: Pick<Config, 'narrationCachePath' | 'deployment'>) {}

  private key(text: string, voice: Narration['voice'], speed: Narration['speed']) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          1,
          this.config.deployment,
          voice,
          speed,
          presentationInstructions('narration'),
          text,
        ]),
      )
      .digest('hex');
  }

  async prepare(result: ToolResult, tool?: ToolName): Promise<ToolResult> {
    if (!this.config.narrationCachePath || result.snapshot.session?.mode !== 'coach') return result;
    if (
      tool &&
      ![
        'play_exercise',
        'replay_exercise',
        'select_lesson',
        'adjust_session',
        'show_welcome',
        'teach_lesson',
        'continue_teaching',
        'resume_session',
      ].includes(tool)
    )
      return result;
    const text = narrationText(result);
    if (!text) return result;
    const { voice, voiceSpeed: speed } = result.snapshot.settings;
    const instructions = presentationInstructions('narration')!;
    const key = this.key(text, voice, speed);
    const narration: Narration = { key, text, voice, speed };
    this.candidates.delete(key);
    this.candidates.set(key, { narration, until: Date.now() + 5 * 60_000 });
    if (this.candidates.size > 512) this.candidates.delete(this.candidates.keys().next().value!);
    const cached = await this.get(key);
    if (cached) narration.audio = { url: `/api/narration/${key}`, seconds: cached.seconds };
    return {
      ...result,
      agent: {
        ...result.agent,
        presentation: { ...result.agent.presentation!, instructions, narration },
      },
    };
  }

  private remember(entry: Entry) {
    const existing = this.memory.get(entry.key);
    if (existing) this.memoryBytes -= existing.audio.length;
    this.memory.delete(entry.key);
    this.memory.set(entry.key, entry);
    this.memoryBytes += entry.audio.length;
    while (this.memoryBytes > maxMemoryBytes) {
      const oldest = this.memory.keys().next().value!;
      this.memoryBytes -= this.memory.get(oldest)!.audio.length;
      this.memory.delete(oldest);
    }
    return entry;
  }

  private entry(stored: z.infer<typeof storedSchema>): Entry | null {
    if (createHash('sha256').update(stored.pcm).digest('hex') !== stored.pcmHash) return null;
    const pcm = Buffer.from(stored.pcm, 'base64');
    if (pcm.length < 4800 || pcm.length > maxAudioBytes || pcm.length % 2) return null;
    let audible = false;
    for (let at = 0; at < pcm.length; at += 2) {
      if (Math.abs(pcm.readInt16LE(at)) > 32) {
        audible = true;
        break;
      }
    }
    if (!audible) return null;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(pcm.length + 36, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    const { pcm: _pcm, ...metadata } = stored;
    return { ...metadata, seconds: pcm.length / 48000, audio: Buffer.concat([header, pcm]) };
  }

  async get(key: string): Promise<Entry | null> {
    if (!this.config.narrationCachePath || !keyPattern.test(key)) return null;
    const file = join(this.config.narrationCachePath, `${key}.json`);
    const known = this.memory.get(key);
    if (known) {
      const now = new Date();
      void utimes(file, now, now).catch(() => undefined);
      return this.remember(known);
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.read(key, file),
        new Promise<null>((resolve) => {
          deadline = setTimeout(() => resolve(null), 300);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }

  private async read(key: string, file: string): Promise<Entry | null> {
    try {
      if ((await stat(file)).size > maxAudioBytes * 1.4 + 8192) return null;
      const parsed = storedSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
      if (!parsed.success || parsed.data.key !== key) return null;
      if (this.key(parsed.data.text, parsed.data.voice, parsed.data.speed) !== key) return null;
      const entry = this.entry(parsed.data);
      return entry ? this.remember(entry) : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.unavailable();
      return null;
    }
  }

  private unavailable() {
    if (this.warned) return;
    this.warned = true;
    console.warn('[earrr] Optional narration cache unavailable; using native voice.');
  }

  observer(send: (event: object) => void): (event: unknown) => void {
    let model: string | undefined;
    let speed: number | undefined;
    const started = new Map<string, { key: string; speed: number | undefined }>();
    const pending = new Map<string, { narration: Narration; until: number }>();
    return (raw: unknown) => {
      if (!this.config.narrationCachePath) return;
      try {
        const event = z.record(z.string(), z.any()).parse(raw);
        if (event.type === 'session.updated' || event.type === 'session.created') {
          model = event.session?.model;
          speed = event.session?.audio?.output?.speed;
        } else if (event.type === 'response.created') {
          const key = event.response?.metadata?.earrr_narration;
          if (typeof key === 'string') {
            started.set(event.response.id, { key, speed });
            if (started.size > 4) started.delete(started.keys().next().value!);
          }
        } else if (event.type === 'response.done') {
          const response = event.response;
          const start = started.get(response?.id);
          started.delete(response?.id);
          if (!start || model !== this.config.deployment || response.status !== 'completed') return;
          const candidate = this.candidates.get(start.key);
          const output = response.audio?.output;
          if (
            !candidate ||
            candidate.until < Date.now() ||
            start.speed !== candidate.narration.speed ||
            output?.voice !== candidate.narration.voice ||
            output?.format?.type !== 'audio/pcm' ||
            output.format.rate !== 24000 ||
            this.memory.has(start.key)
          )
            return;
          const item = response.output?.length === 1 ? response.output[0] : null;
          const content = item?.content?.length === 1 ? item.content[0] : null;
          if (
            item?.role !== 'assistant' ||
            !['audio', 'output_audio'].includes(content?.type) ||
            typeof content.transcript !== 'string' ||
            spokenWords(content.transcript) !== spokenWords(candidate.narration.text)
          )
            return;
          pending.set(item.id, candidate);
          if (pending.size > 4) pending.delete(pending.keys().next().value!);
          send({
            type: 'conversation.item.retrieve',
            item_id: item.id,
            event_id: `earrr-cache:${item.id}`,
          });
        } else if (event.type === 'conversation.item.retrieved') {
          const candidate = pending.get(event.item?.id);
          pending.delete(event.item?.id);
          const content = event.item?.content?.length === 1 ? event.item.content[0] : null;
          if (
            !candidate ||
            candidate.until < Date.now() ||
            event.item.role !== 'assistant' ||
            typeof content?.audio !== 'string' ||
            typeof content.transcript !== 'string' ||
            spokenWords(content.transcript) !== spokenWords(candidate.narration.text)
          )
            return;
          const parsed = storedSchema.safeParse({
            ...candidate.narration,
            pcm: content.audio,
            pcmHash: createHash('sha256').update(content.audio).digest('hex'),
          });
          if (!parsed.success) return;
          const entry = this.entry(parsed.data);
          if (!entry || this.memory.has(entry.key)) return;
          this.remember(entry);
          this.writes = this.writes
            .then(async () => {
              const directory = this.config.narrationCachePath!;
              await mkdir(directory, { recursive: true });
              const file = join(directory, `${entry.key}.json`);
              const temporary = `${file}.${randomUUID()}.tmp`;
              try {
                await writeFile(temporary, JSON.stringify(parsed.data), { mode: 0o600 });
                await rename(temporary, file);
              } finally {
                await unlink(temporary).catch(() => undefined);
              }
              const files = await Promise.all(
                (await readdir(directory))
                  .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
                  .map(async (name) => ({
                    file: join(directory, name),
                    ...(await stat(join(directory, name))),
                  })),
              );
              let size = files.reduce((total, file) => total + file.size, 0);
              for (const old of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
                if (size <= maxDiskBytes) break;
                if (old.file === file) continue;
                await unlink(old.file);
                size -= old.size;
              }
            })
            .catch(() => this.unavailable());
        }
      } catch {
        this.unavailable();
      }
    };
  }

  async close() {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.writes,
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, 2500);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }
}
