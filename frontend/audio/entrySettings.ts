import { settingsSchema } from '../../shared/schemas/user.js';

export function readEntrySettings() {
  const data = document.getElementById('earrr-entry-settings')?.textContent;
  if (!data) throw new Error('Entry audio configuration could not be loaded.');
  return settingsSchema
    .pick({ instrument: true, volume: true, voiceVolume: true })
    .parse(JSON.parse(data));
}
