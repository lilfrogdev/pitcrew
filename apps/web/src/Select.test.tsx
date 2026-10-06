import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { Select } from "./Select";
afterEach(cleanup);
const options = [
  { value: "a", label: "Alpha" },
  { value: "disabled", label: "Unavailable", disabled: true },
  { value: "b", label: "Beta" },
  { value: "c", label: "Charlie" },
];
function Controlled({ onChange = () => {} }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("a");
  return (
    <>
      <Select
        label="Choice"
        value={value}
        options={options}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
      <button>Next</button>
    </>
  );
}
it("supports arrows, Home/End, commit, cancellation and Tab without trapping focus", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(<Controlled onChange={change} />);
  const control = screen.getByRole("combobox", { name: "Choice" });
  await user.tab();
  expect(document.activeElement).toBe(control);
  await user.keyboard("{ArrowDown}{ArrowDown}");
  expect(document.getElementById(control.getAttribute("aria-activedescendant")!)?.textContent).toBe(
    "Beta",
  );
  expect(change).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(control).toHaveProperty("value", "b");
  expect(change).toHaveBeenCalledOnce();
  expect(screen.queryByRole("listbox")).toBeNull();
  await user.keyboard("{End}{Home}{Escape}");
  expect(control).toHaveProperty("value", "b");
  expect(document.activeElement).toBe(control);
  await user.keyboard("{End}{Enter}");
  expect(control).toHaveProperty("value", "c");
  await user.keyboard("{Space}{Tab}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Next" }));
});
it("supports typeahead and repeated pointer selection, skips disabled options, and closes outside", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(<Controlled onChange={change} />);
  const control = screen.getByRole("combobox", { name: "Choice" });
  await user.tab();
  await user.keyboard("b");
  expect(control).toHaveProperty("value", "b");
  await user.click(control);
  await user.click(screen.getByRole("option", { name: "Unavailable" }));
  expect(control).toHaveProperty("value", "b");
  expect(change).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("option", { name: "Alpha" }));
  expect(document.activeElement).toBe(control);
  for (let index = 0; index < 3; index++) {
    await user.click(control);
    await user.click(screen.getByRole("option", { name: "Alpha" }));
  }
  expect(change).toHaveBeenCalledTimes(2);
  await user.click(control);
  await user.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.queryByRole("listbox")).toBeNull();
});
it("dismisses an open popup when controls become unavailable and restores no stale selection", () => {
  const change = vi.fn();
  const view = render(<Select label="Choice" value="a" options={options} onChange={change} />);
  fireEvent.click(screen.getByRole("combobox"));
  view.rerender(<Select label="Choice" value="a" options={options} onChange={change} disabled />);
  expect(screen.queryByRole("listbox")).toBeNull();
  view.rerender(
    <Select
      label="Choice"
      value="removed"
      options={options}
      onChange={change}
      placeholder="Unavailable"
      invalid
      describedBy="reason"
    />,
  );
  const control = screen.getByRole("combobox");
  expect(control.textContent).toBe("Unavailable");
  expect(control.getAttribute("aria-expanded")).toBe("false");
  expect(control.getAttribute("aria-invalid")).toBe("true");
  expect(control.getAttribute("aria-describedby")).toBe("reason");
  expect(change).not.toHaveBeenCalled();
});

it("closes pointer selections inside a label without its default action reopening the popup", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <label>
      Choice
      <Select label="Choice" value="a" options={options} onChange={change} />
    </label>,
  );
  const control = screen.getByRole("combobox", { name: "Choice" });
  for (let index = 0; index < 3; index++) {
    await user.click(control);
    await user.click(screen.getByRole("option", { name: "Beta" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(control);
  }
  expect(change).toHaveBeenCalledTimes(3);
});
