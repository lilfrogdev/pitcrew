import { useCallback, useEffect, useRef, useState } from "react";

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
export interface LocalRecognition {
  processLocally: boolean;
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult:
    | ((event: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void)
    | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export interface LocalRecognitionConstructor {
  new (): LocalRecognition;
  prototype: LocalRecognition;
  available(options: {
    langs: string[];
    processLocally: true;
    quality: "dictation";
  }): Promise<string>;
  install?(options: {
    langs: string[];
    processLocally: true;
    quality: "dictation";
  }): Promise<boolean>;
}
function recognitionConstructor() {
  const browser = window as Window & {
    SpeechRecognition?: LocalRecognitionConstructor;
    webkitSpeechRecognition?: LocalRecognitionConstructor;
  };
  const constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
  return constructor &&
    "processLocally" in constructor.prototype &&
    typeof constructor.available === "function"
    ? constructor
    : undefined;
}
type Phase = "idle" | "checking" | "listening" | "stopping" | "installing";
export function useDictation(
  draft: string,
  onDraft: (text: string) => void,
  enabled: boolean,
  sessionKey: string,
) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [downloadable, setDownloadable] = useState(false);
  const generation = useRef(0);
  const recognition = useRef<LocalRecognition | undefined>(undefined);
  const context = useRef({ enabled, sessionKey });
  context.current = { enabled, sessionKey };
  const current = useRef({ draft, onDraft });
  current.current = { draft, onDraft };
  const constructor = recognitionConstructor();
  const language = navigator.language || "en-US";
  const options = {
    langs: [language],
    processLocally: true as const,
    quality: "dictation" as const,
  };
  const cancel = useCallback(() => {
    generation.current++;
    const active = recognition.current;
    recognition.current = undefined;
    if (active) {
      active.onstart = active.onend = active.onerror = active.onresult = null;
      try {
        active.abort();
      } catch {
        /* The browser may already have ended capture. */
      }
    }
  }, []);
  useEffect(() => {
    setPhase("idle");
    setError("");
    setDownloadable(false);
    return cancel;
  }, [enabled, sessionKey, cancel]);
  const isCurrent = (token: number) =>
    token === generation.current &&
    context.current.enabled &&
    context.current.sessionKey === sessionKey;
  const toggle = async () => {
    if (!enabled) return;
    if (phase === "listening") {
      setPhase("stopping");
      recognition.current?.stop();
      return;
    }
    if (phase !== "idle") {
      cancel();
      setPhase("idle");
      return;
    }
    if (!constructor) {
      setError("On-device dictation is unavailable in this browser.");
      return;
    }
    const token = ++generation.current;
    setError("");
    setDownloadable(false);
    setPhase("checking");
    try {
      const availability = await constructor.available(options);
      if (!isCurrent(token)) return;
      if (availability !== "available") {
        setDownloadable(availability === "downloadable" && !!constructor.install);
        setError(
          availability === "downloading"
            ? "Dictation language is downloading. Try again when it finishes."
            : availability === "downloadable"
              ? "Download the dictation language to use the microphone."
              : "On-device dictation is unavailable for your browser language.",
        );
        setPhase("idle");
        return;
      }
      const active = new constructor();
      active.processLocally = true;
      if (active.processLocally !== true) throw Error("local_recognition_required");
      active.lang = language;
      active.continuous = true;
      active.interimResults = false;
      const finalResults = new Set<number>();
      active.onstart = () => {
        if (isCurrent(token)) setPhase("listening");
      };
      active.onresult = (event) => {
        if (!isCurrent(token)) return;
        const words: string[] = [];
        for (let index = event.resultIndex; index < event.results.length; index++) {
          const result = event.results[index];
          if (result.isFinal && !finalResults.has(index)) {
            finalResults.add(index);
            if (result[0].transcript.trim()) words.push(result[0].transcript.trim());
          }
        }
        if (words.length) {
          const previous = current.current.draft;
          const next = previous + (previous && !/\s$/.test(previous) ? " " : "") + words.join(" ");
          current.current.draft = next;
          current.current.onDraft(next);
        }
      };
      active.onerror = (event) => {
        if (!isCurrent(token)) return;
        setError(
          ["not-allowed", "service-not-allowed"].includes(event.error)
            ? "Microphone permission was denied. Allow access in your browser to dictate."
            : event.error === "no-speech"
              ? "No speech detected. Try again."
              : "On-device dictation failed. Try again.",
        );
        cancel();
        setPhase("idle");
      };
      active.onend = () => {
        if (!isCurrent(token)) return;
        recognition.current = undefined;
        generation.current++;
        setPhase("idle");
      };
      recognition.current = active;
      setPhase("listening");
      active.start();
    } catch {
      if (!isCurrent(token)) return;
      cancel();
      setPhase("idle");
      setError("On-device dictation could not start. Check browser microphone permissions.");
    }
  };
  const install = async () => {
    if (!enabled || !downloadable || !constructor?.install || phase !== "idle") return;
    const token = ++generation.current;
    setPhase("installing");
    setError("");
    try {
      const installed = await constructor.install(options);
      if (!isCurrent(token)) return;
      setDownloadable(!installed);
      setError(installed ? "" : "Dictation language could not download. Try again.");
    } catch {
      if (isCurrent(token)) setError("Dictation language could not download. Try again.");
    } finally {
      if (isCurrent(token)) setPhase("idle");
    }
  };
  return {
    phase,
    error,
    downloadable,
    supported: !!constructor,
    active: phase !== "idle",
    toggle,
    install,
  };
}
