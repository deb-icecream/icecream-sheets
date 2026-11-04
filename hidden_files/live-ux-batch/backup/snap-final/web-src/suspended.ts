/**
 * Suspense-based async resource helper.
 *
 * Several service stores (sensitivity labels, named ranges/functions,
 * access table, ETL version history) are encrypted at rest: their factories
 * are async because WebCrypto is. The web app creates them once per key and
 * suspends the first render until they resolve (the Suspense boundary in
 * main.tsx shows a loading fallback), so every downstream call site keeps
 * its synchronous type.
 *
 * Usage (during render, never in an event handler):
 *   const store = suspended('my-store', () => createMyStore(persistence, keys));
 */

type Entry<T> =
  | { status: 'pending'; promise: Promise<T> }
  | { status: 'ready'; value: T }
  | { status: 'error'; error: unknown };

const cache = new Map<string, Entry<unknown>>();

export function suspended<T>(key: string, load: () => Promise<T>): T {
  let entry = cache.get(key) as Entry<T> | undefined;
  if (!entry) {
    const pending: Entry<T> = { status: 'pending', promise: load() };
    cache.set(key, pending);
    entry = pending;
    void pending.promise.then(
      (value) => {
        cache.set(key, { status: 'ready', value });
      },
      (error: unknown) => {
        cache.set(key, { status: 'error', error });
      },
    );
  }
  if (entry.status === 'pending') throw entry.promise;
  if (entry.status === 'error') throw entry.error;
  return entry.value;
}
