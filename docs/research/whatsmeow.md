# whatsmeow: licence, linking, session store, connection behaviour

Research notes for the spec author; not a spec. Verified against whatsmeow `ecc39170bc14`
(module version `v0.0.0-20261113220833-ecc39170bc14`, the version `daemon/go.mod` pins) on
2026-11-14.

Each claim is marked **[verified]** (read in the source or doc linked), **[inferred]** (reasoned
from the source, not shown directly) or **[unknown]**. Source links point at that commit:
`https://github.com/tulir/whatsmeow/blob/ecc39170bc14/<file>#L<n>`.

## Licence

- whatsmeow is licensed under the **Mozilla Public License 2.0**. **[verified]**
  [LICENSE](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/LICENSE)
- MPL-2.0 is a file-level copyleft. Section 3.3 allows a "Larger Work" that combines MPL-covered
  files with files under other terms; the other files keep their own licence. **[verified]**
  [MPL-2.0 §3.3](https://www.mozilla.org/en-US/MPL/2.0/)
- Consequences for an MIT project that links whatsmeow as an unmodified Go module dependency
  **[inferred]** (from the MPL text; not legal advice):
  - The project's own files can be MIT.
  - Any modified whatsmeow file stays MPL-2.0 and its source must be available.
  - Distributing a compiled binary that contains whatsmeow (for example a prebuilt daemon inside an
    npm package) triggers §3.2: recipients must be told how to get the MPL-covered source. A
    `THIRD_PARTY_NOTICES` file or README section pointing at the exact whatsmeow version satisfies
    this in common practice.
- **whatsmeow depends on `go.mau.fi/libsignal`, which is GPL-3.0.** **[verified]**: the
  `LICENSE` of `go.mau.fi/libsignal@v0.2.2` (the version resolved in `daemon/go.sum`) is the GNU
  GPL v3 with no linking exception
  ([libsignal LICENSE](https://github.com/tulir/libsignal/blob/v0.2.2/LICENSE); upstream repo path
  is an **[inferred]** mirror of the module, the local module cache copy was read). It is compiled
  into every daemon binary (`go list -deps ./cmd/whatsapp-axid` lists it).
- Consequences **[inferred]** (from the GPL-3.0 and MPL-2.0 texts; not legal advice):
  - The **source** of this project can still be MIT: MIT is GPL-compatible, and nothing in the
    repository copies GPL code.
  - A distributed **daemon binary** is a combined work that includes GPL-3.0 code, so it may only
    be distributed under GPL-3.0 terms: the complete corresponding source (this repo at the
    release tag plus the exact dependency versions) must be offered with it, and recipients get
    GPL-3.0 rights to the binary. MPL-2.0 code may be combined this way (MPL-2.0 §3.3, "Secondary
    License"), since whatsmeow does not carry the "Incompatible With Secondary Licenses" notice
    **[verified]** by reading its LICENSE header.
  - The **TypeScript CLI** talks to the daemon over a socket and does not link it, so it is not
    part of the combined work. **[inferred]**; this is the usual reading for separate programs
    communicating at arm's length.
  - The README's licence section should say this plainly before any binary ships.
- Other compiled dependencies, all **[verified]** from their `LICENSE` files in the module cache:
  `go.mau.fi/util` MPL-2.0; `filippo.io/edwards25519`, `google/uuid`, `golang.org/x/*`,
  `google.golang.org/protobuf` BSD-3-Clause; `coder/websocket` ISC; `rs/zerolog`,
  `mattn/go-colorable`, `mattn/go-isatty`, `elliotchance/orderedmap`, `vektah/gqlparser`,
  `beeper/argo-go` MIT. A SQLite driver will add one more (see `distribution.md`).

## Linking a device

whatsmeow links as a *companion device* of an existing phone account, the same mechanism as
WhatsApp Web. Two ways.

### QR code

- `GetQRChannel(ctx)` must be called **before** `Connect()`, and only when the store holds no
  device id. **[verified]**
  [qrchan.go#L215-L228](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/qrchan.go#L215-L228)
- The channel emits `code` items, then exactly one terminal item (`success`, `timeout`,
  `err-client-outdated`, `err-unexpected-state`, …) and closes. **[verified]**
  [qrchan.go#L22-L53](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/qrchan.go#L22-L53)
- The server sends six codes. The first is valid 60 s, the rest 20 s each, so about 160 s in total
  before the login socket closes. **[verified]**
  [qrchan.go#L92-L95](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/qrchan.go#L92-L95),
  [pair-code.go#L83-L85](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/pair-code.go#L83-L85)
- The user scans with the phone: WhatsApp → Settings (iOS) or ⋮ menu (Android) → Linked devices →
  Link a device. **[verified]** [WhatsApp FAQ: link a device](https://faq.whatsapp.com/1317564962315842)

### Phone-number pairing code

- `PairPhone(ctx, phone, showPushNotification, clientType, clientDisplayName)` returns a code.
  **[verified]**
  [pair-code.go#L92](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/pair-code.go#L92)
- Preconditions, from the doc comment: connect first, and wait for the first `*events.QR` (or the
  first item from `GetQRChannel`) so the socket is fully established; call it right away, because
  the same ~160 s login-socket limit applies. **[verified]**
  [pair-code.go#L77-L86](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/pair-code.go#L77-L86)
- `phone` is stripped to digits; it must be longer than 6 digits and must not start with `0`
  (international format, no `+` needed). **[verified]**
  [pair-code.go#L97-L102](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/pair-code.go#L97-L102)
- `clientDisplayName` must look like `Browser (OS)` with a common browser and OS, or the server
  returns 400. `clientType` must be a `PairClient*` constant; which one does not matter.
  **[verified]**
  [pair-code.go#L87-L90](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/pair-code.go#L87-L90),
  [pair-code.go#L35-L37](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/pair-code.go#L35-L37)
- The code is 8 characters from the alphabet `123456789ABCDEFGHJKLMNPQRSTVWXYZ`, returned with a
  dash in the middle (`ABCD-EFGH`). **[verified]**
  [pair-code.go#L50](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/pair-code.go#L50),
  [pair-code.go#L142](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/pair-code.go#L142)
- With `showPushNotification` true, the phone shows a notification prompting the user to enter
  the code. **[inferred]** from the attribute name `should_show_push_notification`
  ([pair-code.go#L114](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/pair-code.go#L114)).
- What the user does on the phone: Linked devices → Link a device → **Link with phone number
  instead**, then types the 8-character code. **[verified]**
  [WhatsApp FAQ: link with phone number](https://faq.whatsapp.com/1324084875126592) (the FAQ
  whatsmeow's doc comment cites). The exact button wording differs by app version and platform:
  **[unknown]** for current Android and iOS builds.
- Exact code expiry: "unknown" per whatsmeow's own comment; bounded by the ~160 s socket.
  **[verified]** [pair-code.go#L83](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/pair-code.go#L83)
- On success whatsmeow emits `events.PairSuccess{ID, LID, BusinessName, Platform}`, then the
  server closes the socket and whatsmeow reconnects as the paired device. **[verified]** for the
  event type
  ([types/events/events.go#L52-L56](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/events/events.go#L52-L56));
  **[inferred]** for the reconnect sequence (code 515 "restart required" handling in
  [connectionevents.go#L28-L37](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/connectionevents.go#L28-L37)).
- `Client.PrePairCallback(jid, platform, businessName) bool` can veto a pairing before it
  completes (for example to check the phone number is the expected one). **[verified]**
  [client.go#L174-L176](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/client.go#L174-L176)

## Session store

- whatsmeow keeps all device state behind interfaces on `store.Device`: `Identities`, `Sessions`,
  `PreKeys`, `SenderKeys`, `AppStateKeys`, `AppState`, `Contacts`, `ChatSettings`, `MsgSecrets`,
  `PrivacyTokens`, `NCTSalt`, `EventBuffer`, `LIDs`. **[verified]**
  [store/store.go#L240-L254](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/store.go#L240-L254)
- These are public fields, so an application can replace any one of them with its own
  implementation (for example a wrapper that drops some writes). **[verified]** that they are
  exported interface fields; **[inferred]** that replacing them after `GetFirstDevice` is safe
  (no doc says so; needs a test).
- The shipped implementation is `store/sqlstore`, over `database/sql` with SQLite or Postgres.
  `sqlstore.New(ctx, dialect, address, log)` opens and upgrades the database. **[verified]**
  [store/sqlstore/container.go#L46-L58](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/sqlstore/container.go#L46-L58)
- The SQLite dialect is any driver name starting with `sqlite` (so `sqlite3` for the CGO
  `mattn/go-sqlite3` driver, `sqlite` for pure-Go `modernc.org/sqlite`). **[verified]**
  [go.mau.fi/util dbutil ParseDialect](https://github.com/mautrix/go-util/blob/v0.11.0/dbutil/database.go#L39-L49)
  (see `distribution.md` for the CGO trade-off).
- One SQLite file can hold several devices (`GetAllDevices`), but whatsmeow is usually run with one
  device per file. **[verified]**
  [store/sqlstore/container.go#L157-L170](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/sqlstore/container.go#L157-L170)

What the tables hold
([schema](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/sqlstore/upgrades/00-latest-schema.sql)),
all **[verified]** from the schema; the "content?" column is the important one for
`discard-before-store.md`:

| Table | Holds | Message content? |
| --- | --- | --- |
| `whatsmeow_device` | own JID, LID, noise/identity/signed-prekey keys, registration id, ADV secret, push name, platform | no (secret keys) |
| `whatsmeow_identity_keys` | peers' identity keys, per address | no; reveals who the account has had sessions with |
| `whatsmeow_pre_keys` | own one-time prekeys | no (secret keys) |
| `whatsmeow_sessions` | Signal sessions per peer device | no; reveals peer devices |
| `whatsmeow_sender_keys` | group sender-key state per (group, sender) | no; reveals who has sent in which group |
| `whatsmeow_app_state_*` | app-state sync keys, versions, mutation MACs | no |
| `whatsmeow_contacts` | per user: first/full name (address book), push name, business name, redacted phone | no; names of message senders |
| `whatsmeow_chat_settings` | muted/pinned/archived per chat | no |
| `whatsmeow_message_secrets` | (chat, sender, message id) → secret key | no body; message ids and senders |
| `whatsmeow_privacy_tokens` | per-user tokens | no |
| `whatsmeow_lid_map` | LID ↔ phone-number pairs | no; reveals phone numbers behind LIDs |
| `whatsmeow_event_buffer` | **decrypted plaintext** keyed by ciphertext hash | **yes, when enabled** (off by default) |
| `whatsmeow_retry_buffer` | own outgoing messages (serialized) for retry receipts | yes, own outgoing only |

All key material is in the SQLite file, so the file is the account: anyone who can read it can
impersonate the linked device. **[inferred]** from the `whatsmeow_device` columns.

## Reconnects and "client outdated"

- `EnableAutoReconnect` defaults to true. **[verified]**
  [client.go#L311](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/client.go#L311)
- The reconnect loop waits `AutoReconnectErrors × 2 s` before each attempt (0 s, 2 s, 4 s, … with
  no cap in this loop), and stops on an expected disconnect or a cancelled context.
  `AutoReconnectHook(err) bool` can stop it. **[verified]**
  [client.go#L651-L675](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/client.go#L651-L675),
  [client.go#L79-L85](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/client.go#L79-L85)
- Auto-reconnect only runs for a paired device (`Store.ID != nil`). **[verified]**
  [client.go#L652](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/client.go#L652)
- Connect-failure handling **[verified]**
  [connectionevents.go#L102-L155](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/connectionevents.go#L102-L155):
  - 401 (logged out), 403 ("main device gone"; WhatsApp Web calls it LOCKED), 406 (unknown
    logout; WhatsApp Web calls it BANNED) → `events.LoggedOut{OnConnect: true, Reason}` **and
    whatsmeow deletes the device from the store**.
  - 402 → `events.TemporaryBan{Code, Expire}`.
  - 405 → `events.ClientOutdated{}` and an error log naming the client version.
  - others → auto-reconnect, or `events.ConnectFailure` if none will happen.
  - Reason codes: [types/events/events.go#L197-L232](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/events/events.go#L197-L232)
- A `stream:error` with code 401 and `conflict type="device_removed"` (the user removed the device
  on the phone) also emits `LoggedOut` and deletes the store; `conflict type="replaced"` emits
  `StreamReplaced` (another client connected with the same session). **[verified]**
  [connectionevents.go#L39-L50](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/connectionevents.go#L39-L50)
- "Client outdated" means the WhatsApp Web version baked into the library is too old. The version
  is a compiled-in constant, `store.GetWAVersion()`.
  [store/clientpayload.go#L78-L90](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/clientpayload.go#L78-L90)
  **[verified]**. `whatsmeow.GetLatestVersion(ctx, httpClient)` scrapes the current version from
  web.whatsapp.com and `store.SetWAVersion` overrides it, but the doc comment warns that keeping
  the library current is the real fix, since protocol changes usually come with it. **[verified]**
  [update.go#L25-L32](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/update.go#L25-L32),
  [store/clientpayload.go#L91-L97](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/clientpayload.go#L91-L97)
- So a daemon built once and never rebuilt will eventually stop connecting with 405. **[inferred]**;
  the old bridge hit exactly this (see `old-bridge-patches.md`).
- `events.KeepAliveTimeout{ErrorCount, LastSuccess}` and `events.KeepAliveRestored` report a
  stalled connection; whatsmeow does not reconnect on these by itself. **[verified]**
  [types/events/events.go#L99-L107](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/events/events.go#L99-L107)

## Linked-device expiry without the phone

- WhatsApp's FAQ: linked devices are logged out if the primary phone is not used for more than
  14 days. **[verified]** that the FAQ says so
  ([Linked devices FAQ](https://faq.whatsapp.com/1317564962315842)); the exact current number of
  days is **[unknown]** beyond the FAQ.
- How it shows up in whatsmeow: as a connect failure 401 (or a `device_removed` stream error) →
  `events.LoggedOut`, with the store deleted. **[inferred]**: the code paths are verified above,
  but which code WhatsApp sends for this specific expiry is not documented.
- whatsmeow exposes **no "phone last seen" value**. **[verified]** by absence: no such field on
  `store.Device` or `Client`. A daemon can only approximate it, for example from the timestamps of
  messages or app-state patches that come from the account's own device 0. **[inferred]**
- Because the store is deleted on logout, there is nothing to recover: the account must be linked
  again. **[verified]** (`cli.Store.Delete(ctx)` in the paths above).

## Side effects of merely being connected

### Delivery receipts

- whatsmeow sends a delivery receipt for every incoming message it decrypts. Unless the client is
  "active", the receipt has `type="inactive"`. **[verified]**
  [receipt.go#L285-L302](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/receipt.go#L285-L302)
- Per the doc comment, inactive receipts reach the sender but are **not rendered** in official
  apps (consistent with WhatsApp Web in the background). So senders do not see the second grey
  tick from the linked device alone. **[verified]** that the comment says so
  ([receipt.go#L240-L259](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/receipt.go#L240-L259));
  **[unknown]** whether the phone itself still marks delivered (it normally does, being online).
- The client becomes "active" (normal delivery receipts) after `SendPresence(PresenceAvailable)`,
  or always with `SetForceActiveDeliveryReceipts(true)`. **[verified]**
  [presence.go#L64-L75](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/presence.go#L64-L75),
  [receipt.go#L260-L269](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/receipt.go#L260-L269)
- There is no switch to send **no** delivery receipt at all. **[verified]** by reading
  `sendMessageReceipt` (no condition skips it for normal messages). Not acking would make the
  server redeliver. **[inferred]**

### Read receipts

- Read receipts (blue ticks) are sent only when the application calls `MarkRead`. **[verified]**
  [receipt.go#L202](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/receipt.go#L202). A
  daemon that never calls it never marks anything read. **[inferred]**

### Presence

- whatsmeow does not send presence on its own; `SendPresence` requires a push name and makes the
  account appear "online". **[verified]**
  [presence.go#L59-L75](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/presence.go#L59-L75)
- If presence is never sent, other users may see "-" as the account's name in some places, per the
  doc comment. **[verified]** that the comment says so.

### Other automatic traffic

- Protocol receipts for history-sync notifications are sent automatically unless
  `ManualHistorySyncDownload` and `DisableManualHistorySyncReceipt` are both set. **[verified]**
  [message.go#L914-L929](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L914-L929)
- `AutoTrustIdentity` defaults to true (identity changes of peers are accepted). **[verified]**
  [client.go#L312](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/client.go#L312)

## Implications for the spec (not decisions)

- Linking needs a running connection for up to ~160 s and must wait for the first QR event before
  asking for a pairing code; whatever process owns the session (the daemon) must run the link.
- `PrePairCallback` gives a cheap guard that the account being linked is the phone number the
  operator expects.
- A logout deletes the session from the store. "Logged out" is terminal and must be loud in any
  status or doctor output.
- 405 "client outdated" is a release problem, not a runtime one: the fix is a new daemon build with
  a newer whatsmeow. A doctor check and a documented upgrade path matter more than a runtime
  workaround.
- There is no "phone last seen" in the library; any check-in metric is an approximation and should
  be labelled as such.
- A connected daemon sends inactive delivery receipts automatically and never read receipts unless
  told to. Whether to ever send presence (and so active receipts) is a spec choice.
- The SQLite file is the account. Its permissions are the security boundary.
