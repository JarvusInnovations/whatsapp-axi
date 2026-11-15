---
status: in-progress
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

- [x] Every test listed under "Tests" in `sending.md` exists and passes
- [x] Each limit is tested at the socket, with nothing sent or recorded on refusal
- [x] CLI tests for each command's output and error rendering
- [x] No response, event or log line contains key material (marker test)

## Risks

- Whether a quote renders without the embedded copy, and how much of the parent to embed, are
  unknown until tried on a real account. Embed text only; confirm in the pilot.

## Notes

Validated locally: `go vet`, `go test -race ./...`, the CGO-disabled build, and `npm run lint`,
`typecheck`, `build`, `test`. Where each `sending.md` test lives (`daemon/internal/runner/send_test.go`
unless noted): recorded before the client returns and a reply to it kept by the reply rule
(`TestSendRecordsBeforeTheClientReturns`); failed and not retried (`TestFailedSendIsMarkedAndNotRetried`);
one at a time (`TestConcurrentSendsReachTheClientOneAtATime`); reply from the kept copy, no keys,
unknown parent `not_found` (`TestReplyIsBuiltFromTheKeptCopy`); PDF as a document with its MIME type
and name, image with a preview (`TestSendFiles`, and `client/wa/send_test.go` for the library message
shape); download uses the stored descriptor unchanged, is idempotent, refuses view-once
(`TestDownload`); each limit (`TestSendLimitsAtTheSocket`); key material (`TestNoKeyMaterialFromSending`);
content never logged (`TestSentContentNeverLogged`). CLI: `test/act.test.ts`.

Client interface changes: `NewMessageID()`, `Send(ctx, OutMessage) (SendResult, error)`,
`React(ctx, chat, sender, id, emoji) (SendResult, error)`, `Download(ctx, *Media) ([]byte, error)`,
with `OutMessage`, `OutFile`, `SendResult` and `ErrNotDownloadable`.

Readings taken where a spec left room:

- **Event of an own send.** The row is written `pending` before the client is called; the `message`
  event is written when the send succeeds, so a consumer never sees a message that did not go out.
  A failed send keeps its row as `failed`, has no event, and is shown with `status: failed` (also
  `pending` mid-send); sent and received messages carry no `status`. A failed row does not count as
  "kept activity" for the first-contact limit.
- **The response** is `{id, chat, t}` (`chat` as WhatsApp answered, `t` its server time), plus
  `media` for a file.
- **Rekey on send.** A send to a phone-number id that WhatsApp answers with the hidden id rekeys
  the chat at once (`chat_rekeyed`), so the old id keeps resolving.
- **Sender form of an own message** is the id WhatsApp reports it went out as (`SendResponse.Sender`),
  else the account's phone-number id. Replies to it quote that form.
- **Quote contents**: the parent's id, its sender exactly as stored, and its text or caption as a
  plain text copy; never media or keys (plan Risk).
- **Mentions** accept a hidden id, a phone-number id or `+phone`, are matched against the group's
  members (or, in a direct chat, the other person and the account) and sent as the member's primary
  id. `@<user part>` is appended to the text when absent. Mentions are for `send` only: the socket's
  `send-file` body has no `mentions` field.
- **Limits.** Kept in memory (a restart forgets them). Rate counts every send that reached the
  client, failed ones included, and every reaction that was sent; a no-op reaction counts nothing.
  "Same text" compares trimmed text of `send` and the caption of `send-file`. `rate_limited` carries
  `retry_after_seconds` and a `Retry-After` header; `duplicate_text` has no retry hint. A group with
  nothing kept is a first contact too.
- **Files.** `path` must be absolute (the CLI resolves relative paths) and a regular, non-empty file
  within `send.max_file_mb` (`bad_request` otherwise). MIME: a known extension's type, else a
  specific sniffed type, else `application/octet-stream`. Type: `image/jpeg`/`image/png` → image,
  `video/mp4`/`video/3gpp` → video, `audio/*` → audio, else document. Audio with a caption is
  `bad_request` (the protocol's audio message has no caption). Images get a 72-pixel JPEG preview
  and their dimensions, made with the standard library; an image that cannot be decoded goes out
  without one.
- **react and download** accept a bare id without `chat`, resolved like `forget` (`409 ambiguous`
  with candidates). The account's own reaction is stored on the kept message and gets a `reaction`
  event (no wake line). Reacting to the account's own message sends no participant.
- **Download** needs `connected`. A descriptor without keys (a partial parent) and an expired
  server copy (HTTP 404/410 from the media server) are `not_downloadable`; other failures are
  `whatsapp_error`. The file name is `<chat>_<id><ext>` with unsafe characters replaced; the
  extension comes from the MIME type.
- **Errors** from the library are logged at warning level and answered with a fixed
  `whatsapp_error` message, since library error text can carry ids or paths.

## Follow-ups

- Pilot: confirm a reply renders as a quote with the text-only copy, a mention in a hidden-id group
  highlights, and a sent PDF arrives with its name.
