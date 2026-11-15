---
status: done
pr: 28
depends: [house-style]
specs:
  - specs/conventions.md
---

# Repository gates: smoke test, scrub gate, retargeted PRs

## Scope

The CI items of `specs/conventions.md` "Repository" left by `house-style`: a smoke test on the
built CLI with no account and no daemon, a scrub check for real phone numbers and ids, and CI
re-running on a pull request's `edited` event.

## Implements

- `conventions.md` "Repository": the smoke test asserting a `code:` and no stack trace; the
  scrub check; the `edited` trigger.

## Approach

1. `scripts/scrub-check.sh`, adapted from the family's scrub gate: phone numbers outside the
   fictional +1 555-01xx range, WhatsApp phone-number, hidden and group ids outside their
   synthetic shapes, message ids without a synthetic run, home paths, and email addresses
   outside the documentation domains. `npm run check:scrub`.
2. `test/scrub.test.ts` plants each marker in a throwaway repository and checks the gate fails,
   and that the synthetic values pass.
3. CI: the smoke step runs `chats` (exit 1, `NO_ACCOUNT`), `chats --bogus` (exit 2,
   `UNKNOWN_FLAG`) and the home view (exit 0) in an empty environment, and fails on a stack
   trace; then the scrub gate; `pull_request` gains `edited`.

## Validation

- [x] The scrub gate passes on this tree and fails on each planted marker (test)
- [x] The smoke steps give the expected codes and exit statuses locally against the built CLI
- [x] CI runs both steps on this PR

## Risks

- A new synthetic id outside the allowed shapes fails CI; the gate's message says which rule.

## Notes

The allowed shapes are the ones the tests and specs already use: `+1555010xxxx`,
`1555010xxxx@s.whatsapp.net`, `1000000000000NN@lid`, `1203630000000000NN@g.us`, message ids with
six zeros or six Fs, `/home/user`, and `whatsapp-axi@<name>.service` unit names.

## Follow-ups

None.
