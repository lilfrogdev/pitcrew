import { render, screen } from "@testing-library/react";
import { expect, it } from "vite-plus/test";
import { MessageText } from "./MessageText";

it("renders bold, code, and a list from an agent reply", () => {
  render(
    <MessageText
      content={
        'Summary:\n\n- **Edit:** only `src/greet.js`.\n- **Check:** `pnpm test` must pass.'
      }
    />,
  );
  expect(screen.getByText("Summary:")).toBeTruthy();
  expect(screen.getByText("Edit:")).toBeTruthy();
  expect(screen.getByText("src/greet.js").tagName).toBe("CODE");
  expect(screen.getByRole("list").querySelectorAll("li")).toHaveLength(2);
});
