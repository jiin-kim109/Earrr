import type { Page } from '@playwright/test';
import type { Transcript } from '../frontend/coach/types.js';

export function readCurrentMessages(
  page: Page,
): Promise<Pick<Transcript, 'id' | 'role' | 'text'>[]> {
  return page.locator('[data-message-id]').evaluateAll((elements) =>
    elements.map((element) => {
      const id = element.getAttribute('data-message-id');
      const role = element.getAttribute('data-message-role');
      const text = element.querySelector('p')?.textContent;
      if (
        !id ||
        (role !== 'user' && role !== 'assistant' && role !== 'system') ||
        typeof text !== 'string'
      )
        throw new Error('A visible conversation message has an invalid shape.');
      return { id, role, text };
    }),
  );
}
