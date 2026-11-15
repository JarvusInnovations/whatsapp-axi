# Sending: text, replies, reactions, edits, media, mentions, presence, ban risk

> Research notes for the spec author; not a spec. Verified against whatsmeow ecc39170bc14 on 2026-11-14.

Marks: **[verified]** = read the source line or doc; **[inferred]** = reasoned from source, not shown directly; **[unknown]** = only live traffic would settle it; **[community]** = a claim by third parties in issues or forums, not by the maintainer.

Links use `G` = `https://github.com/tulir/whatsmeow/blob/ecc39170bc14`. The proto file `proto/waE2E/WAWebProtobufsE2E.proto` is abbreviated `E2E.proto`. All ids are invented.

## 1. Sending text

- The signature is `SendMessage(ctx, to types.JID, message *waE2E.Message, extra ...SendRequestExtra) (SendResponse, error)`. It blocks until the server acks. **[verified]** [G/send.go#L167-L191](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L167-L191)
- The doc comment says to use `Conversation` for simple text, and that "replies, mentioning users and the 'forwarded' flag are stored in ContextInfo, which can be put in ExtendedTextMessage and any of the media message types". `Conversation` is a bare string with no ContextInfo. **[verified]** [G/send.go#L177-L184](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L177-L184), [E2E.proto#L1867](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1867)
- `SendResponse` has these fields: **[verified]** [G/send.go#L114-L133](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L114-L133)
  - `Timestamp`: the server time
  - `ID`
  - `ServerID`: newsletters only
  - `DebugTimings`
  - `Sender`: the identity used, LID or PN; the source comment says it is "not reliable in all cases"
  - `Chat`: the JID the message was actually sent to
- `SendRequestExtra` has these fields: **[verified]** [G/send.go#L146-L165](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L146-L165)
  - `ID`: optional caller-chosen ID
  - `Timeout`: defaults to 75s
  - `Peer`
  - `InlineBotJID`
  - `MediaHandle`: newsletters
  - `Meta`
  - `AdditionalNodes`
  - `CheckPermissions`
- **Message IDs**: `cli.GenerateMessageID()` returns `"3EB0"` followed by uppercase hex of the first 9 bytes of SHA-256(unix time ‖ own user + "@c.us" ‖ 16 random bytes). The package-level `GenerateMessageID()` (random only) is deprecated. If `req.ID` is empty, SendMessage generates one. **[verified]** [G/send.go#L40-L75](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L40-L75)
  - A caller can pre-generate the ID, persist it, and pass it in, so a crash-and-retry reuses the same ID. Whether the server dedupes repeated IDs is **[unknown]**.
- **PN DMs are rewritten to LID.** When `to` is `@s.whatsapp.net`, SendMessage looks up the LID in `Store.LIDs`, falls back to `GetUserInfo`, and fails with `ErrRecipientNotOnWhatsApp` if there is none. It then sends to the LID; `resp.Chat` is the LID. **[verified]** [G/send.go#L341-L364](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L341-L364)
- In LID-addressed groups the own identity becomes the own LID. **[verified]** [G/send.go#L312-L324](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L312-L324)
- **Sends are serialized** per client by `messageSendLock`; the source says "everything will explode if you send a message to the same user twice in parallel". **[verified]** [G/send.go#L388-L393](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L388-L393)
- Sent messages go into a recent-message cache so whatsmeow can answer retry receipts. **[verified]** [G/send.go#L395-L400](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L395-L400)

## 2. Replies (quoting)

- A reply must be an `ExtendedTextMessage` (or a media message) whose `ContextInfo` carries: **[verified]** (fields) [E2E.proto#L1603-L1606](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1603-L1606)
  - `StanzaID`: the parent message ID
  - `Participant`: the parent sender's JID string, non-AD; for groups, presumably also for DMs
  - `QuotedMessage`: a copy of the parent `Message`
  - optionally `RemoteJID`
- whatsmeow has **no** `BuildReply` helper. Callers fill `ContextInfo` by hand. **[verified]** (no such function in `send.go` or `msgsecret.go`)
- `BuildMessageKey` shows whatsmeow's convention for referencing a parent: `Participant` is set only when the chat is not a DM (`s.whatsapp.net`/`lid`/`msgr`) and the sender isn't self, using `sender.ToNonAD().String()`. A reply plausibly follows the same rule. **[inferred]** [G/send.go#L511-L524](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L511-L524)
- Is `QuotedMessage` required for the quote bubble to render? **[unknown]**. Bridges conventionally send it, and official clients render the bubble from the embedded copy, which suggests a quote without it renders empty or not at all. **[inferred]** Test live.
- How much of the parent to copy (strip media keys? nested contextInfo?) is **[unknown]**. A minimal text or caption copy is the conservative choice. **[inferred]**
- In LID groups, `Participant` should match the parent's `Info.Sender` form, which is LID in LID groups. **[inferred]**

## 3. Reactions, edits, revokes

- `BuildReaction(chat, sender, id, reaction string)` returns a `ReactionMessage{Key, Text, SenderTimestampMS}`. To remove a reaction, send `Text = ""` (`RemoveReactionText`). Newsletters use `NewsletterSendReaction` instead. **[verified]** [G/send.go#L545-L559](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L545-L559), [#L1057](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L1057)
- Reacting inside a **community announcement group** uses the encrypted form (`EncryptReaction` produces an `EncReactionMessage`), which needs the parent's message secret. **[verified]** [G/msgsecret.go#L470](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/msgsecret.go#L470); whether a plain reaction also works there is **[unknown]**.
- `BuildEdit(chat, id, newContent)` returns an `EditedMessage{ProtocolMessage{type MESSAGE_EDIT, Key{FromMe:true}, EditedMessage, TimestampMS}}`. `EditWindow = 20 * time.Minute`. **[verified]** [G/send.go#L607-L634](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L607-L634)
  - Whether whatsmeow enforces the window is **[inferred]** no: `EditWindow` is only a constant and no check was found in the send path. The server or recipients probably ignore late edits **[unknown]**.
- `BuildRevoke(chat, sender, id)`: pass an empty or own JID to revoke your own message, or the sender's JID to revoke as group admin. `RevokeMessage` is deprecated. **[verified]** [G/send.go#L499-L543](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L499-L543)
- The outgoing stanza's `edit` attribute is computed from the message shape: edit → `1`, sender revoke → `7`, admin revoke → `8`, reaction removal → `7`, pin → `2`. **[verified]** [G/send.go#L1059-L1084](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L1059-L1084)
- Polls: `BuildPollCreation(name, options, selectable)` and `BuildPollVote(ctx, pollInfo, optionNames)`. **[verified]** [G/msgsecret.go#L378-L421](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/msgsecret.go#L378-L421)

## 4. Files, documents, images

- `Upload(ctx, plaintext []byte, MediaType)` and `UploadReader(ctx, io.Reader, tempFile, MediaType)` encrypt and upload a file. Both return an `UploadResponse{URL, DirectPath, Handle, ObjectID, MediaKey, FileEncSHA256, FileSHA256, FileLength, StreamingSidecar}`. **[verified]** [G/upload.go#L32-L44](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/upload.go#L32-L44), [#L73](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/upload.go#L73), [#L115](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/upload.go#L115)
- The doc example copies `URL`, `DirectPath`, `MediaKey`, `FileEncSHA256`, `FileSHA256` and `FileLength` into the message, and sets `Mimetype` and optionally `Caption`. It says "the same applies to the other message types like DocumentMessage". **[verified]** [G/upload.go#L46-L72](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/upload.go#L46-L72)
- `MediaType` constants: `MediaImage`, `MediaVideo`, `MediaAudio`, `MediaDocument`, `MediaHistory`, `MediaAppState`, `MediaStickerPack` and `MediaLinkThumbnail`. Each value is the HKDF info string, so a file uploaded as one type must be sent as that message type. **[verified]** [G/download.go#L39-L51](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/download.go#L39-L51); the "must match" part is **[inferred]** from the keys being derived per type.
- `DocumentMessage` fields: `URL`, `mimetype`, `title`, `fileSHA256`, `fileLength`, `pageCount`, `mediaKey`, `fileName`, `fileEncSHA256`, `directPath`, `mediaKeyTimestamp`, `JPEGThumbnail`, `contextInfo` (17) and `caption` (20). **[verified]** [E2E.proto#L2532-L2554](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L2532-L2554)
  - `fileName` is what recipients see as the document name. **[inferred]**
  - `Upload` does not set `mediaKeyTimestamp`; callers may set it. **[verified]** (not in `UploadResponse`)
  - Incoming documents with captions sometimes come wrapped in `documentWithCaptionMessage`. Whether senders must wrap is **[unknown]**, since the plain `caption` field exists. **[verified]** (both exist)
- **Thumbnails**: whatsmeow never generates thumbnails; `JPEGThumbnail` is optional and caller-supplied. **[verified]** (no thumbnail code outside proto and the upload doc comment, [G/upload.go#L58](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/upload.go#L58)). Without one, images and videos likely show a blank preview until downloaded. **[inferred]**
- `ImageMessage` has `caption` (3), `height`/`width`, `JPEGThumbnail` (16) and `contextInfo` (17). **[verified]** [E2E.proto#L1310-L1331](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1310-L1331)
- Newsletters use `UploadNewsletter`, which is unencrypted and requires `SendRequestExtra.MediaHandle`. **[verified]** [G/upload.go#L181-L200](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/upload.go#L181-L200)

## 5. Outgoing mentions

- The convention is to put JID strings in `ContextInfo.MentionedJID` and `@<user>` in the text, inside an `ExtendedTextMessage` or a caption. whatsmeow has no helper and does no text rewriting. **[verified]** (field; no helper exists) [E2E.proto#L1607](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1607). The text convention is **[community]** ([whatsmeow-node guide](https://nicastelo.github.io/whatsmeow-node/docs/guides/automate-group-messages)).
- LID vs PN in LID groups: use the participant's primary `GroupParticipant.JID`, which is LID in LID groups, and its user part in the text. **[inferred]** from `GroupParticipant.JID` being "the primary JID that should be used". [G/types/group.go#L103-L108](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/group.go#L103-L108)
  - Whether a PN mention in a LID group still highlights correctly is **[unknown]**. Whether recipients render `@<lid-number>` as the contact's name is **[unknown]**, though it is likely since that is how official clients send. Test live.

## 6. Presence and typing

- `SendMessage` neither requires nor sets presence. `send.go` contains no presence calls. **[verified]**
- `SendPresence(ctx, PresenceAvailable|PresenceUnavailable)` fails with `ErrNoPushName` if `Store.PushName` is empty. The doc says to call it once after connecting "so that the server has your pushname. Otherwise, other users will see '-' as the name." **[verified]** [G/presence.go#L60-L87](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/presence.go#L60-L87)
- Side effect: until `PresenceAvailable` is sent, delivery receipts go out as `type="inactive"`, which senders' apps don't render as two grey ticks. `SetForceActiveDeliveryReceipts(true)` overrides this. **[verified]** [G/receipt.go#L244-L268](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/receipt.go#L244-L268)
- Typing: `SendChatPresence(ctx, jid, ChatPresenceComposing|ChatPresencePaused, ChatPresenceMediaText|ChatPresenceMediaAudio)`. **[verified]** [G/presence.go#L127-L143](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/presence.go#L127-L143)
- Read receipts are sent with `MarkRead(ctx, ids, ts, chat, sender)`; `sender` is required in groups. **[verified]** [G/receipt.go#L192-L202](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/receipt.go#L192-L202)
- That typing indicators or presence reduce ban risk is **[community]** folklore only; no source was found.

## 7. Ban and rate considerations

- The README makes **no** statement about bans, rate limits or official support. It only says this is "a Go library for the WhatsApp web multidevice API", and it calls status sending "experimental, may not work for large contact lists". **[verified]** [G/README.md#L4](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/README.md#L4), [#L30](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/README.md#L30)
- The library encodes WhatsApp's temp-ban reasons, which are the most authoritative hints available. **[verified]** [G/types/events/events.go#L153-L190](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/events/events.go#L153-L190)
  - `101`: "sent too many messages to people who don't have you in their address books"
  - `102`: "too many people blocked you"
  - `103`: "created too many groups with people who don't have you in their address books"
  - `104`: "sent the same message to too many people"
  - `106`: "sent too many messages to a broadcast list"
  - These arrive as `events.TemporaryBan{Code, Expire}`.
- Connect-failure codes: `401` logged out, `402` temp banned, `403` "main device gone" (called LOCKED in WA web; "seems to happen for both bans and switching phones"), `406` (called BANNED in WA web), `405` client outdated. `IsLoggedOut()` is true for 401, 403 and 406. These surface as `events.LoggedOut`, `TemporaryBan` or `ConnectFailure`, and the client does not auto-reconnect after them (`PermanentDisconnect`). **[verified]** [G/types/events/events.go#L113-L128](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/events/events.go#L113-L128), [#L192-L232](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/events/events.go#L192-L232)
- [Issue #561](https://github.com/tulir/whatsmeow/issues/561) (2024) reported a 403 with "You have been logged out for using an unofficial app". The maintainer closed it as a duplicate of #810 without comment. Commenters blamed missing WAM analytics. **[community]**
- [Issue #810](https://github.com/tulir/whatsmeow/issues/810) (2025, closed "not planned", locked Oct 2026) collected "Your account may be at risk / unauthorized tools" warnings and some bans. They were reported even for reply-only and idle accounts, and across Baileys and whatsapp-web.js too. **[community]**
  - One contributor called it "mostly a behavioral issue".
  - Suggested triggers: messaging many non-contacts and sending identical messages repeatedly. Meta Verified business accounts reportedly stopped the warnings.
  - The maintainer gave no guidance on volume, new accounts or automation.
- WhatsApp's own FAQ says it bans accounts for ToS violations such as spam or automated messaging: [whatsapp.com/faq/en/general/23154266](https://whatsapp.com/faq/en/general/23154266). **[community]** (vendor policy, not whatsmeow)
- No published safe volume thresholds were found. **[unknown]**

## Implications for the spec (not decisions)

- Persist a caller-chosen message ID before calling `SendMessage`, so retries are idempotent from the daemon's side. Server-side dedupe is unknown.
- `resp.Chat` can differ from the requested `to` (PN → LID). Outbound records must key on a normalized chat id.
- Sends are serialized inside whatsmeow. The daemon queue gives no throughput gain from parallel `SendMessage` calls on one account.
- Replies, mentions and captions all require `ExtendedTextMessage` or media; `Conversation` is only for bare text. The reply helper is ours to write, including which parent fields to copy into `QuotedMessage`.
- Mention JIDs should come from group participant info (`JID` primary form), not be built from phone numbers.
- Call `SendPresence(Available)` once per connect, or set `SetForceActiveDeliveryReceipts`; otherwise the pushname shows as "-" and delivery ticks look inactive.
- The temp-ban codes (101–106) are a concrete spec input for outbound guardrails: messaging non-contacts, identical fan-out messages, group creation. Treat `PermanentDisconnect` events as a stop condition, never auto-retry.
- Thumbnails for images, videos and documents are the daemon's job if previews matter.
