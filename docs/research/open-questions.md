# Open questions for the spec

Research notes for the spec author; not a spec. Compiled 2026-11-14 from the other notes in this
directory. Each question lists the options and what the research suggests. "Suggests" is a reading
of the evidence, not a decision.

## Licence and distribution

**Q1. How is the GPL-3.0 dependency handled?** whatsmeow links `go.mau.fi/libsignal`, which is
GPL-3.0 (`whatsmeow.md` § Licence). Any distributed daemon binary is a GPL-3.0 combined work.

- (a) Keep source MIT; ship daemon binaries under GPL-3.0 terms with a source offer and a notices
  file; keep the CLI MIT.
- (b) Relicense the whole repository GPL-3.0.
- (c) Ship no binaries; users build the daemon from source.

Suggests (a), stated in the README and spec before any binary ships, with a licence check in CI
(for example `go-licenses`) so a new dependency cannot change this silently.

**Q2. Which SQLite driver?** CGO `mattn/go-sqlite3` vs pure-Go `modernc.org/sqlite` (both accepted
by whatsmeow's dialect check). See `distribution.md`.

- Pure Go makes the per-platform npm binaries a plain `GOOS/GOARCH` cross-compile.
- CGO needs a C toolchain per target (or native runners per platform).

Suggests pure Go. `distribution.md` reports whatsmeow's `sqlstore` opening and upgrading a database
with `CGO_ENABLED=0` on both `modernc.org/sqlite` and `ncruces/go-sqlite3`, cross-compiled to
linux/arm64 and darwin from one Linux host. Behaviour under real message load is untested. The spec
should fix one exact DSN, because `Upgrade` refuses to run without the foreign-key pragma.

**Q3. Platforms for prebuilt daemons**, and whether the npm package ships them as optional
dependencies (`distribution.md`), or whether the first releases require a local Go build.

## What the daemon keeps

**Q4. What exactly is promised for discarded group messages?** (`discard-before-store.md`)

- Body/caption never on disk: achievable with defaults plus `ManualHistorySyncDownload`.
- Message id and sender name never on disk: achievable only by wrapping `Store.MsgSecrets` and
  `Store.Contacts` (drop writes), at the cost of poll-vote/encrypted-reaction decryption and
  stored push names.
- Sender identity (encryption state per group member) on disk: unavoidable.

Suggests the spec states the guarantee at the level the library allows, names the client settings
and wrappers, and requires a test that greps every file the daemon writes **including whatsmeow's
database** for a canary.

**Q5. Are replies to the account's own messages kept in a `tagged` group?** A reply quoting the
account carries `contextInfo.participant` equal to the account (PN or LID), so this is detectable
without any stored state (`events-and-mentions.md`). Keeping them lets a conversation with the bot
continue without re-tagging; it also means anyone in the group can reach the bot by replying.

**Q6. Does a reply to a kept reply chain onward?** If "reply to a kept message" means any kept
message, a whole thread becomes kept; if it means only messages that mention the account, it stays
narrow. The literal rule ("a reply to a message the account was mentioned in") is the narrow one.

**Q7. Who may trigger the account in a group?** Anyone who mentions it, or only configured
operators? Mentions from non-operators could be counted and discarded instead of kept.

**Q8. Group-wide mentions.** There is no clear "@everyone" field in the protocol
(`events-and-mentions.md`). Treat `groupMentions` / `nonJIDMentions` as a mention of the account,
or not? This needs a captured live message before it can be specced.

**Q9. Media in `tagged` scope.** For a kept message with an image or document, keep only the
descriptor (type, mimetype, file name, size, caption) and download on request, or download eagerly?
Downloading later needs the media key and `directPath` kept (`old-bridge-patches.md` #7), which is
key material for that file. For a discarded message nothing is kept either way.

**Q10. Own messages.** Messages the account sends (through the daemon or from the phone) are the
account's own words. Are they always kept (needed to resolve replies to them and to react), or
only when sent through the daemon?

**Q11. Edits and deletions of kept messages.** Edits and revokes arrive as ordinary message events
with a protocol message inside (`events-and-mentions.md`). Should an edit of a kept message update
the kept copy (and be an event), and a revoke remove it? Should an edit that **adds** a mention to
a previously discarded message cause it to be kept?

**Q12. Reactions.** Keep reactions on the account's own messages (the Slack counterpart keeps
`reaction_added` on the bot's messages)? Encrypted reactions in community announcement groups need
stored message secrets, which conflicts with Q4's wrapper.

**Q13. Chat types.** What happens in communities, announcement groups, broadcast lists,
`status@broadcast` (stories) and newsletters? Simplest reading: only direct chats and ordinary
groups are supported; everything else is discarded and counted.

**Q14. History sync on link.** Discard all history for non-`full` accounts (the inline initial
payload still arrives in memory)? For a `full` account, download and store it? Send or suppress the
history-sync receipt to the phone (`DisableManualHistorySyncReceipt`; the phone's reaction to a
missing receipt is unknown)?

## Identity

**Q15. One chat, two ids.** A direct chat can arrive as `@s.whatsapp.net` or `@lid`, and sending to
a phone number is rewritten to the LID (`sending.md`). What is the canonical chat id in events,
operators lists and per-chat overrides, and how are the two forms reconciled (`Store.LIDs`)?

**Q16. Operators by phone number or LID.** Operators are naturally entered as phone numbers, but a
DM may arrive from a LID. Match through the LID map, and what if no mapping is known yet?

**Q17. "Is this person a contact?"** The only source is app-state contact sync (the phone's address
book), stored by whatsmeow in `whatsmeow_contacts`. Is that sufficient for the kit's
`operator-dm`/group classification, or should the daemon's own operators list be the only
authority?

## Behaviour of a connected account

**Q18. Presence and receipts.** Without `SendPresence(available)` the account shows "-" as its name
to some users and sends inactive delivery receipts; with it, the account appears online. Send
presence once per connect, never, or make it a setting? Never send read receipts unless asked
(`MarkRead` is never automatic)?

**Q19. Outbound guardrails.** WhatsApp's temp-ban reasons name messaging non-contacts, identical
fan-out and group creation with non-contacts (`sending.md` §7). Should `send` refuse a chat with no
prior kept activity unless forced? Rate-limit per account? Refuse identical text to many chats?

**Q20. Phone check-in.** whatsmeow has no "phone last seen". Is an approximation (last message or
app-state patch from the account's own device 0) good enough for doctor, and how is it labelled?

**Q21. Logged out, banned, client outdated.** Logout deletes the session (`whatsmeow.md`). Should
the daemon exit (so the service manager shows failure), or stay up reporting the state over the
socket so `doctor` can explain it? Same for 405 and temporary bans.

## Daemon, socket and CLI

**Q22. Socket location and access control.** `daemon-and-socket.md` finds that current macOS (XNU)
does check write permission on the socket file at connect, contrary to the older belief. A 0700
directory plus a peer-uid check (`SO_PEERCRED` on Linux, `LOCAL_PEERCRED` on macOS, both reachable
from pure Go) is still the robust pair. macOS has no `XDG_RUNTIME_DIR`, and its socket path limit
is 104 bytes, which a long `$TMPDIR` plus an account name can exceed. Where does the socket live on
each OS, and is the peer check required?

**Q22b. Lingering and headless hosts.** Without `loginctl enable-linger`, a systemd user service
dies when the last login session ends. A macOS LaunchAgent in `gui/<uid>` runs only after a GUI
login. Should `daemon install` enable lingering, refuse without it, or only warn? Is a headless Mac
in scope?

**Q23. Protocol framing.** Line-delimited JSON, JSON-RPC 2.0, HTTP over the Unix socket, or gRPC
(`daemon-and-socket.md`). Streaming is needed for `events --follow` and for linking (the pairing
code first, then success up to ~160 s later).

**Q24. When the daemon is down.** Fail with a structured error and the fix command; or let
read-only commands (`events`, `read`) read the files directly; or socket-activate the daemon.
Socket activation alone cannot work: the WhatsApp connection must stay up to receive messages, so
the daemon has to run all the time anyway (`daemon-and-socket.md`).

**Q24b. npm publishing.** Per-platform optional dependencies (the esbuild/biome/lefthook pattern)
work with `--ignore-scripts`; GoReleaser's npm support is Pro-only and relies on a postinstall
download. Trusted publishing likely needs a manual first publish of every package (main plus one
per platform). How many platforms, and who does the first publishes?

**Q25. Who owns settings?** The CLI writes the settings file and tells the daemon to reload, or
the daemon owns it and the CLI changes it over the socket. One writer avoids races.

**Q26. Linking flow.** Linking needs the session-owning process connected for up to ~160 s and
waiting for the first QR event before a pairing code can be requested (`whatsmeow.md`). So: the
daemon must already run (installed but unlinked), or the CLI runs a temporary foreground daemon
for linking. Also: use `PrePairCallback` to refuse pairing with an unexpected phone number?

**Q27. Upgrades.** "Client outdated" is fixed only by a new daemon build. How does an operator learn
an upgrade is needed (doctor names 405), and how does `npm update -g` replace a running daemon
binary (restart the unit)?
