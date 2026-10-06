import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vite-plus/test";
import { NavigationRail } from "./NavigationRail";
afterEach(cleanup);
it("shows the signed-in user's photo in the profile rail", () => {
  render(
    <NavigationRail
      section="work"
      onSelect={() => {}}
      viewer={{
        id: "owner",
        email: "owner@example.com",
        name: "Lilfrog",
        emailVerified: true,
        image: "https://example.com/avatar.png",
      }}
    />,
  );
  const profile = within(screen.getByRole("navigation", { name: "Workspace" })).getByRole(
    "button",
    { name: "Profile" },
  );
  expect(profile.querySelector("img")?.getAttribute("src")).toBe("https://example.com/avatar.png");
  expect(profile.getAttribute("aria-label")).toBe("Profile");
});
