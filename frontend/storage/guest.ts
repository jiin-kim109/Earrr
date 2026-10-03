import type { GuestSave } from '../../shared/types/user.js';
import { guestSaveSchema } from '../../shared/schemas/user.js';
import { z } from 'zod';

const pendingActionSchema = z.object({
  id: z.string().min(1).max(160),
  guestId: z.string().uuid(),
  path: z.enum(['/tools', '/agent/tools', '/solo/answer']),
  body: z.string().max(160_000),
  method: z.literal('POST'),
});
export type PendingGuestAction = z.infer<typeof pendingActionSchema>;
const databaseName = 'earrr-learning';
const storeName = 'guest';
let opened: Promise<IDBDatabase> | undefined;
function database() {
  if (!opened) {
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(
          new Error('Enable browser storage to keep guest progress, or log in to an account.'),
        );
        return;
      }
      const request = indexedDB.open(databaseName, 1);
      let failed = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName))
          request.result.createObjectStore(storeName);
      };
      request.onsuccess = () => {
        const db = request.result;
        if (failed) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          opened = undefined;
        };
        resolve(db);
      };
      request.onblocked = () => {
        failed = true;
        reject(new Error('Close other Earrr tabs, then retry opening local progress storage.'));
      };
      request.onerror = () => reject(new Error('Local progress storage could not be opened.'));
    });
    const retryable = opening.catch((error) => {
      if (opened === retryable) opened = undefined;
      throw error;
    });
    opened = retryable;
  }
  return opened;
}
export async function guestSave(): Promise<GuestSave | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).get('save');
    request.onsuccess = () => {
      const result = guestSaveSchema.nullish().safeParse(request.result);
      if (result.success) resolve(result.data ?? null);
      else reject(new Error('Local progress is invalid. It has not been deleted.'));
    };
    request.onerror = () => reject(new Error('Local progress could not be read.'));
  });
}
export async function writeGuest(save: GuestSave) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const records = transaction.objectStore(storeName);
    const current = records.get('save');
    current.onsuccess = () => {
      const stored = guestSaveSchema.optional().safeParse(current.result);
      if (!stored.success) {
        transaction.abort();
        return;
      }
      const before = stored.data;
      if (before && before.id !== save.id) {
        transaction.abort();
        return;
      }
      if (!before || save.revision >= before.revision) records.put(save, 'save');
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(new Error('Local progress could not be saved. Keep this tab open and try again.'));
  });
}
export async function clearGuest() {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).clear();
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(new Error('The transferred guest progress could not be cleared.'));
  });
}
export async function pendingActions(): Promise<PendingGuestAction[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).get('pending');
    request.onsuccess = () => {
      const result = z.array(pendingActionSchema).safeParse(request.result ?? []);
      if (result.success) resolve(result.data);
      else reject(new Error('Pending local progress is invalid. It has not been deleted.'));
    };
    request.onerror = () => reject(new Error('Pending local progress could not be read.'));
  });
}
export async function recordPending(action: PendingGuestAction, remove = false) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const current = store.get('pending');
    current.onsuccess = () => {
      const saved = z.array(pendingActionSchema).safeParse(current.result ?? []);
      if (!saved.success) {
        transaction.abort();
        return;
      }
      const records = saved.data;
      store.put(
        remove
          ? records.filter((record) => record.id !== action.id)
          : [...records.filter((record) => record.id !== action.id), action],
        'pending',
      );
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(new Error('Pending local progress could not be saved.'));
  });
}
