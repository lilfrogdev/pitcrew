# Frontend layout and sidebar QA — 2026-10-06

## Layout

All eleven stylesheets use shared radius tokens: 3 px small details, 6 px
controls, 8 px panels and a circular avatar. The composer uses the panel radius.
Conversation gutters are 16 px on desktop and 12 px on narrow screens; the former
8% wide-screen gutter is removed. Messages use a fixed 32 px avatar column and a
separate flexible content column. Message spacing is 16 px.

The supplied spacing and transcript reference images were downloaded through
Library and visually inspected. The second transcript reference demonstrates
the separate avatar/content columns. Existing transcript text remains plain
text; this change does not add a markdown parser.

User Chrome checks used an isolated local fixture with long paragraphs, literal
markdown-style text, a long URL, a text/code attachment, consecutive authors and
a missing avatar image. At 1440×1000 the composer grew from 692 to 720 px without
changing the sidebars. At 390×844 all content starts at x=56 beside the 32 px
avatar at x=12. No horizontal page overflow occurred. Actual screenshots were
inspected at both sizes. The existing model menu stayed inside the narrow
viewport; Escape closed it and restored focus to the model selector. The gold
favorites and neutral focus styling remain intact.

## Sidebar behavior

Pinned and Repositories folders have separate collapse keys for every account
and repository. Legacy local collapse preferences migrate only into Repositories;
Pinned starts independently. Successful archive removes the conversation pin,
and restoring does not recreate it. Failed archive retains the pin.

Focused sidebar/archive tests cover both collapse directions, persistence on
remount, account changes, selection, drafts, removal of the last pin while a
Pinned creation form is active, archive failure/retry, and restoration. An
independent reviewer found no remaining actionable issue after the draft fixes.
Chrome also verified Pinned closed while Repositories stayed open after reload;
successful archive removed its pin, restore through search stayed unpinned, and
Escape returned focus to Search.

## Right-hand Workspace audit

| View        | Implemented                                                              | Remaining scope                                 |
| ----------- | ------------------------------------------------------------------------ | ----------------------------------------------- |
| Browser     | Manual HTTP(S) URL validation, sandboxed iframe and open-in-browser link | Connected preview session or browser automation |
| Files       | Authenticated conversation text/image attachments                        | Repository tree and source content API          |
| Diffs       | Run selection and base/candidate/configuration metadata                  | Actual patch files and content                  |
| Review / PR | Run evidence, test/review details and landing controls                   | GitHub PR metadata/status/viewer                |

The tab shell, keyboard navigation, scoped selection, collapse and resize work.
The Files/Diffs/PR limitations are stated in the UI. A separate follow-up can own
`Workspace.tsx`, `Workspace.test.tsx` and a new `workspace-api.ts`, with new
authenticated project/thread-scoped read endpoints. Browser session integration
needs its own backend contract. These features are outside the layout patch.

No production state, managed runtime, account settings, invitations, mail or
model calls were changed by this QA.
