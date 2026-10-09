import { expect, it } from "vite-plus/test";
import { invitationSelector } from "./invitations";

it("normalizes existing ASCII usernames and email selectors without confusing the optional @ prefix", () => {
  expect(invitationSelector("JohnCena")).toEqual({ kind: "username", value: "johncena" });
  expect(invitationSelector(" \t@JOHN_CENA\r\n")).toEqual({ kind: "username", value: "john_cena" });
  expect(invitationSelector(" JOHN@SYNTHETIC.TEST ")).toEqual({
    kind: "email",
    value: "john@synthetic.test",
  });
  for (const invalid of [
    undefined,
    {},
    "ab",
    "@ab",
    "john cena",
    "@@johncena",
    "john@host",
    "john\u0000cena",
    "\u00a0johncena\u00a0",
    "jöhncena",
    "@" + "a".repeat(33),
    "a".repeat(257),
  ])
    expect(invitationSelector(invalid)).toBeUndefined();
});
