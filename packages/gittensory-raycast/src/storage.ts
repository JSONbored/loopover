import { LocalStorage } from "@raycast/api";
import type { SessionStorageAdapter } from "../lib/storage";

type RaycastStoredValue = string | number | boolean;

function toRaycastValue(value: unknown): RaycastStoredValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

export function createRaycastStorageAdapter(): SessionStorageAdapter {
  return {
    async get(keys: string[]) {
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        out[key] = await LocalStorage.getItem(key);
      }
      return out;
    },
    async set(values: Record<string, unknown>) {
      for (const [key, value] of Object.entries(values)) {
        await LocalStorage.setItem(key, toRaycastValue(value));
      }
    },
    async remove(keys: string[]) {
      for (const key of keys) await LocalStorage.removeItem(key);
    },
  };
}
