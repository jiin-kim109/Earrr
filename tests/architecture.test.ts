import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve('.');
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
function imports(source: string) {
  return [
    ...source.matchAll(/^\s*(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm),
  ].map((match) => ({
    module: match[3]!,
    typeOnly:
      Boolean(match[1]) ||
      match[2]!
        .replace(/[{}]/g, '')
        .split(',')
        .filter((value) => value.trim())
        .every((value) => value.trim().startsWith('type ')),
  }));
}

describe('layered server and contract-only shared code', () => {
  it('keeps shared limited to public types and schemas, without music or transport ownership', () => {
    expect(
      sourceFiles(join(root, 'shared'))
        .map((file) => relative(join(root, 'shared'), file).replaceAll('\\', '/'))
        .sort(),
    ).toEqual([
      'schemas/course.ts',
      'schemas/feedback.ts',
      'schemas/logging.ts',
      'schemas/user.ts',
      'types/course.ts',
      'types/feedback.ts',
      'types/logging.ts',
      'types/user.ts',
    ]);
    for (const file of sourceFiles(join(root, 'shared'))) {
      const source = readFileSync(file, 'utf8');
      expect(imports(source).map((item) => item.module)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/(?:server|frontend)[/\\]|^node:/)]),
      );
      expect(source).not.toMatch(
        /\b(?:function|class|const)\s+(?:nextLesson|checkpointFor|checkpointDescription|gradeAnswer|createExercise|defaultSettings)\b/,
      );
      if (file.includes(`${join('shared', 'types')}`)) {
        expect(
          imports(source).every((item) => item.typeOnly),
          relative(root, file),
        ).toBe(true);
      }
    }
  });

  it('permits only erased server-type imports in frontend code', () => {
    for (const file of sourceFiles(join(root, 'frontend'))) {
      const source = readFileSync(file, 'utf8');
      for (const dependency of imports(source)) {
        if (dependency.module.includes('server/')) {
          expect(dependency.typeOnly, `${relative(root, file)} -> ${dependency.module}`).toBe(true);
          expect(dependency.module).toContain('server/types/');
        }
      }
      expect(source).not.toMatch(/\bimport\s*(?:\(\s*)?['"][^'"]*(?:server[/\\]|node:)/);
      expect(source).not.toMatch(/You are Earrr|RESTORED CONTEXT/);
    }
  });

  it('groups controllers, repositories and type models by role and nests service-private helpers', () => {
    for (const folder of ['controllers', 'repositories', 'types']) {
      const suffix =
        folder === 'controllers'
          ? 'controller'
          : folder === 'repositories'
            ? 'repository'
            : 'types';
      for (const file of readdirSync(join(root, 'server', folder)).filter((name) =>
        name.endsWith('.ts'),
      )) {
        expect(file.endsWith(`.${suffix}.ts`), `${folder}/${file}`).toBe(true);
      }
    }
    expect(existsSync(join(root, 'server', 'services', 'exercise', 'generator.ts'))).toBe(true);
    expect(existsSync(join(root, 'server', 'app.ts'))).toBe(true);
    expect(existsSync(join(root, 'server', 'middleware.ts'))).toBe(true);
    expect(existsSync(join(root, 'server', 'controllers', 'middleware.ts'))).toBe(false);
    const session = readFileSync(join(root, 'server', 'services', 'session.service.ts'), 'utf8');
    expect(session).toContain('async connect(');
    expect(session).toContain('start(options: StartOptions)');
    expect(session).not.toContain('export interface StartOptions');
    const exercise = readFileSync(
      join(root, 'server', 'services', 'exercise', 'exercise.service.ts'),
      'utf8',
    );
    expect(exercise).toContain('startPractice(');
    expect(exercise).toContain('startTeaching(');
    expect(exercise).toContain('teachingDelivered(');
    expect(exercise).not.toContain('referenceInterval');
    const owners = {
      Session: 'session',
      Exercise: 'exercise',
      TeachingProgress: 'exercise',
      Grade: 'grading',
      ConversationEvent: 'conversation',
      SessionCheckpoint: 'conversation',
      Snapshot: 'agent',
      ToolResult: 'agent',
    };
    for (const [name, owner] of Object.entries(owners)) {
      expect(readFileSync(join(root, 'server', 'types', `${owner}.types.ts`), 'utf8')).toContain(
        `export interface ${name}`,
      );
    }
    expect(readFileSync(join(root, 'shared', 'types', 'user.ts'), 'utf8')).toContain(
      'export interface Transcript',
    );
    expect(readFileSync(join(root, 'frontend', 'coach', 'types.ts'), 'utf8')).toContain(
      "export type { Transcript } from '../../shared/types/user.js'",
    );
    expect(
      readFileSync(join(root, 'server', 'types', 'conversation.types.ts'), 'utf8'),
    ).not.toContain('export interface Transcript');
  });

  it('keeps prompt prose in Jinja templates and errors in the global error layer', () => {
    expect(
      readdirSync(join(root, 'prompts'))
        .filter((file) => file.endsWith('.j2'))
        .sort(),
    ).toEqual(['action.j2', 'agent.j2', 'context.j2', 'reply.j2', 'tool.j2']);
    for (const file of sourceFiles(join(root, 'server'))) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/You are Earrr|RESTORED CONTEXT/);
      if (!file.includes(`${join('server', 'errors')}`)) {
        expect(source).not.toMatch(/extends Error\b|new AppError\(/);
      }
    }
    expect(readFileSync(join(root, 'server', 'app.ts'), 'utf8')).toContain(
      'app.use(requestErrors(config))',
    );
    expect(readFileSync(join(root, 'server', 'db', 'database.ts'), 'utf8')).not.toMatch(
      /\b(?:Snapshot|ToolResult|publicExercise)\b/,
    );
  });

  it('keeps the frontend entry, assets, and Tailwind theme inside frontend', () => {
    for (const path of ['src', 'index.html', 'public'])
      expect(existsSync(join(root, path))).toBe(false);
    expect(readFileSync(join(root, 'frontend', 'index.html'), 'utf8')).toContain('src="/main.tsx"');
    expect(existsSync(join(root, 'frontend', 'public', 'audio', 'piano', 'manifest.json'))).toBe(
      true,
    );
    const style = readFileSync(join(root, 'frontend', 'tailwind.css'), 'utf8');
    expect(style).toMatch(/@import ['"]tailwindcss['"];/);
    expect(style).toContain('@theme');
    expect(style).not.toMatch(/(?:^|\n)\s*(?:[.#:]|body\b|html\b|@apply\b)/);
  });
});
