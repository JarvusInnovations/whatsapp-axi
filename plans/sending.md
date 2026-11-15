---
status: planned
depends: [whatsapp-client, cli-core]
specs:
  - specs/sending.md
  - specs/cli.md
  - specs/socket-protocol.md
---

# Sending, reactions, files and downloads

## Scope

`send`, `send-file`, `react` and `download`, end to end: the daemon requests, the send queue, the
limits, and the CLI commands.

## Implements

- `sending.md`: all of it.
- `socket-protocol.md`: `send`, `send-file`, `react`, `download` and their error codes.
- `cli.md`: the "Acting" commands except `forget`.
- `security.md`: rules 6 and 9.

## Approach

1. Own-message record first, then the serialized send, then the result.
2. The reply builder from the kept copy; mentions from group membership.
3. Files: type detection, document name, image preview, size limit.
4. Download from the stored descriptor into `media/`.
5. The three limits, in the daemon, in front of every send path.

## Validation

- [ ] Every test listed under "Tests" in `sending.md` exists and passes
- [ ] Each limit is tested at the socket, with nothing sent or recorded on refusal
- [ ] CLI tests for each command's output and error rendering
- [ ] No response, event or log line contains key material (marker test)

## Risks

- Whether a quote renders without the embedded copy, and how much of the parent to embed, are
  unknown until tried on a real account. Embed text only; confirm in the pilot.

## Notes

## Follow-ups
