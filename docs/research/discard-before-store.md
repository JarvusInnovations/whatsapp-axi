# Discard before store: what whatsmeow persists on its own

Research notes for the spec author; not a spec. Verified against whatsmeow `ecc39170bc14` on
2026-11-14. Marks: **[verified]** (source read, linked), **[inferred]**, **[unknown]**. Links:
`https://github.com/tulir/whatsmeow/blob/ecc39170bc14/<file>#L<n>`.

The question: if the daemon throws away a group message in memory (for example one that does not
mention the account), is that message then stored **nowhere**? This decides whether a
"discarded messages leave no trace" guarantee is achievable and what must be configured for it.

Short answer: **message bodies can be kept off disk** with whatsmeow's defaults plus two settings.
**Metadata about discarded messages cannot be fully kept off disk without replacing parts of
whatsmeow's store**: by default it writes the sender's push name, the LID↔phone mapping, and for
many messages the (chat, sender, message id) of a message secret, before the application sees the
event.

## The receive pipeline, in order

For an incoming `<message>` node (`handleEncryptedMessage`,
[message.go#L44-L66](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L44-L66)):

1. **Parse the envelope** (chat, sender, id, timestamp, push name). **[verified]**
2. **Write the LID↔PN mapping** of the sender (`StoreLIDPNMapping`) if the stanza carries an
   alternate address. **[verified]** [message.go#L51-L55](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L51-L55)
3. **Write the business name** (verified business senders) and **the push name** to
   `whatsmeow_contacts`, in goroutines. **[verified]**
   [message.go#L56-L61](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L56-L61),
   [user.go#L680-L700](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/user.go#L680-L700)
4. **Decrypt** (`decryptMessages`, Signal session or group sender key). Session and sender-key
   ratchet state is updated in `whatsmeow_sessions` / `whatsmeow_sender_keys`. **[verified]** that
   these stores are written during decryption; **[inferred]** that every group message advances a
   sender-key row (that is how the Signal sender-key ratchet works).
   [message.go#L317](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L317)
5. **Optionally buffer the plaintext** in `whatsmeow_event_buffer`. Only when
   `Client.EnableDecryptedEventBuffer` is true; otherwise plaintext is returned directly and
   nothing is written. The field defaults to false (it is not set in `NewClient`). **[verified]**
   [message.go#L530-L540](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L530-L540),
   [client.go#L88](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/client.go#L88),
   [client.go#L270-L316](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/client.go#L270-L316)
6. **Process protocol parts** (`processProtocolParts`): first `storeMessageSecret` writes
   `(chat, sender, message id, secret)` to `whatsmeow_message_secrets` **if the message carries
   `messageContextInfo.messageSecret`**; then sender-key distribution, history-sync notifications,
   app-state key shares. **[verified]**
   [message.go#L960-L984](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L960-L984),
   [message.go#L986-L1008](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L986-L1008)
7. **Dispatch** `events.Message` to the application's handlers. **This is the first point where the
   application can decide to keep or discard.** **[verified]**
   [message.go#L1194-L1201](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L1194-L1201)
8. **Send the delivery receipt / ack** (see `whatsmeow.md`; inactive by default). **[verified]**
   [receipt.go#L285-L302](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/receipt.go#L285-L302)

How often messages carry a `messageSecret` is **[unknown]**. It is required for polls, events and
encrypted reactions/comments; current official clients may attach it to ordinary messages too.
Only captured traffic would tell.

## What reaches disk for a message the application discards

| Written by whatsmeow before dispatch | Table | Content? | Avoidable? |
| --- | --- | --- | --- |
| Signal session / sender-key ratchet update | `whatsmeow_sessions`, `whatsmeow_sender_keys` | no; reveals that this sender has sent in this group | **No**: required to decrypt the next message |
| LID↔PN mapping of the sender | `whatsmeow_lid_map` | no; phone number behind a LID | Only by replacing `Store.LIDs`, which whatsmeow also needs for addressing **[inferred]**: risky |
| Push name / business name of the sender | `whatsmeow_contacts` | no; display name of the sender | **Yes [inferred]**: wrap `Store.Contacts` so `PutPushName` / `PutBusinessName` are dropped (the daemon gets the push name on the event anyway) |
| Message secret (chat, sender, id, key) | `whatsmeow_message_secrets` | no body; ids, sender, key | **Yes [inferred]**: wrap `Store.MsgSecrets` to drop writes; cost: cannot decrypt poll votes or encrypted reactions to those messages |
| Decrypted plaintext | `whatsmeow_event_buffer` | **yes** | **Yes [verified]**: leave `EnableDecryptedEventBuffer` false (the default) |

`Store.Contacts` and `Store.MsgSecrets` are exported interface fields on `store.Device`
([store/store.go#L240-L254](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/store.go#L240-L254)),
so wrapping them is possible **[verified]**. Whether whatsmeow anywhere relies on reading back a
push name or secret it just wrote, in a way that breaks when the write is dropped, is
**[unknown]**: it needs a test against the library.

A tempting wrapper that only keeps writes for "kept" messages does not work directly: the push-name
write (step 3) and the secret write (step 6) happen **before** the application's decision
(step 7), and the push-name write runs in a goroutine. **[verified]** from the order above. A wrapper
would have to drop all such writes, or buffer them and commit only once the application decides.

Logs: whatsmeow logs message ids and JIDs at debug level in these paths (for example
"Stored message secret key for chat/sender/id"). **[verified]**
[message.go#L1003-L1005](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L1003-L1005).
Its logger must not run at debug level in production if the log is part of "no trace". **[inferred]**

The application's own memory: the decrypted `events.Message` lives in memory until garbage
collected. whatsmeow keeps an in-memory map of recent **sent** messages for retries, not received
ones. **[verified]** (`recentMessagesMap`,
[client.go#L303](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/client.go#L303)).

## History sync on link

- After linking, the phone sends history: a `protocolMessage.historySyncNotification`. With the
  default `DeviceProps`, `InlineInitialPayloadInE2EeMsg` is true, so the initial bootstrap payload
  arrives **inline in the encrypted message**; later chunks are downloaded from the media server.
  **[verified]** for the flag
  ([store/clientpayload.go#L131-L136](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/clientpayload.go#L131-L136))
  and the inline-or-download branch
  ([message.go#L796-L803](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L796-L803)).
- By default whatsmeow downloads each chunk, then **stores** from it: NCT salt, PN↔LID mappings,
  push names (for push-name syncs) and **the message secrets of every historical message**, then
  dispatches `events.HistorySync` with the full parsed history. **[verified]**
  [message.go#L804-L830](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L804-L830)
- With `Client.ManualHistorySyncDownload = true`, whatsmeow does **not** download or parse history;
  the notification is dispatched as an ordinary `events.Message` and the application may call
  `DownloadHistorySync` or ignore it. **[verified]**
  [message.go#L914-L920](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L914-L920),
  [message.go#L793-L795](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L793-L795)
- It still acks the notification to the phone unless `DisableManualHistorySyncReceipt` is also set.
  **[verified]** [message.go#L921-L928](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L921-L928).
  What the phone does when no receipt comes back (retries? marks the companion unhealthy?) is
  **[unknown]**.
- Can history be **refused** rather than discarded? `DeviceProps.HistorySyncConfig` is sent at
  pairing and has limits (`FullSyncDaysLimit`, `FullSyncSizeMbLimit`, `StorageQuotaMb`,
  `RecentSyncDaysLimit`, `InitialSyncMaxMessagesPerChat`), and `RequireFullSync` is false by
  default. **[verified]** that these fields exist
  ([store/clientpayload.go#L124-L157](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/clientpayload.go#L124-L157)).
  Whether setting them to zero makes the phone send nothing is **[unknown]**. It would only reduce
  what arrives; the inline initial payload probably still comes **[inferred]**, so it must be
  discarded in memory anyway.
- `SupportGroupHistory` is advertised as true by default. This likely relates to WhatsApp's newer
  feature of sharing recent group history with new members. **[inferred]** from the name only;
  what it delivers is **[unknown]**.

## App-state sync

- After linking, whatsmeow fetches app-state patches (contacts, mute/pin/archive, labels, etc.) and
  stores parts of them itself: **address-book contact names** (`PutAllContactNames`,
  `PutContactName`), **chat settings** (`PutMutedUntil`, pinned, archived), and secrets from
  "root secret" syncs. **[verified]**
  [appstate.go#L194](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/appstate.go#L194),
  [appstate.go#L288](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/appstate.go#L288),
  [appstate.go#L309](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/appstate.go#L309),
  [appstate.go#L444](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/appstate.go#L444)
- App state is the phone owner's own data (their address book and chat list), not other people's
  messages. **[inferred]** For a bot's dedicated phone it is the bot's own contacts. It is also the
  only source for "is this person in the account's contacts", which the kit wants. **[inferred]**

## Is "kept nowhere" achievable?

| Guarantee for a discarded group message | Achievable? | What it takes |
| --- | --- | --- |
| Body, caption, media keys never on disk | **Yes [inferred]** | `EnableDecryptedEventBuffer` false (default); `ManualHistorySyncDownload` true and never download; the application writes nothing for discarded messages; whatsmeow logging below debug |
| Message id never on disk | **Yes, with a wrapper [inferred]** | drop `MsgSecrets` writes (loses poll/encrypted-reaction decryption) |
| Sender's name never on disk | **Yes, with a wrapper [inferred]** | drop `PutPushName`/`PutBusinessName` |
| Sender's identity never on disk | **No [inferred]** | sender-key state per (group, sender) and the LID map are needed to decrypt and address; they reveal that a person sent something in that group, not what or when |
| Message never received | **No [verified]** | WhatsApp delivers every group message to every member device; a delivery receipt is sent automatically |

So the honest wording is roughly: *the daemon receives every message of a group it is in; it never
stores or exposes the content of a message it does not keep; the session store necessarily holds
encryption state for each group member who has sent a message.* The exact claim is the spec's
call; the table above is what the library allows.

## Implications for the spec (not decisions)

- Name the client settings the daemon must use: `EnableDecryptedEventBuffer=false`,
  `ManualHistorySyncDownload=true` (for non-`full` scopes at least), and a log level for whatsmeow.
- Decide whether to wrap `Store.Contacts` and `Store.MsgSecrets`, and accept the loss (no poll-vote
  decryption, push names only from live events).
- A "leaves no trace" test can cover the application's own files and outputs exactly. Covering
  whatsmeow's SQLite file needs either the wrappers plus a test that greps the database for a
  canary, or an explicit exclusion in the guarantee.
- The history-sync inline payload means discarding in memory is unavoidable on the first link.
- Contacts from app-state sync are what make "is this sender a contact" answerable.
