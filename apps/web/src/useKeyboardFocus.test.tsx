import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vite-plus/test";
import { useKeyboardFocus } from "./useKeyboardFocus";
afterEach(cleanup);
it("shows neutral text focus only after keyboard navigation and resets on pointer input", () => {
  function Fixture() {
    return <div data-testid="modality" data-keyboard-focus={useKeyboardFocus()} />;
  }
  render(<Fixture />);
  const modality = screen.getByTestId("modality");
  fireEvent.pointerDown(document);
  expect(modality.getAttribute("data-keyboard-focus")).toBe("false");
  fireEvent.keyDown(document, { key: "a" });
  expect(modality.getAttribute("data-keyboard-focus")).toBe("false");
  fireEvent.keyDown(document, { key: "Tab" });
  expect(modality.getAttribute("data-keyboard-focus")).toBe("true");
  fireEvent.pointerDown(document);
  expect(modality.getAttribute("data-keyboard-focus")).toBe("false");
});
