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

These live in `session.db`. None of them is message content. The README states this limit in plain
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
2. **It replies to a kept message in the same chat.** The message quotes a message id that is in
   `store.db` for that chat. That covers:
   - a reply to a message that mentioned the account
   - a reply to one of the account's own messages
   - a reply to a message kept by this same rule, so a thread that started with a mention or with
     the account's own message stays in view as people keep replying down it
3. **It is the account's own message.**

Everything else in the group is discarded.

### The parent of a mention

When a kept message is a reply, the daemon records the quoted parent **as context on that message**:
the parent's id, its sender, and its text or caption as carried inside the reply.

- The parent is not itself a kept message. A different reply to the same parent is **not** kept by
  rule 2 unless it also mentions the account.
- The parent's media is not available: only what the reply carried as text.
- If the parent is already a kept message, the context links to it instead of duplicating it.

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
  account's ids; reply chains several levels deep; a second reply to an un-kept parent staying
  discarded; an edit that adds a mention; a revoke of a kept message; `dm_from` both ways; each
  per-chat override.
- **Leaves no trace.** A test feeds the daemon a discarded message whose text, caption, quoted
  copy and file name each contain a unique marker, then reads every byte of every file under the
  account's config and state directories and every response the socket can produce, and fails if
  the marker appears anywhere. The same test asserts the chat's counter went up by one.
- **The live check.** The pilot procedure repeats the marker test against a real account, and its
  search includes `session.db`, since unit tests cannot exercise the library's own writes.
