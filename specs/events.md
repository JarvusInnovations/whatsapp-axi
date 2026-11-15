# Events

An event is the daemon telling a consumer that something was kept or that the account's state
changed. Events are how a bot learns it has something to look at.

## The sequence

- Every event has a `seq`: a whole number that only goes up, per account, starting at 1.
- Events are rows in `store.db`. A consumer reads them through the socket by asking for everything
  after a `seq` it remembers. The daemon keeps no per-consumer cursor.
- `seq` values are never reused, including after `forget` or retention removes rows.

## Kinds

| `kind` | Emitted when | Carries |
| --- | --- | --- |
| `message` | a message is kept, including the account's own | `chat`, `message` |
| `edit` | a kept message is edited | `chat`, `message` (new content), `edited: true` |
| `revoke` | a kept message is deleted for everyone | `chat`, `message` (`id` and `from` only) |
| `reaction` | someone reacts to a kept message, or removes a reaction | `chat`, `target` (message id), `from`, `emoji` (empty when removed) |
| `state` | the daemon's state changes (see [daemon.md](daemon.md)) | `state`, `reason` |
| `chat_rekeyed` | a direct chat's id changes form (see [identity.md](identity.md)) | `old`, `new` |

## The record

Every event has `seq`, `t` (RFC 3339, UTC), `kind` and `account`. A `message` event looks like
this (shown as JSON; the CLI prints TOON):

```json
{
  "seq": 412,
  "t": "2030-01-05T14:03:11Z",
  "kind": "message",
  "account": "example",
  "chat": { "id": "120363000000000001@g.us", "type": "group", "name": "Example group" },
  "message": {
    "id": "3EB0AAAA0000000001",
    "from": { "id": "100000000000001@lid", "pn": "+15550100001", "name": "Sam", "me": false, "operator": true },
    "text": "@Example can you check this?",
    "kept_by": "mention",
    "mentions_me": true,
    "reply_to": {
      "id": "3EB0AAAA0000000000",
      "from": { "id": "100000000000002@lid", "name": "Alex", "me": false, "operator": false },
      "text": "the report is attached",
      "kept": false
    },
    "media": { "type": "document", "mime": "application/pdf", "name": "report.pdf", "size": 48213 }
  }
}
```

### Message fields

| Field | Meaning |
| --- | --- |
| `id` | WhatsApp's message id |
| `from` | the sender, as a user object ([identity.md](identity.md)) |
| `text` | the message text. For media, the caption. Empty when there is none |
| `kept_by` | why it was kept: `mention`, `reply`, `own`, `dm` or `full` |
| `mentions_me` | whether the message mentions the account |
| `mentions` | other mentioned users, as user objects. Omitted when empty |
| `reply_to` | present when the message is a reply: the parent's `id`, `from`, its `text` as carried in the reply, and `kept` (whether the parent is itself a kept message) |
| `media` | present when the message has media: `type`, `mime`, `name`, `size`, and `view_once` when true. Never any key material |
| `ephemeral` | present with the timer in seconds when the chat has disappearing messages on |

`kept_by` reports the first rule that matched, in the order mention, reply, own for groups.

## Reading events

Through the socket (and so through `whatsapp-axi events`):

- **After a point:** everything with `seq` greater than a given value, oldest first, up to a limit.
- **Follow:** the same, then stay connected and receive each new event as it is written.
- **Filters:** by chat and by kind.

A consumer that remembers the last `seq` it handled and asks for what comes after it never misses
an event and never sees one twice, across daemon restarts.

## The wake file

An account's settings can name a **wake file**. When set, the daemon appends one line to it for
each `message`, `edit`, `revoke` and `reaction` event, after the event is committed:

```json
{"account":"example","seq":412,"kind":"message"}
```

- The line carries no content, sender or chat. It says only that there is something to read.
- The daemon creates the file with mode 0600 if it is missing, and only appends.
- Truncating or rotating the file is the consumer's job.
- The account's own messages do not write a wake line.

## Retention

- Settings carry `retain_days`. Kept messages and their events older than that are removed by the
  daemon once a day. The default is 90 for `tagged` and `dm-only` accounts and unlimited (`0`) for
  `full` accounts.
- Removal deletes the content. Ids of removed messages are not kept either, so a late reply to a
  removed message is no longer matched by the reply rule.
- Fetched media files follow the same rule.

## Tests

- `seq` is strictly increasing and survives a restart.
- Reading after a `seq` returns exactly the later events, in order, with the limit honoured.
- Follow delivers an event written after the request began, without a duplicate.
- A wake line is appended once per qualifying event, after commit, with no content; none is
  written for the account's own messages or for `state` events.
- No event of any kind contains media key material.
- Retention removes content and ids past the cutoff and leaves `seq` monotonic.
