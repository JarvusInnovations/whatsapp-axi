# Incoming events, mentions, replies and chat types

> Research notes for the spec author; not a spec. Verified against whatsmeow ecc39170bc14 on 2026-11-14.

Marks: **[verified]** = read the source line or doc; **[inferred]** = reasoned from source, not shown directly; **[unknown]** = only live traffic would settle it.

Links are written as `G/<path>#L<n>`, where `G` = `https://github.com/tulir/whatsmeow/blob/ecc39170bc14`. The proto file `proto/waE2E/WAWebProtobufsE2E.proto` is abbreviated `E2E.proto`.

All ids below are invented (`15550100001@s.whatsapp.net`, `100000000000001@lid`, `120363000000000001@g.us`).

## 1. The `events.Message` envelope

- `events.Message` has `Info types.MessageInfo`, `Message *waE2E.Message` (unwrapped), `RawMessage` (as received) and flags `IsEphemeral`, `IsViewOnce`, `IsViewOnceV2`, `IsViewOnceV2Extension`, `IsDocumentWithCaption`, `IsLottieSticker`, `IsBotInvoke`, `IsEdit`. It also has `SourceWebMsg` (set when parsed from history sync), `UnavailableRequestID`, `RetryCount` and `NewsletterMeta`. **[verified]** [G/types/events/events.go#L322-L347](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/events/events.go#L322-L347)
- `MessageInfo` embeds `MessageSource` and adds `ID`, `ServerID` (newsletters), `Type`, `PushName`, `Timestamp`, `Category`, `MediaType`, `Edit` (an `EditAttribute`), `VerifiedName` and `DeviceSentMeta`. **[verified]** [G/types/message.go#L99-L118](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/message.go#L99-L118)
- `MessageSource` holds `Chat`, `Sender`, `IsFromMe`, `IsGroup`, `AddressingMode` (`"pn"` or `"lid"`), `SenderAlt`, `RecipientAlt`, `BroadcastListOwner` and `BroadcastRecipients`. **[verified]** [G/types/message.go#L14-L41](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/message.go#L14-L41)
- How the fields get filled (`parseMessageSource`): **[verified]** [G/message.go#L87-L191](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L87-L191)
  - **Group or broadcast**: `IsGroup=true`, `Chat=from`, `Sender=participant`. `SenderAlt` is `participant_pn`, or `participant_lid` when the addressing mode is not LID.
  - **DM**: `Chat=from.ToNonAD()` and `Sender=from`, which **keeps the device suffix**. `SenderAlt` is `sender_pn` when the sender is a LID, otherwise `sender_lid`.
  - **Self-sent from another of the account's devices**: `Chat` is the `recipient` attribute, and `RecipientAlt` holds the other form of that recipient.
  - **Newsletter**: `Chat = Sender = newsletter JID`. The source has a `TODO IsFromMe?`.
- `IsFromMe` is true when `Sender.User` equals **either** the own PN user or the own LID user. **[verified]** [G/message.go#L111-L113](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L111-L113), [L143](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L143)
- Before decrypting a DM from a PN sender, whatsmeow looks up the LID in its store and fills `info.SenderAlt` with it if found. **[verified]** [G/message.go#L343-L356](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L343-L356)
- Every message carrying a `SenderAlt`/`RecipientAlt` pair writes that LID-PN pair to the store (`StoreLIDPNMapping`). **[verified]** [G/message.go#L51-L55](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L51-L55)
- A DM chat can therefore show up as `15550100001@s.whatsapp.net` or as `100000000000001@lid`, depending on how the server addressed that stanza. A stable chat key has to normalize through the LID store. **[inferred]** from the DM branch, which uses `from` verbatim.

### Unwrapping

- whatsmeow calls `UnwrapRaw()` before dispatching each decrypted message. **[verified]** [G/message.go#L1194-L1201](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L1194-L1201)
- `UnwrapRaw` peels these wrappers in this fixed order, one layer each:
  1. `DeviceSentMessage` (also sets `Info.DeviceSentMeta`)
  2. `BotInvokeMessage`
  3. `EphemeralMessage`
  4. `ViewOnceMessage`, then `ViewOnceMessageV2`, then `ViewOnceMessageV2Extension`
  5. `LottieStickerMessage`
  6. `DocumentWithCaptionMessage`
  7. `EditedMessage`

  It then copies the outer `MessageContextInfo` inward if the inner one is nil. **[verified]** [G/types/events/events.go#L377-L425](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/events/events.go#L377-L425)
- Some `FutureProofMessage` wrappers in `Message` are **not** unwrapped, for example `groupMentionedMessage` (field 62) and `spoilerMessage` (field 118). Consumers see them still wrapped. **[verified]** [E2E.proto#L1918](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1918), [#L1963](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1963)
- Messages that fail to decrypt arrive as `events.UndecryptableMessage` (with `IsUnavailable` and `UnavailableType`), not as `events.Message`. **[verified]** [G/types/events/events.go#L301-L311](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/events/events.go#L301-L311)
- History sync arrives as `events.HistorySync` (raw protobuf). `Client.ParseWebMessage` turns each entry into an `events.Message`. **[verified]** [G/types/events/events.go#L275-L279](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/events/events.go#L275-L279), [G/client.go#L1047](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/client.go#L1047)

## 2. Mentions

- `ContextInfo.mentionedJID` (field 15) is a `repeated string` of JIDs. **[verified]** [E2E.proto#L1607](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1607)
- `ContextInfo` (field 17) appears on `ExtendedTextMessage`, `ImageMessage`, `VideoMessage`, `DocumentMessage`, `AudioMessage`, `StickerMessage`, `LocationMessage`, `ContactMessage`, `PollCreationMessage`, `ButtonsMessage`, `ListMessage`, `TemplateMessage` and others. **[verified]** [E2E.proto#L1209](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1209) (ExtendedText), [#L1331](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1331) (Image), [#L1119](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1119) (Video), [#L2549](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L2549) (Document)
- `Message.conversation` is a bare `string` with no `ContextInfo`, so a plain-text message can never carry a mention or a reply. A mention or reply always comes as `extendedTextMessage` or a media message with a caption. **[verified]** [E2E.proto#L1867](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1867)
- The mention scan must look at every sub-message type that has `contextInfo`, not only `extendedTextMessage`. Captions live in `ImageMessage.caption`, `VideoMessage.caption` and `DocumentMessage.caption` (field 20). **[verified]** [E2E.proto#L1320](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1320), [#L2552](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L2552)
- whatsmeow does not parse mentions itself. No non-generated code reads `MentionedJID`. **[verified]** (grep over the module, excluding `*.pb.go`)

### Group-wide and other mention fields

- `ContextInfo.groupMentions` (field 40) is a repeated `GroupMention{groupJID, groupSubject}`. This mentions a **group** (for example a subgroup in a community), not "everyone". **[verified]** [E2E.proto#L1629](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1629), [#L2713-L2716](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L2713-L2716)
- `ContextInfo.nonJIDMentions` (field 70) is a `uint32`. Its meaning is undocumented; it may count mentions that have no JID, such as an "@everyone"-style mention. **[unknown]** [E2E.proto#L1655](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1655)
- An explicit `EVERYONE` command type exists only in `WACommon.Command`, which is used by `WACommon.MessageText`. That type belongs to the Messenger/Instagram ("armadillo") protocol family, not to the E2E `Message` used for WhatsApp chats. **[verified]** [G/proto/waCommon/WACommon.proto#L17-L48](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waCommon/WACommon.proto#L17-L48)
- App-state mute settings have a `muteEveryoneMentionEndTimestamp`, which implies an everyone-mention feature exists in WhatsApp. How it is encoded on the E2E wire is **[unknown]**. [G/proto/waSyncAction/WAWebProtobufSyncAction.proto#L1166](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waSyncAction/WAWebProtobufSyncAction.proto#L1166)

### LID addressing

- Server constants: `s.whatsapp.net` (PN users), `lid` (`HiddenUserServer`), `g.us`, `broadcast`, `newsletter`, `bot`, plus `hosted` and `hosted.lid`. **[verified]** [G/types/jid.go#L23-L33](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/jid.go#L23-L33)
- Groups carry `GroupInfo.AddressingMode`. Each `GroupParticipant` has `JID` (the primary id, "always equals either the LID or phone number"), `PhoneNumber` and `LID`. **[verified]** [G/types/group.go#L38](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/group.go#L38), [#L103-L120](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/group.go#L103-L120)
- The account's own identities are `Store.ID` (`*types.JID`, the PN with device) and `Store.LID` (`types.JID`), read through `Device.GetJID()` and `Device.GetLID()`. **[verified]** [G/store/store.go#L228-L229](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/store.go#L228-L229), [#L258-L275](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/store.go#L258-L275)
- `Store.LIDs` (`LIDStore`) provides `GetPNForLID`, `GetLIDForPN`, `GetManyLIDsForPNs`, `PutLIDMapping` and `PutManyLIDMappings`. `Device.GetAltJID(ctx, jid)` switches on the server. **[verified]** [G/store/store.go#L187-L193](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/store.go#L187-L193), [#L316-L326](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/store.go#L316-L326)
- `GetUserInfo` returns `UserInfo.LID` for PN JIDs, so it can fill gaps in the store. **[verified]** [G/types/user.go#L31-L37](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/user.go#L31-L37), [G/user.go#L232](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/user.go#L232)
- In a LID-addressed group, `mentionedJID` entries are `<n>@lid`, and in a PN group they are `<n>@s.whatsapp.net`. **[inferred]** from the group addressing model; not shown in whatsmeow code. Whether clients ever mix the two forms in one message is **[unknown]**.
- A robust "mentions my account" check compares each `mentionedJID`, after `ParseJID` and `ToNonAD`, by `User` against **both** `GetJID().User` and `GetLID().User`. This mirrors how whatsmeow computes `IsFromMe`. **[inferred]**
  - `Store.LID` can be empty for accounts paired before LID rollout or before migration (`LIDMigrationTimestamp` exists). **[inferred]** [G/store/store.go#L236](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/store/store.go#L236)
- Mention text convention: the visible text contains `@<user part>`, with the JID listed in `mentionedJID`. Whether that user part is the phone number or the LID number in LID groups is **[unknown]** (community guides show PN examples only). Renderers should treat the JID list as authoritative and the text as display only. **[inferred]**

## 3. Replies (quoted messages)

- `ContextInfo` fields: `stanzaID` (1) is the parent message ID; `participant` (2) is the parent's sender JID string; `quotedMessage` (3) is a full `Message`; `remoteJID` (4) is the parent's chat. **[verified]** [E2E.proto#L1603-L1606](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1603-L1606)
  - `remoteJID` matters when it differs from the current chat, as in a private reply to a group message. **[inferred]** from the field name; WA semantics are **[unknown]**.
- `ContextInfo.quotedType` is `EXPLICIT=0` or `AUTO=1`. `questionReplyQuotedMessage` exists for Q&A-style messages. **[verified]** [E2E.proto#L1357-L1360](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1357-L1360), [#L1588-L1592](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1588-L1592)
- Because `quotedMessage` is a full `Message`, the schema allows text, captions, media fields (`mediaKey`, `directPath`, `JPEGThumbnail`) and its own nested `contextInfo` with mentions. **[verified]** (type only)
  - What official clients actually put in the quoted copy is **[unknown]**: whether they strip media keys, keep only the thumbnail, or drop nested `contextInfo`. Only live capture would tell. Treat the copy as an untrusted, possibly truncated snapshot and resolve the parent by `stanzaID` in the local store where possible.
- In LID groups, `participant` is presumably a `@lid` JID. **[inferred]**

## 4. Chat types

| Kind | How to tell | Mark |
| --- | --- | --- |
| Direct | `Chat.Server` is `s.whatsapp.net` or `lid` (`hosted`/`hosted.lid` are normalized on receive) | **[verified]** [G/message.go#L143-L184](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L143-L184) |
| Group | `Chat.Server == "g.us"`, `IsGroup=true` | **[verified]** [L98-L100](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L98-L100) |
| Announcement-only group | `GroupInfo.IsAnnounce` (only admins can send) | **[verified]** [G/types/group.go#L92-L96](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/group.go#L92-L96) |
| Community parent | `GroupInfo.IsParent` (`GroupParent`) | **[verified]** [G/types/group.go#L56-L59](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/group.go#L56-L59) |
| Community subgroup | `GroupInfo.LinkedParentJID` non-empty; `IsDefaultSubGroup` marks the default one | **[verified]** [L61-L67](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/group.go#L61-L67) |
| Community announcement group | whatsmeow's own test is `IsAnnounce && IsDefaultSubGroup` | **[verified]** [G/group.go#L660](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/group.go#L660) |
| Status | `Chat == status@broadcast` (`StatusBroadcastJID`); `IsGroup` is also true | **[verified]** [G/types/jid.go#L42](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/jid.go#L42) |
| Broadcast list | `Chat.Server=="broadcast"` and not status (`IsBroadcastList()`); `MessageSource.IsIncomingBroadcast()` | **[verified]** [G/types/jid.go#L122-L124](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/jid.go#L122-L124), [G/types/message.go#L43-L48](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/message.go#L43-L48) |
| Newsletter / channel | `Chat.Server=="newsletter"`; `NewsletterMeta` may be set | **[verified]** [G/message.go#L139-L142](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L139-L142) |

Group metadata comes from `GetGroupInfo`, `GetJoinedGroups`, `GetSubGroups(community)` and `GetLinkedGroupsParticipants`. **[verified]** [G/group.go#L538](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/group.go#L538), [#L583](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/group.go#L583), [#L626](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/group.go#L626)

## 5. Edits, revokes, reactions, ephemeral, view-once, polls

All of these arrive as `*events.Message`. There are no dedicated event types.

- **Edits**: the raw message is `editedMessage` (FutureProof) wrapping a `protocolMessage{type: MESSAGE_EDIT (14), key, editedMessage, timestampMS}`. After `UnwrapRaw`, `IsEdit=true` and `evt.Message.protocolMessage` holds the target `key.ID` and the new content. `Info.Edit` carries the stanza `edit` attribute (`"1"` = edit). **[verified]** [G/types/events/events.go#L417-L420](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/events/events.go#L417-L420), [E2E.proto#L1007](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1007), [#L1044](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1044), [G/types/message.go#L56-L65](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/message.go#L56-L65), [G/message.go#L238](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L238)
  - Newsletter edits are different: they are not wrapped, and the ID is the original's, with `NewsletterMeta.EditTS`. **[verified]** [G/types/events/events.go#L313-L319](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/events/events.go#L313-L319)
- **Revokes** (delete for everyone): `protocolMessage{type: REVOKE (0), key}`, where `key.ID` is the target. `Info.Edit` is `"7"` for a sender revoke and `"8"` for an admin revoke. **[verified]** [E2E.proto#L997](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L997), [G/types/message.go#L63-L64](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/types/message.go#L63-L64)
- **Reactions**: `reactionMessage{key, text, groupingKey, senderTimestampMS}`. Empty `text` means the reaction was removed (`RemoveReactionText = ""`). **[verified]** [E2E.proto#L2147-L2152](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L2147-L2152), [G/send.go#L1057](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L1057)
  - In **community announcement groups**, reactions and comments arrive encrypted as `encReactionMessage` / `encCommentMessage`. whatsmeow does **not** decrypt them automatically. The consumer calls `cli.DecryptReaction(ctx, evt)` or `cli.DecryptComment(ctx, evt)`. **[verified]** [G/msgsecret.go#L238-L290](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/msgsecret.go#L238-L290)
- **Polls**: creation arrives as `pollCreationMessage` (and V2 through V6), with `encKey`, `name`, `options[{optionName, optionHash}]` and `selectableOptionsCount`. Votes arrive as `pollUpdateMessage{pollCreationMessageKey, vote: PollEncValue}`. The consumer calls `cli.DecryptPollVote(ctx, evt)`, which yields the **SHA-256 hashes** of the selected options; mapping them back to names is up to the consumer (`HashPollOptions` exists). **[verified]** [E2E.proto#L2115-L2135](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L2115-L2135), [G/msgsecret.go#L292-L320](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/msgsecret.go#L292-L320), [#L367-L376](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/msgsecret.go#L367-L376)
  - Decryption needs the **original message's secret**, read from `Store.MsgSecrets` by (chat, original sender, original ID). Without it the call returns `ErrOriginalMessageSecretNotFound`. **[verified]** [G/msgsecret.go#L158-L175](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/msgsecret.go#L158-L175)
  - whatsmeow stores secrets automatically from `MessageContextInfo.messageSecret` on every received message, on messages it sends, and from history sync. **[verified]** [G/message.go#L986-L1007](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L986-L1007), [#L1010](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L1010), [G/send.go#L403-L410](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/send.go#L403-L410)
  - A poll created before the device was paired, and not covered by history sync, can't have its votes decrypted. **[inferred]**
- **Ephemeral (disappearing)**: arrives wrapped in `ephemeralMessage` and is unwrapped with `IsEphemeral=true`. The timer is in the inner `ContextInfo.expiration` (field 25). Chat timer changes are `protocolMessage` type `EPHEMERAL_SETTING (3)` with `ephemeralExpiration`. **[verified]** [E2E.proto#L1615](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1615), [#L998](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L998)
  - whatsmeow does not delete or expire anything locally; retention is the consumer's choice. **[inferred]** (no expiry logic found)
- **View-once**: unwrapped from `viewOnceMessage`, `viewOnceMessageV2` or `viewOnceMessageV2Extension` with `IsViewOnce=true`. Media messages also have a `viewOnce` bool (`ImageMessage` field 25). Whether a linked companion device receives the media keys for view-once media at all is **[unknown]**. [E2E.proto#L1339](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/proto/waE2E/WAWebProtobufsE2E.proto#L1339)
- **Protocol messages** (`processProtocolParts`) are handled internally only when `IsFromMe` (history sync notifications, app state keys, LID migration). They are still dispatched as `events.Message`, so consumers must filter them out. Edits skip that internal path because they are wrapped. **[verified]** [G/message.go#L906-L913](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L906-L913), [#L960-L983](https://github.com/tulir/whatsmeow/blob/ecc39170bc14/message.go#L960-L983)

## Implications for the spec (not decisions)

- A "mentions me" predicate has to match own PN **and** own LID by `User`, and handle an empty `Store.LID`.
- Mentions can sit on any sub-message with `contextInfo`, not only extended text. A plain `conversation` never mentions anyone.
- No field in E2E clearly means "@everyone". If the spec wants one, it needs live capture first (`nonJIDMentions` is the candidate).
- A DM chat id can arrive as either PN or LID. Persisted chat and sender keys need a normalization rule backed by `Store.LIDs`.
- The quoted copy's contents can't be assumed. Resolve parents by `stanzaID` from the daemon's own message store, and treat `quotedMessage` as a fallback preview.
- Edits, revokes, reactions and polls are all `events.Message` variants. The daemon needs its own classification layer, and for polls and encrypted reactions it needs the explicit `Decrypt*` calls plus message secrets kept in the store.
- Protocol and housekeeping messages arrive on the same event stream and must be filtered.
