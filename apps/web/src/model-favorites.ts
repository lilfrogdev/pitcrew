import { useEffect, useState } from "react";
import type { ModelChoice } from "@pitcrew/protocol";

const eventName = "pitcrew:model-favorites";
const storageKey = (scope: string) => `pitcrew.model-favorites:v1:${scope}`;
export const favoriteKey = (model: ModelChoice) => JSON.stringify([model.provider, model.model]);
function readFavorites(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 65536) return [];
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter((item): item is string => typeof item === "string" && item.length < 512),
          ),
        ].slice(0, 200)
      : [];
  } catch {
    return [];
  }
}

/** Browser-local preference only. Catalog membership remains the sole source of selectable models. */
export function useModelFavorites(scope = "browser") {
  const key = storageKey(scope);
  const [favorites, setFavorites] = useState(() => readFavorites(key));
  useEffect(() => {
    setFavorites(readFavorites(key));
    const sync = () => setFavorites(readFavorites(key));
    const storage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) sync();
    };
    window.addEventListener(eventName, sync);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(eventName, sync);
      window.removeEventListener("storage", storage);
    };
  }, [key]);
  const toggle = (model: ModelChoice) => {
    const identity = favoriteKey(model);
    const next = favorites.includes(identity)
      ? favorites.filter((item) => item !== identity)
      : [...favorites, identity].slice(-200);
    setFavorites(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      window.dispatchEvent(new Event(eventName));
    } catch {
      // Storage may be unavailable. The picker still works for this session.
    }
  };
  return { favorites, toggle };
}
