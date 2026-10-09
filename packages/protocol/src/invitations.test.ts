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

it("rejects embedded ASCII controls in both halves of an email while permitting outer ASCII trim", () => {
  for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
    const control = String.fromCharCode(code);
    expect(invitationSelector(`john${control}@synthetic.test`)).toBeUndefined();
    expect(invitationSelector(`john@synthetic${control}.test`)).toBeUndefined();
  }
  expect(invitationSelector(" \t\r\nJOHN@SYNTHETIC.TEST\v\f ")).toEqual({
    kind: "email",
    value: "john@synthetic.test",
  });
  expect(invitationSelector("\u0000john@synthetic.test")).toBeUndefined();
  expect(invitationSelector("john@synthetic.test\u007f")).toBeUndefined();
});
