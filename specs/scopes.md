# Scopes: what the daemon keeps

A scope decides, for each incoming message, whether the daemon **keeps** it or **discards** it.

- **Kept** means: written to `store.db`, given an event, readable through the CLI.
- **Discarded** means: dropped in memory. The daemon writes nothing about it except a bare count,
  and no command can show it.

## The honest limit

WhatsApp delivers every message in a group to every member's devices. A daemon whose account is in
a group **receives** all of that group's messages, decrypts them, and sends WhatsApp's automatic
delivery receipt for each. No setting changes that.

So the promise is about what happens next, and it is exactly this:

> For a discarded message, the daemon never writes its text, caption, quoted copy, media keys,
> thumbnail or file name to any file, never logs them, and never returns them from any request.

What the promise does **not** cover, because the underlying library writes it before the daemon
gets to decide:

- encryption state for each group member who has sent a message (unavoidable: it is needed to
  decrypt the next one)
- the mapping between a sender's two ids (see [identity.md](identity.md))
- the sender's display name
- for some messages, a per-message secret stored with the chat, sender and message id

These live in `session.db`. None of them is message content.

One more limit, stated for the same reason: in a `tagged` group the daemon holds recently discarded
messages **in memory** for a bounded time, so that the parent of a later mention can be kept whole
("The parent of a mention" below). They are never written, logged or returned unless a mention
pulls one in, at which point it is a kept message. The README states this limit in plain
words next to any description of scopes.

## Account scope

Each account has one scope in its settings.

| Scope | Direct chats | Groups |
| --- | --- | --- |
| `full` | kept, from anyone | kept, everything |
| `tagged` | kept per `dm_from` | the tagged rules below |
| `dm-only` | kept per `dm_from` | discarded |

- A new account's scope is `tagged`. `full` is for a person's own account and has to be set
  deliberately.
- `dm_from` is `operators` (the default) or `anyone`. With `operators`, a direct message from
  someone who is not an operator is discarded. `full` ignores `dm_from`.
- The account's **own messages** are always kept in every scope, whether sent through the daemon or
  from the phone or another linked device. They are the account's own words, and replies and
  reactions to them have to resolve.

## Per-chat override

A chat can override the account scope with `full`, `tagged` (groups only) or `none`.

- `none` discards everything in that chat except the account's own messages.
- An override is set by chat id through the CLI (`scope set`), and is listed by `scope show`.
- Changing a scope affects messages that arrive afterwards. It never recovers discarded messages,
  and it does not delete messages already kept (`forget` does that; see [cli.md](cli.md)).

## The tagged rules

In a group under `tagged`, an incoming message is kept if and only if at least one of these holds:

1. **It mentions the account.** The message's mention list contains the account (either of its two
   ids; see [identity.md](identity.md)). The mention list can be on a text message or on any media
   message with a caption; all are checked.
2. **It is the parent of a reply that mentions the account.** Someone replies to a message and
   mentions the account in the reply: the message they replied to is kept too, so a person can
   bring the account into any message by replying to it with a mention. See "The parent of a
   mention" below.
3. **It replies to a message kept by rule 1, 3 or 4, in the same chat.** That covers:
   - a reply to a message that mentioned the account
   - a reply to one of the account's own messages
   - a reply to a message kept by this same rule, so a thread that started with a mention or with
     the account's own message stays in view as people keep replying down it

   A reply to a parent kept by rule 2 is **not** covered. The account sees what descends from the
   message that mentioned it, never the other replies to that message's parent.
4. **It is the account's own message.**

Everything else in the group is discarded.

### The parent of a mention

When a reply that mentions the account arrives, its parent has usually already gone by and been
discarded. The daemon keeps the parent at that moment, from the best source it has:

1. **The recent-message buffer.** For each group under `tagged`, the daemon holds the most recent
   discarded messages **in memory only**: at most 500 messages and at most 48 hours, per group. If
   the parent is in the buffer it is kept whole, with its media descriptor, exactly as if it had
   been kept on arrival.
2. **The quoted copy.** Otherwise the daemon keeps what the reply carried: the parent's id, its
   sender, its text or caption, and its media descriptor when the copy includes one. The kept
   parent is marked `partial`, and its media may not be downloadable.

In both cases:

- The parent becomes an ordinary kept message, with `kept_by: parent` and its original time when
  known. Its event is emitted immediately before the event of the reply that brought it in.
- **It does not start a thread.** Other replies to the parent, before or after, are discarded
  unless they mention the account themselves. Only replies descending from the mentioning reply
  are kept by rule 3.
- If a parent kept by rule 2 is later edited to mention the account, it is from then on a message
  kept by rule 1, and replies to it are kept.
