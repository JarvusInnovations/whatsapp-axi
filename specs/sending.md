# Sending, reacting and media

Everything an account sends goes through its daemon, one message at a time.

## Sending text

- A send names a chat and a text. The chat can be given in any form from
  [identity.md](identity.md).
- The daemon chooses the message id, or takes the caller's `id` (16 to 48 characters of 0-9 and
  A-F, as WhatsApp ids are), records the message in `store.db` as pending, sends it, then
  marks it sent or failed. The account's own message is therefore known by id before anyone can
  reply to it.
- The response carries the message id, the chat id as WhatsApp addressed it, and the server time.
- Sends for one account run strictly one after another.
- A failed send is reported, never retried by the daemon.
- **A send is finished by the daemon, whatever happens to the request.** Once a send has
  passed the limits and been recorded as pending, the daemon carries it through even if the
  client disconnects or gives up waiting. The CLI waits for a send, a file or a reaction for as
  long as the daemon's own send timeout allows, with no shorter limit of its own.
- **An unknown outcome is said as unknown.** When the client stops waiting before the daemon
  answers, or the daemon cannot tell whether WhatsApp accepted the message, the error is
  `OUTCOME_UNKNOWN`, never a plain failure, and its help says to check `read <chat>` before
  sending again: a retry may duplicate a message that went out. The message's row stays
  `pending` until the daemon learns the outcome.
- **A send is replayable by its id** ([conventions.md](conventions.md), "Send ids"). A send whose
  `id` is already recorded as sent for that chat answers the recorded result with
  `already_sent: true` and sends nothing, before any limit or connection check. One still
  pending is `OUTCOME_UNKNOWN`; one that failed is removed and sent again under the same id. An
  id used by another message is `VALIDATION_ERROR`. `OUTCOME_UNKNOWN` names the id it was sent
  under.
- **Accepted means sent.** If WhatsApp accepted the message and only the daemon's own
  bookkeeping failed afterwards, the answer is success with a `warning`, never an error.

### Replies

A send with `reply_to` quotes a kept message in the same chat.

- The parent must be in `store.db`; otherwise the send fails with `NOT_FOUND`.
- The daemon builds the quote from the kept copy: the parent's id, its sender in the exact form it
  arrived in, and its text or caption. It never includes the parent's media keys.

### Mentions

A send can mention users. The caller passes user ids; the daemon puts them in the message's mention
list and makes sure each appears in the text in the form WhatsApp expects. In a group, the id used
is the member's primary id for that group. A mention of someone who is not in the chat is a
`VALIDATION_ERROR`.

## Reactions

`react` puts an emoji on a kept message, or removes the account's reaction when the emoji is empty.
The daemon addresses the reaction with the original sender's full id as stored.

## Sending files

- A file is sent as an image, video, audio or document. The daemon picks by MIME type; `as` forces
  one.
- **MIME type** comes from the file's content and extension. A generic binary type is used only
  when nothing better can be determined.
- **File name.** A document is sent with its base name as the file name recipients see.
- A caption is optional. A reply and mentions work as for text.
- Images are sent with a small generated preview. Other types are sent without one.
- The daemon enforces a size limit from settings (`send.max_file_mb`, default 64).

## Downloading media

`download` fetches the file of a kept message that has a media descriptor.

- The daemon uses the stored download path exactly as it arrived, and the stored keys.
- The file is written to the account's `media/` directory under a name built from the chat and
  message id, with an extension from its MIME type. The original file name is reported but is not
  used as the path.
- A second download of the same message returns the existing file.
- View-once media, and media whose server copy has expired, fail with `NOT_DOWNLOADABLE`.

## Send limits

WhatsApp restricts accounts that message strangers, send the same text widely, or send in volume.
These limits make the modest behaviour the default. They are enforced in the daemon, so every
caller is covered.

| Limit | Setting | Default | Failure |
| --- | --- | --- | --- |
| **First contact.** A send to a chat with no kept activity (nothing received and nothing sent) is refused unless the request sets `first_contact` | `send.first_contact` (`refuse` or `allow`) | `refuse` | `FIRST_CONTACT` |
| **Rate.** At most this many sends per rolling hour, and per rolling minute | `send.per_hour`, `send.per_minute` | 60, 10 | `RATE_LIMITED` |
| **Same text.** The same text may go to at most this many different chats within a rolling ten minutes | `send.same_text_chats` | 3 | `DUPLICATE_TEXT` |

- Reactions count toward the rate limits. Downloads do not.
- "Same text" compares text after trimming whitespace. The daemon remembers a hash of recent
  texts in memory only.
- A request that fails a limit sends nothing and records nothing.
- In `suspended`, `logged_out` and `outdated`, every send fails with `NOT_CONNECTED`.
- There is no command to create a group, add members to one, send to a broadcast list or post a
  status. Those are the other behaviours WhatsApp names when it restricts accounts, and they are
  out of scope.

## Tests

Against the fake client:

- A sent message is in `store.db` with its id before the client's send returns, and a reply
  arriving for it is kept by the reply rule.
- A failed send is marked failed and is not retried.
- Two concurrent sends reach the client one at a time.
- A reply carries the parent's id, sender form and text, and no key material; replying to an
  unknown parent fails with `NOT_FOUND`.
- A PDF goes out as a document with its MIME type and file name; an image goes out with a preview.
- Download uses the stored path unchanged, is idempotent, and refuses view-once media.
- A replayed id answers `already_sent` and the client sends once; a pending one stays unknown; a
  failed one can be sent again; a malformed id is refused.
- Each limit: the request at the limit succeeds, the next fails with its code, and nothing is sent
  or recorded for the failure. `FIRST_CONTACT` passes with the flag.

## Principles

**Inherited** ([principles.md](principles.md)):

- *Unknown is said as unknown*: a send that may have gone out is `OUTCOME_UNKNOWN`, and accepted
  means sent.
- *Modest by default, loosened on purpose*: the send limits and the first-contact refusal guard
  the ungated sends; loosening them takes `confirm`.
- *A transport, not an agent*: the daemon sends what it is asked and decides nothing about what
  may be said.

**Local:** none.
