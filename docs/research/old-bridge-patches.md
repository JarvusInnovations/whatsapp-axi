# Lessons from the previous bridge's local patches

Research notes for the spec author; not a spec. Compiled 2026-11-14.

Before this project, the operator ran a patched copy of an unmaintained third-party WhatsApp
bridge: a Go process on whatsmeow that stored every message in SQLite and served a REST API, plus
an MCP server in front of it. That project is MIT-licensed. Ten commits were carried on top of it
locally. This note lists them **by behaviour**: what broke, what was changed, and what a fresh tool
must therefore do. No code was copied; nothing here identifies the deployment.

All entries are **[verified]** by reading the local commits and their messages, except where marked.

## The patches

| # | Kind | What broke | What the patch did |
| --- | --- | --- | --- |
| 1 | dependency | WhatsApp rejected the pinned whatsmeow with **"client outdated" (405)**; the bridge never got past login | upgraded whatsmeow; adapted to the newer API (a `context.Context` first argument on download, store open, device lookup, group info, contact lookup); pinned Go with asdf |
| 2 | dependency | same failure again months later | upgraded whatsmeow again |
| 3 | inbound content | **captions were dropped**: text typed under a photo, video or document never reached the store, so instructions sent with a screenshot were lost | treat the caption of image, video and document messages as the message text, for live messages and history alike |
| 4 | inbound context | **replies arrived as bare text**: the quoted message id and its sender were not recorded, so "you didn't update this yet" had no anchor | record the quoted message id (`contextInfo.stanzaId`) and quoted sender (`contextInfo.participant`) with each message |
| 5 | outbound record | the store held only inbound messages, so **a reply quoting one of the bridge's own messages pointed at an id that matched nothing** | after sending, write the sent message (id, chat, own sender, from-me flag, media type) to the store |
| 6 | reactions | there was no way to react; reacting to a group message needs the **exact participant JID** of the original sender (user and server), which the store had reduced to the bare user part | added a react endpoint; stored the full sender JID; for older rows guessed LID vs phone number by length |
| 7 | media download | the media server answered **403**: the download path had been derived from the message URL with its query string stripped, and the access token lives in that query string of the proto's `directPath` | store the message's `directPath` as received and pass it to whatsmeow for download |
| 8 | documents out | a PDF sent through the bridge **arrived as an extensionless blob that phones called corrupt**: non-image/audio/video files were sent as `application/octet-stream`, and the document message set a title but no file name | set the mimetype from the extension (PDF explicitly; octet-stream only as a last resort) and set `fileName` (and title) to the file's base name |
| 9 | ops | the REST port collided with another local service | moved the port |
| 10 | docs | local run instructions | documented the local service setup |

## Properties of the old bridge worth not repeating

Observed in the unpatched code, **[verified]** by reading it:

- **The REST API listened on all interfaces with no authentication** (`ListenAndServe(":<port>")`):
  any process on the machine, and anything that could reach the port over the network, could read
  every stored message and send as the account.
- **It stored every message of every chat**, including full history sync on link, regardless of
  whether anything would ever read it.
- It used the CGO SQLite driver (`mattn/go-sqlite3`) for both its message store and whatsmeow's
  session store.
- It linked by QR code only, printed to the terminal.
- It explicitly requested extra history from the phone after connecting.

## What a fresh tool must therefore do

Each item traces to a patch or property above. These are requirements the old tool taught, not
design decisions about *how*.

1. **Keep whatsmeow current, and make "client outdated" visible.** Two of ten patches were forced
   upgrades. The tool needs an upgrade path that is a routine release, and a status/doctor check
   that names 405 explicitly (#1, #2).
2. **A message's text includes its caption** for image, video and document messages (#3).
3. **Every inbound message carries its reply context**: the quoted message's id and sender, and
   ideally the quoted text, so a reply is never bare (#4).
4. **The tool's own sent messages are known by id**, so replies to them, and reactions on them,
   resolve (#5).
5. **Sender identity is kept as a full JID** (user and server, `@s.whatsapp.net` or `@lid`), never
   reduced to the digits, because reacting, replying and mentioning need the exact address (#6).
   Guessing LID vs phone number from length is a hack to avoid.
6. **Media downloads use the `directPath` exactly as received**, with its query string (#7).
7. **Outgoing documents carry a real mimetype and a file name** (#8).
8. **The control surface is not a TCP port.** Local-only, owner-only access (the old port was
   reachable by anything) (property list; also #9's collision).
9. **Store only what something will read** (property list).

## Not covered by the patches, but seen in practice

**[inferred]** from the patch messages: a bot built on the old bridge reacted to tags as an
instant acknowledgment (#6's motivation). That is a use case for the new tool's `react`, and for
keeping the original sender's full JID on every kept message.
