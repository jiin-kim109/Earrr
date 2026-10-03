import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config/environment.js';
import { Store } from '../../db/database.js';
import { SqliteDatabase } from '../../db/sqlite.js';
import { AgentService } from '../agent/agent.service.js';
import { CloudRepository } from '../../repositories/cloud.repository.js';
import { SaveCodec } from './save-codec.js';
import { exportLearning, hasLearning, importLearning } from './archive.js';
import type { LearningArchive } from './archive.js';
import type { GuestSave } from '../../../shared/types/user.js';
import { AppError } from '../../errors/app-error.js';

export class LearningWorkspace {
  game!: AgentService;
  guestSave?: GuestSave;
  learningStarted = false;
  stale = false;
  retired = false;
  importedGuestId: string | null = null;
  pendingGuestImport: string | null = null;
  constructor(
    readonly id: string,
    readonly kind: 'guest' | 'account',
    readonly store: Store,
    public revision: number,
  ) {}
  async close() {
    await this.store.close();
  }
}

export class WorkspaceDirectory {
  readonly cloud: CloudRepository;
  readonly codec: SaveCodec;
  private readonly accounts = new Map<string, Promise<LearningWorkspace>>();
  private readonly guests = new Map<string, Promise<LearningWorkspace>>();
  private readonly capabilities = new Map<string, Promise<LearningWorkspace>>();
  constructor(private readonly config: Config) {
    if (!config.learningSaveKey)
      throw new Error('LEARNING_SAVE_KEY is required for guest and cloud progress.');
    this.codec = new SaveCodec(config.learningSaveKey);
    this.cloud = new CloudRepository(config);
  }
  async createGuest(save?: GuestSave) {
    const decoded = save ? this.codec.open('guest', save.checkpoint) : null;
    if (decoded && (decoded.id !== save!.id || decoded.revision !== save!.revision))
      throw AppError.create('invalid_learning_save');
    const id = decoded?.id ?? randomUUID();
    let creating = this.guests.get(id);
    if (!creating) {
      creating = this.open(id, 'guest', decoded?.revision ?? 0, decoded?.archive);
      this.guests.set(id, creating);
    }
    let workspace: LearningWorkspace;
    try {
      workspace = await creating;
    } catch (error) {
      if (this.guests.get(id) === creating) this.guests.delete(id);
      throw error;
    }
    const token = randomBytes(32).toString('base64url');
    this.capabilities.set(token, Promise.resolve(workspace));
    return { workspace, token };
  }
  async guest(token: string) {
    const workspace = await this.capabilities.get(token);
    if (!workspace || workspace.retired) throw AppError.create('guest_session_missing');
    return workspace;
  }
  async account(token: string) {
    const user = await this.cloud.user(token);
    const id = z.string().uuid().parse(user.id);
    let loading = this.accounts.get(id);
    if (loading && (await loading).stale) {
      if (this.accounts.get(id) === loading) {
        const previous = loading;
        loading = previous.then(async (workspace) => {
          await workspace.close();
          return this.loadAccount(id);
        });
        this.accounts.set(id, loading);
      } else loading = this.accounts.get(id);
    }
    if (!loading) {
      loading = this.loadAccount(id);
      this.accounts.set(id, loading);
    }
    try {
      return await loading;
    } catch (error) {
      if (this.accounts.get(id) === loading) this.accounts.delete(id);
      throw error;
    }
  }
  private async loadAccount(id: string) {
    const saved = await this.cloud.get(id);
    const decoded = saved ? this.codec.open(`account:${id}`, saved.payload) : null;
    if (decoded && (decoded.id !== id || decoded.revision !== saved!.revision))
      throw AppError.create('invalid_learning_save');
    return this.open(
      id,
      'account',
      saved?.revision ?? 0,
      decoded?.archive,
      saved?.imported_guest_id ?? null,
    );
  }
  async migrate(token: string, guestToken: string, save: GuestSave) {
    const decoded = this.codec.open('guest', save.checkpoint);
    if (decoded.id !== save.id || decoded.revision !== save.revision)
      throw AppError.create('invalid_learning_save');
    const target = await this.account(token);
    if (target.importedGuestId === decoded.id) return target;
    const source = await this.guest(guestToken);
    if (source.id !== decoded.id) throw AppError.create('invalid_learning_save');
    await source.store.transaction(async () => {
      const archive = await exportLearning(source.store);
      await target.store.transaction(async () => {
        if (target.importedGuestId === source.id) return;
        if (target.learningStarted || target.importedGuestId)
          throw AppError.create('account_progress_exists');
        target.pendingGuestImport = source.id;
        try {
          await importLearning(target.store, archive);
        } catch (error) {
          target.pendingGuestImport = null;
          throw error;
        }
      });
      source.retired = true;
    });
    this.guests.delete(source.id);
    for (const [key, value] of this.capabilities) {
      if ((await value).id === source.id) this.capabilities.delete(key);
    }
    await source.close();
    return target;
  }
  private async open(
    id: string,
    kind: 'guest' | 'account',
    revision: number,
    archive?: LearningArchive,
    importedGuestId: string | null = null,
  ) {
    const store = await Store.open(':memory:');
    try {
      const removedLegacyContext = archive ? await importLearning(store, archive) : false;
      const workspace = new LearningWorkspace(id, kind, store, revision);
      workspace.importedGuestId = importedGuestId;
      workspace.learningStarted = archive ? hasLearning(archive) : false;
      const db = store.db;
      if (!(db instanceof SqliteDatabase))
        throw new Error('Scoped workspaces require transient SQL execution storage.');
      const checkpoint = async () => {
        if (workspace.retired) throw AppError.create('guest_session_missing');
        let cloudAttempted = false;
        let records: LearningArchive;
        let encoded: string;
        const nextRevision = workspace.revision + 1;
        const importedGuestId = workspace.pendingGuestImport ?? workspace.importedGuestId;
        try {
          records = await exportLearning(store);
          encoded = this.codec.encode(
            kind === 'guest' ? 'guest' : `account:${id}`,
            id,
            nextRevision,
            records,
          );
          if (workspace.stale) throw AppError.create('cloud_save_conflict');
          if (kind === 'account') {
            cloudAttempted = true;
            await this.cloud.put(id, workspace.revision, encoded, importedGuestId);
          }
        } catch (error) {
          workspace.pendingGuestImport = null;
          if (cloudAttempted) workspace.stale = true;
          throw error;
        }
        return {
          committed: () => {
            if (kind === 'guest')
              workspace.guestSave = {
                id,
                revision: nextRevision,
                checkpoint: encoded,
                learningStarted: hasLearning(records),
              };
            workspace.revision = nextRevision;
            workspace.learningStarted = hasLearning(records);
            workspace.importedGuestId = importedGuestId;
            workspace.pendingGuestImport = null;
          },
          rolledBack: () => {
            workspace.pendingGuestImport = null;
            if (cloudAttempted) workspace.stale = true;
          },
        };
      };
      if (kind === 'guest') {
        const records = await exportLearning(store);
        workspace.guestSave = {
          id,
          revision,
          checkpoint: this.codec.encode('guest', id, revision, records),
          learningStarted: hasLearning(records),
        };
      }
      db.onBeforeCommit(checkpoint);
      workspace.game = await AgentService.create(
        store,
        this.config.configured,
        this.config.deployment,
      );
      if (removedLegacyContext && workspace.revision === revision) {
        const session = (await store.sessions.active()) ?? (await store.sessions.recent())[0];
        if (!session)
          throw new Error('The legacy conversation context is missing its learning session.');
        await store.transaction(() =>
          workspace.game.recordEvent({
            id: `archive:restore:${randomUUID()}`,
            sessionId: session.id,
            type: 'session.restored',
            createdAt: new Date().toISOString(),
            payload: { source: 'sanitized-learning-save' },
          }),
        );
      }
      return workspace;
    } catch (error) {
      await store.close();
      throw error;
    }
  }
  async close() {
    const pending = [...this.accounts.values(), ...this.guests.values()];
    this.accounts.clear();
    this.guests.clear();
    this.capabilities.clear();
    await Promise.all(pending.map(async (value) => (await value).close()));
  }
}
