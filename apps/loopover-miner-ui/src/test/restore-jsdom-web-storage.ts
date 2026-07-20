// #7576: Node 25+ ships a native `globalThis.localStorage` accessor that evaluates to `undefined` when no
// `--localstorage-file` is given (nodejs/node#60303). Vitest's jsdom environment only copies jsdom's real
// `Storage` onto the test global when the key is absent, so on Node 25+ (`"localStorage" in globalThis` is
// now truthy) it skips the copy and leaves Node's broken `undefined` in place -- every test touching
// window.localStorage then throws `Cannot read properties of undefined`. jsdom's working Storage is still
// reachable via the raw JSDOM instance vitest exposes as `globalThis.jsdom`, so restore both storages from
// there whenever the environment's own copy is missing. No-op on Node 22 (`.nvmrc`), where jsdom's copy is
// already present (`globalThis.localStorage` is truthy), so this touches nothing on today's CI.

type StorageKey = "localStorage" | "sessionStorage";
const STORAGE_KEYS: readonly StorageKey[] = ["localStorage", "sessionStorage"];

/** Copy jsdom's working Storage onto `target` (defaults to `globalThis`) for any storage the target is missing. */
export function restoreJsdomWebStorage(target: typeof globalThis = globalThis): void {
  const jsdomWindow = (target as { jsdom?: { window?: Window } }).jsdom?.window;
  if (!jsdomWindow) return;
  for (const key of STORAGE_KEYS) {
    // `target[key]` is falsy on Node 25+ (the broken `undefined` accessor); truthy on Node 22 -> skip.
    if ((target as Record<StorageKey, unknown>)[key]) continue;
    const jsdomStorage = jsdomWindow[key];
    if (!jsdomStorage) continue;
    const descriptor = { value: jsdomStorage, configurable: true, writable: true };
    Object.defineProperty(target, key, descriptor);
    Object.defineProperty(jsdomWindow, key, descriptor);
  }
}
