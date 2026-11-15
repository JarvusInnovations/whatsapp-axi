# Research notes

Input for the spec author, not specs. Each claim is marked **[verified]** (source or doc read and
linked), **[inferred]** or **[unknown]**. whatsmeow claims are against commit `ecc39170bc14`, the
version pinned in `daemon/go.mod`.

| Note | Covers |
| --- | --- |
| [whatsmeow.md](whatsmeow.md) | licence (incl. the GPL-3.0 libsignal dependency), linking by QR and pairing code, session store tables, reconnects, "client outdated", logout, receipts and presence |
| [events-and-mentions.md](events-and-mentions.md) | the incoming message event, mentions under PN and LID addressing, reply context, chat types, edits/revokes/reactions/ephemeral/view-once |
| [discard-before-store.md](discard-before-store.md) | what whatsmeow writes to disk before the application sees a message; history and app-state sync; whether "kept nowhere" is achievable |
| [sending.md](sending.md) | text, replies, reactions, edits, files, outgoing mentions, presence, ban considerations |
| [old-bridge-patches.md](old-bridge-patches.md) | lessons from the previous bridge's local patches, by behaviour |
| [distribution.md](distribution.md) | shipping a Go binary through npm, release automation, CGO and SQLite driver choice, macOS signing |
| [daemon-and-socket.md](daemon-and-socket.md) | options for socket location and permissions, systemd and launchd, protocol framing, daemon-down behaviour |
| [open-questions.md](open-questions.md) | the questions the spec must answer, with options and what the research suggests |
