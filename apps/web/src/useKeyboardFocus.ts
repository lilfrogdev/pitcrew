import { useEffect, useState } from "react";
/** Track navigation modality only; never inspect or retain text field contents. */
export function useKeyboardFocus() {
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Tab") setKeyboard(true);
    };
    const pointer = () => setKeyboard(false);
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", pointer, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", pointer, true);
    };
  }, []);
  return keyboard;
}