- A parent that is already kept is left as it is.
- Only a reply that itself mentions the account pulls its parent in. A reply kept by rule 3 does
  not.

The buffer is never written to disk, is not readable through any request, and is gone when the
daemon stops. A message that leaves the buffer without being pulled in is gone for good. Setting
`parent_buffer: false` turns the buffer off, leaving only the quoted copy.

### Who can trigger the account

Anyone in the group can mention the account or reply into a kept thread, and their message is kept.
Each kept message is marked with whether its sender is an operator. Deciding whether to act on a
message from a non-operator belongs to the consumer.

### What does not count as a mention

- A group-wide mention ("everyone") is not a mention of the account. The protocol field for it is
  not established; until it is, such a message is kept only if it also lists the account.
- A mention of a different group, or text that merely contains the account's name or number.

## Edits, deletions and reactions

| Arrives | Target is kept | Target is not kept |
| --- | --- | --- |
| Edit | The kept copy is updated and an `edit` event is emitted | If the edited content now satisfies a tagged rule (for example the edit adds a mention), it is kept as a message with the original id. Otherwise discarded |
| Delete for everyone | The kept copy's content is erased, the row is marked deleted, a `revoke` event is emitted | discarded |
| Reaction | Recorded on the kept message, a `reaction` event is emitted | discarded |

An edit that removes the mention from a kept message does not un-keep it.

## Media

For a kept message with an image, video, audio, document or sticker, the daemon keeps a
**descriptor**: type, MIME type, file name, size, caption, and the key material needed to fetch
the file later. It does not download the file.

- The file is fetched only when asked (`download`, [sending.md](sending.md)), and is then written
  under the account's `media/` directory.
- The key material is never returned by any request or printed by the CLI.
- For a discarded message, nothing about its media is kept.
- View-once media is recorded as a descriptor marked view-once and is never downloadable.

## Chat types

| Chat type | Handling |
| --- | --- |
| Direct chat | per the account scope |
| Group, including a community's subgroups | per the account scope and any override |
| Community announcement group | treated as a group; encrypted reactions and comments in it are discarded |
| Status updates (stories), broadcast lists, channels (newsletters) | always discarded, in every scope |

## History

When an account is linked, the phone offers its message history. The daemon never downloads or
stores it, in any scope. The first part of that history can arrive inline with the notification;
the daemon drops it in memory.

A `full` account therefore starts empty on the day it is linked. Importing history is a possible
later feature and would need its own spec.

## Membership is not content

Which groups the account belongs to, their names and who is in them are facts about the account,
not messages. They are available in every scope, for a group with nothing kept as much as any
other (`groups` and `chat view`, [cli.md](cli.md)): an operator has to be able to see a group to
set its scope, and a consumer has to see who can read a group before posting in it. The daemon
asks WhatsApp for them when asked and does not store member lists.

## Counters

For each chat, the daemon keeps one number: how many messages it has discarded there. The counter
has no sender, time, id or content, and it exists so an operator can see that the filter is working.
Messages of unsupported chat types share one counter for the account.

## Library settings the guarantee depends on

- The library's decrypted-message buffer stays off.
- History download is set to manual, and the daemon never performs it.
- The library's own logging runs at warning level or quieter, because its debug logs include
  message ids and senders.
- Core dumps are disabled for the daemon process.

## Tests

The scope filter is a pure function over an incoming event, the account's ids, the settings and a
lookup of kept message ids. It is tested without any WhatsApp connection.

- **Every rule above has a test**, including: mention on a caption; mention by either of the
  account's ids; the parent of a mentioning reply kept whole from the buffer and kept `partial`
  from the quoted copy when the buffer does not have it; the parent's event preceding the reply's;
  a non-mentioning reply to a discarded parent staying discarded and not pulling the parent in;
  a sibling reply to a parent kept by rule 2 staying discarded, before and after the mention;
  reply chains several levels deep under the mentioning reply; an edit that adds a mention; a revoke of a kept message; `dm_from` both ways; each
  per-chat override.
- **Leaves no trace.** A test feeds the daemon a discarded message whose text, caption, quoted
  copy and file name each contain a unique marker, then reads every byte of every file under the
  account's config and state directories and every response the socket can produce, and fails if
  the marker appears anywhere. The same test asserts the chat's counter went up by one. It runs
  with the recent-message buffer on, and again after the buffer's limits have pushed the message
  out.
- **The live check.** The pilot procedure repeats the marker test against a real account, and its
  search includes `session.db`, since unit tests cannot exercise the library's own writes.

## Principles

**Inherited** ([principles.md](principles.md)):

- *The daemon decides what is kept*.
- *Say exactly what is promised*: the discard guarantee and what it does not cover.
- *Modest by default, loosened on purpose*: `tagged` by default; `full` takes `--confirm`.

**Local:** none.
