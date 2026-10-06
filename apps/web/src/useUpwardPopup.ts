import {
  useLayoutEffect,
  useEffect,
  useState,
  type CSSProperties,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from "react";

/** Keep composer menus above their trigger, within the viewport and outside clipping parents. */
export function useUpwardPopup(
  open: boolean,
  trigger: RefObject<HTMLElement | null>,
  popup: RefObject<HTMLElement | null>,
  setOpen: Dispatch<SetStateAction<boolean>>,
  width?: number,
) {
  const [position, setPosition] = useState<CSSProperties>({
    position: "fixed",
    visibility: "hidden",
  });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !popup.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const menuWidth = Math.min(
        width ?? Math.max(anchor.width, popup.current.offsetWidth),
        viewportWidth - 16,
      );
      const above = Math.max(0, anchor.top - viewportTop - 14);
      const below = Math.max(0, viewportTop + viewportHeight - anchor.bottom - 14);
      const upward = above >= Math.min(160, popup.current.scrollHeight) || above >= below;
      setPosition({
        position: "fixed",
        visibility: "visible",
        width: menuWidth,
        left: Math.max(
          viewportLeft + 8,
          Math.min(anchor.left, viewportLeft + viewportWidth - menuWidth - 8),
        ),
        ...(upward ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }),
        maxHeight: Math.min(400, upward ? above : below),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open, trigger, popup, width]);
  useEffect(() => {
    if (!open) return;
    const contains = (target: EventTarget | null) =>
      target instanceof Node &&
      (trigger.current?.contains(target) || popup.current?.contains(target));
    const outside = (event: Event) => {
      if (!contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, trigger, popup, setOpen]);
  return position;
}
