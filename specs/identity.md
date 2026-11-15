# Identity: accounts, users, chats and messages

WhatsApp addresses a person in two ways, and the same chat can arrive under either. This spec
fixes how whatsapp-axi names things so that an id means one thing everywhere.

All ids in specs, tests and docs are invented.

## Two ids per person

| Form | Looks like | Notes |
| --- | --- | --- |
| Phone-number id (PN) | `15550100001@s.whatsapp.net` | Contains the phone number |
| Hidden id (LID) | `100000000000001@lid` | Does not reveal the phone number. Newer groups address members this way |

- A message's sender can arrive in either form, sometimes with the other form alongside.
- A direct chat can arrive keyed by either form.
- When sending to a phone-number id, the library sends to the hidden id instead.
- The library keeps a map between the two forms and fills it as it learns pairs.

## User ids

A **user id** in whatsapp-axi is the hidden id when it is known, otherwise the phone-number id.
Device suffixes are always stripped.

Every user in an event or a response is an object, never a bare string:

| Field | Meaning |
| --- | --- |
| `id` | the user id as defined above |
| `lid` | the hidden id, when known |
| `pn` | the phone number in E.164 form (`+15550100001`), when known |
| `name` | display name: the address-book name if the account has one, else the name the sender set for themselves, else empty |
| `me` | true when this is the account itself |
| `operator` | true when this user is one of the account's operators |

Sender ids are stored in full, with their server part. Nothing is ever inferred from the length or
shape of the digits.

## The account's own ids

The account has a phone-number id and, usually, a hidden id. Wherever the daemon asks "is this
me?" (mentions, quoted senders, own messages) it compares against **both**, and works when the
hidden id is not yet known.

## Chat ids

| Chat | Chat id |
| --- | --- |
| Group | the group id, `120363000000000001@g.us` |
| Direct chat | the other person's user id |

Because a direct chat's id follows the user id rule, it can be learned in the phone-number form
first and the hidden form later. The daemon handles that as follows:

1. **Resolve first.** Before recording the first message of a direct chat that arrived by phone-
   number id, the daemon asks the library for that user's hidden id. If it gets one, the chat is
   keyed by it from the start.
2. **Rekey if needed.** If a chat was keyed by phone-number id and the hidden id becomes known
   later, the daemon rekeys the chat and its messages in one transaction and emits a `chat_rekeyed`
   event carrying the old and new ids.
3. **Accept either.** Every command and request that takes a chat accepts the hidden id, the
   phone-number id, a phone number (`+15550100001`), or a group id. Old ids keep resolving after a
   rekey.

Settings that name a chat (per-chat overrides) are rewritten by the daemon on a rekey.

## Message ids

- A message is identified by its **chat id and its WhatsApp message id together**. The message id
  alone is not guaranteed unique across chats.
- In events and responses a message carries `id` (WhatsApp's id, unchanged) and its chat.
- A **message ref** is the form commands take: `<message id>` alone when it is unambiguous in
  `store.db`, or `<chat id>/<message id>`. An ambiguous bare id is an error that lists the
  candidates.
- For a message the account sends, the daemon chooses the id before sending and records it first,
  so a reply to the account's message always resolves.

## Operators

Operators are the people an account answers to. They are listed in settings.

- An operator is entered as a phone number in E.164 form, or as a hidden id.
- A sender is an operator when their user id, or the phone number mapped to it, matches the list.
- **Unknown fails closed.** If a sender arrives by hidden id and the daemon cannot map it to a
  phone number, the sender is not an operator. The daemon asks the library to resolve the mapping
  so that later messages match, but it never guesses.
- The operator list affects two things only: which direct messages are kept under
  `dm_from: operators`, and the `operator` mark on users. Any further meaning is the consumer's.

## Contacts

A user is a **contact** when the account's phone has them in its address book. The daemon learns
this from the library's contact sync and reports it as a `contact` mark in `chat view`. It is
informational: nothing in whatsapp-axi keeps or discards by it, except the first-contact send
limit in [sending.md](sending.md).

## Tests

- "Is this me?" by phone-number id, by hidden id, and with the hidden id unknown.
- Operator matching by phone number through the map, by hidden id directly, and the fail-closed
  case where the map has no entry.
- A direct chat first seen by phone-number id and later by hidden id: one chat, one history, one
  `chat_rekeyed` event, and the old id still resolves.
- A message ref that is ambiguous across two chats returns the candidates and changes nothing.

## Principles

**Inherited** ([principles.md](principles.md)):

- *A transport, not an agent*: the tool marks operators and contacts; deciding what to do with
  them is the consumer's.
- *Unknown is said as unknown*: an ambiguous ref is an error with its candidates, never a guess.

**Local:** none.
