---
status: done
pr: 10
depends: [daemon-core]
specs:
  - specs/daemon.md
  - specs/scopes.md
  - specs/identity.md
  - specs/security.md
---

# The WhatsApp client: adapter, states and linking

## Scope

The real implementation of the client interface on the library, the daemon's states, linking by
pairing code and by QR, logout, presence and read receipts, and the `auth` commands. Written and
unit-tested against the fake; the real adapter is exercised only in the pilot.

## Implements

- `daemon.md`: states, linking, unlinking, behaviour while connected.
- `scopes.md`: "Library settings the guarantee depends on", history never downloaded, chat types.
- `identity.md`: resolution of ids through the library's map; contacts.
- `socket-protocol.md`: `link` (streaming) and `logout`.
- `cli.md`: `auth link`, `auth logout`, and the link and state checks in `doctor`.
- `security.md`: rules 7, 8, 10 and 12.

## Approach

1. The adapter: open `session.db`, build the client with the required settings, translate library
   events into the daemon's incoming events (unwrap, classify message, edit, revoke, reaction;
   filter protocol traffic), and expose own ids, the id map and contacts.
2. The state machine, driven by connection events, with the stopped states that neither retry nor
   exit.
3. Linking: connect, wait until pairing is possible, request the code, enforce the phone number,
   stream progress.
4. Presence on connect and mark-read on keep.

## Validation

- [x] The state and linking tests in `daemon.md` pass against the fake
- [x] The event translation has tests for captions on each media type, replies, mentions by either id form, edits, revokes, reactions, and protocol traffic being filtered
- [x] The adapter compiles against the pinned library and sets every setting `scopes.md` requires, asserted in a test
- [x] `auth link` renders a code and a final result against a fake daemon; a mismatched number is refused
- [x] No test connects to WhatsApp

## Risks

- What the library puts in a quoted copy, and how a mention looks in a hidden-id group, are not
  established. The translation must tolerate missing fields; the pilot confirms the real shapes.
- Replacing nothing in the library's store keeps this plan small. The guarantee is worded to match.

## Notes

Validated locally: `go vet`, `go test -race ./...`, the CGO-disabled build, and `npm run lint`,
`typecheck`, `build`, `test`. "No test connects" was checked by running the adapter and link
test binaries under `strace -e trace=connect`: no `AF_INET`/`AF_INET6` connect, only the Unix
socket. The adapter is never started with a session in any test, so it never calls `Connect`.

Client interface changes (`internal/client`): `Link(ctx, LinkRequest, progress)`, `Logout(ctx)`
and `SendPresence(ctx)` added, with `LinkRequest`, `LinkProgress`, the errors `ErrLinkTimeout`,
`ErrWrongNumber`, `ErrOutdated`, and `PhoneMatches` (the number check, shared by the adapter's
pre-pair callback and the fake). `runner.Options.NewClient` now receives the opened session
store and the logger: `func(*sqlstore.Container, bool, *slog.Logger) client.Client`.
`whatsapp-axid run` passes `client/wa`; `client/offline` stays the default for runner tests.

Readings taken where a spec left room:

- **Who owns `linking`.** The daemon: it enters `linking` when a link starts and leaves it with
  the result. While linking, the adapter emits no state changes; after the pairing it waits for
  the reconnect as the new device and returns, so a successful result means `connected`.
- **The link stream.** Lines are `{"code"}`, `{"qr"}`, then one `{"result":{"linked","state",
  "me"?, "error"?}}`. Failures after the stream starts are in `result.error` with codes
  `wrong_number`, `link_timeout`, `link_cancelled` (the client went away), `outdated` and
  `whatsapp_error`. These are result codes inside a 200 stream, not new HTTP error codes.
- **Refusals before the stream.** A second attempt is `409 link_in_progress`. Linking an account
  that is not `unlinked` or `logged_out` is `400 bad_request` with `state` (the spec names no
  code for it). `phone` must be E.164 (`+15550100001`); `phone` and `qr` together, or neither, is
  `bad_request`.
- **A client that disconnects mid-link** abandons the attempt; the daemon returns to `unlinked`.
  The daemon also bounds the attempt at 3 min 10 s, over WhatsApp's own window.
- **Every failed link returns to `unlinked`**, including one started from `logged_out` (the
  library has deleted that session), except an outdated client, which enters `outdated`.
- **The number check** compares the pairing id's user part with the digits given, and only for
  a phone-number id. A QR link names no number and accepts any.
- **Logout** needs `connected` (the library's logout is a request to WhatsApp): `409 not_linked`
  with no session, `409 not_connected` otherwise, `502 whatsapp_error` if WhatsApp refuses. The CLI
  treats `not_linked` as an idempotent no-op. Logout leaves `store.db` alone.
- **Presence** is sent on every `connected` state change while `presence` is true, in the
  background. With it off, nothing is sent, and delivery receipts stay inactive (library default).
- **Library settings.** `EnableDecryptedEventBuffer=false`, `ManualHistorySyncDownload=true`,
  `UseRetryMessageStore=false`, `AutomaticMessageRerequestFromPhone=false`, auto-trust and
  auto-reconnect on; the library logger drops debug and info. `DisableManualHistorySyncReceipt`
  is left off: the spec says history is not downloaded, not that its notification goes
  unacknowledged, and research marks the phone's reaction to a missing receipt unknown.
- **Presented name.** Device props say Chrome on Linux; the pairing-code display name is
  `Chrome (Linux)`.
- **Translation.** Kept kinds are message, edit, revoke, reaction and encrypted (community
  announcement reactions and comments). Dropped: history (`SourceWebMsg`), newsletters,
  undecryptable messages, every protocol message other than edit and revoke, sender-key-only
  messages, poll votes, and any message with no content type the daemon reads (text, extended
  text, image, video, round video, audio, document, sticker, location, live location, contact,
  poll creation, and a group-mention wrapper, unwrapped). Location comment, contact name and poll
  name are the text. A caption is `Media.Caption`; a document's name falls back to its title.
- **Chat types.** `@g.us` is a group; a community announcement group is recognized only by its
  encrypted reactions and comments, which become `KindEncrypted` (the only handling the spec gives
  it). No group lookup is made per message.
- **States from connection events.** `Connected` → connected; `Disconnected` and
  `ConnectFailure` → connecting (the library retries); `LoggedOut` → logged_out with a reason by
  code; `TemporaryBan` → suspended with the expiry time; `ClientOutdated` → outdated.
  `StreamReplaced` (another process on the same session) has no state of its own: it is
  `connecting` with a reason saying to stop the other process and restart.
- **Phone activity** is taken from the account's own messages and from receipts sent by the
  account's phone (device 0).
- **Id mapping requests** go out only for phone-number ids (`GetUserInfo`), at most once an hour
  per id, and only when logged in. There is no request that maps a hidden id to a number; the
  library learns those from traffic.
- **Contacts.** A user is a contact when the library's contact store has an address-book name
  (full or first name); a push name alone is not.
- **Media key material** is carried as JSON of the direct path (exactly as received), URL, media
  key, both hashes, length and type, in the opaque `Media.Keys`.
- **doctor** gains a `link` check (linked as which number, or the `auth link` fix) and a fix for
  each stopped state: `auth link` for `logged_out`, the upgrade commands for `outdated`, wait and
  restart for `suspended`.

## Follow-ups

- `sending`: build sends, files, reactions and downloads on the adapter (`MediaKeys` is the
  download input).
- `service-linux`: point the `suspended` fix and the not-running help at `daemon restart` /
  `daemon start`.
- Pilot: every translation and linking path above is unit-tested against constructed library
  values only; see the plan's Risks.
