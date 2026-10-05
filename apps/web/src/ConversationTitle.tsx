import { useEffect, useRef, useState, type CSSProperties } from "react";
// Measure actual overflow so every title stops with its final character visible.
export function ConversationTitle({ title }: { title: string }) {
  const viewport = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);
  useEffect(() => {
    const measure = () =>
      setDistance(
        Math.max(0, (text.current?.scrollWidth ?? 0) - (viewport.current?.clientWidth ?? 0)),
      );
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    if (viewport.current) observer.observe(viewport.current);
    if (text.current) observer.observe(text.current);
    return () => observer.disconnect();
  }, [title]);
  return (
    <span
      ref={viewport}
      className="row-name conversation-name"
      style={
        {
          "--title-travel": `${-distance}px`,
          "--title-duration": `${Math.max(1, distance / 35)}s`,
        } as CSSProperties
      }
    >
      <span ref={text} className="conversation-title-text">
        {title}
      </span>
    </span>
  );
}
