import { useEffect, useRef, useState } from "react";
import { PresenceClient, type PresenceApi, type PresenceState } from "./thread-presence";
const empty: PresenceState = { usernames: [], reconnecting: false };
export function useThreadPresence(
  api: PresenceApi | undefined,
  threadId: string,
  enabled: boolean,
  onAccessLost: () => void,
) {
  const [state, setState] = useState<{ scope: string; value: PresenceState }>({
    scope: "",
    value: empty,
  });
  const client = useRef<PresenceClient | null>(null);
  useEffect(() => {
    if (!api || !threadId || !enabled) return;
    const current = new PresenceClient(
      api,
      threadId,
      crypto.randomUUID(),
      (value) => setState({ scope: threadId, value }),
      Date.now,
      onAccessLost,
    );
    client.current = current;
    setState({ scope: threadId, value: empty });
    if (document.hidden) current.suspend();
    else void current.read();
    const tick = window.setInterval(() => current.tick(), 250);
    const poll = window.setInterval(() => {
      if (navigator.onLine) void current.read();
    }, 2000);
    const stop = () => current.suspend();
    const resume = () => {
      if (!document.hidden && navigator.onLine) current.resume();
    };
    const visibility = () => (document.hidden ? stop() : resume());
    const offline = () => current.offline();
    window.addEventListener("blur", stop);
    window.addEventListener("focus", resume);
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", resume);
    window.addEventListener("offline", offline);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
      window.removeEventListener("blur", stop);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pagehide", stop);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", visibility);
      current.close();
      if (client.current === current) client.current = null;
    };
  }, [api, threadId, enabled, onAccessLost]);
  return {
    ...(enabled && state.scope === threadId ? state.value : empty),
    activity: (hasInput: boolean) => client.current?.activity(hasInput),
    stop: () => client.current?.stop(),
  };
}
