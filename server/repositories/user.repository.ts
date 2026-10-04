import { settingsSchema } from '../../shared/schemas/user.js';
import type { Settings } from '../../shared/types/user.js';
import type { Database } from '../db/database.js';

const savedSettingsSchema = settingsSchema
  .extend({ voiceVolume: settingsSchema.shape.volume.optional() })
  .transform(({ voiceVolume: _voiceVolume, ...settings }) => settings);

export const defaultSettings: Settings = {
  instrument: 'piano',
  volume: 0.8,
  voice: 'sage',
  timezone: 'UTC',
};

export class UserRepository {
  constructor(private readonly database: Database) {}
  async initialize() {
    await this.database
      .prepare('INSERT INTO settings(id, data) VALUES (1, ?) ON CONFLICT(id) DO NOTHING')
      .run(
        JSON.stringify({
          ...defaultSettings,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      );
  }

  async getSettings(): Promise<Settings> {
    return savedSettingsSchema.parse(
      await this.database.one<unknown>('SELECT data FROM settings WHERE id = 1'),
    );
  }

  async saveSettings(settings: Settings) {
    await this.database
      .prepare('UPDATE settings SET data = ? WHERE id = 1')
      .run(JSON.stringify(settingsSchema.parse(settings)));
  }
}
