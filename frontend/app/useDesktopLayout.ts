import { useSyncExternalStore } from 'react';

const query = '(min-width: 1024px)';
function subscribe(callback: () => void) {
  const media = matchMedia(query);
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
}
export function useDesktopLayout() {
  return useSyncExternalStore(
    subscribe,
    () => matchMedia(query).matches,
    () => true,
  );
}
