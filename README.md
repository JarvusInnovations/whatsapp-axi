# whatsapp-axi

Agent-ergonomic CLI and local daemon for WhatsApp accounts.

**Status: works from a source checkout on Linux; not yet published to npm.** The daemon and the CLI
are built and in a pilot with one account. There is no release package yet, so install from source
(below). macOS service management comes later; `daemon run` works there in the foreground.

## What it is

- A small **daemon per WhatsApp account**, written in Go on
  [whatsmeow](https://github.com/tulir/whatsmeow), that holds the account's linked-device
  session and talks to WhatsApp.
- A **CLI** for agents and people, written in TypeScript on
  [axi-sdk-js](https://www.npmjs.com/package/axi-sdk-js), that talks only to the local daemon and
  prints token-efficient [TOON](https://toonformat.dev/) output following the AXI conventions,
  with `--json-out[=path]` for scripts: standard output stays TOON, and the daemon's complete
  response body is also written to an owner-only JSON file (a stream such as `events --follow`
  appends one JSON object per line).
- Configurable **scopes** that decide what the daemon keeps for an account (for example, only
  messages that mention the account in a group).

**What a scope can and cannot promise.** WhatsApp delivers every message of a group to every
member's devices, so the daemon receives and decrypts all of them, and a delivery receipt goes back
for each. A scope decides what happens next: the daemon never writes, logs or returns the text,
caption, quoted copy, media keys or file name of a message it discards. Two limits remain. The
WhatsApp library itself stores, in `session.db`, encryption state for each group member who has
sent a message, the mapping between a person's two ids, their display name and, for some messages,
a per-message secret keyed by chat, sender and message id; none of that is message content. And in
a `tagged` group the daemon holds recently discarded messages in memory (at most 500 per group, at
most 48 hours) so that a message someone replies to with a mention can be kept whole; they are
never written to disk, and are gone when the daemon stops. See [`specs/scopes.md`](specs/scopes.md).

How each of these works is decided in [`specs/`](specs/), not here.

## Install from source

You need Node 22 and Go (versions in `.tool-versions`), and Linux with systemd user services for
the `daemon install` service commands.

```sh
git clone https://github.com/JarvusInnovations/whatsapp-axi.git
cd whatsapp-axi
npm ci && npm run build      # the CLI, in dist/
npm run build:daemon         # the daemon, in daemon/bin/whatsapp-axid
npm link                     # puts whatsapp-axi on PATH (or run node dist/bin/whatsapp-axi.js)
```

The CLI finds the daemon binary built in its checkout. `daemon install` copies it to a stable path
and runs it as a systemd user service; it asks for lingering (`loginctl enable-linger <user>`) so
the service survives logout.

## Usage

The ids below are invented.

```sh
whatsapp-axi account add example                 # create the account's files (scope: tagged)
whatsapp-axi daemon install example              # install and start its daemon as a service
whatsapp-axi auth link --phone +15550100001      # prints a pairing code to type on the phone
whatsapp-axi operators add +15550100002          # whose direct messages are kept
whatsapp-axi                                     # home view: accounts, state, scope
```

Read and act:

```sh
whatsapp-axi events --after 0 --limit 20         # what was kept; the last line is the next --after
whatsapp-axi events --after 412 --follow         # stream new events
whatsapp-axi read 120363000000000001@g.us --mark-read
whatsapp-axi send 120363000000000001@g.us "On it" --reply 3EB0AAAA0000000001
whatsapp-axi send +15550100003 "Hello" --first-contact
```

Scopes decide what is kept: `tagged` (default; in groups, only what mentions or replies to the
account), `dm-only` or `full`, per account and per chat. Widening needs `--confirm`.

```sh
whatsapp-axi scope show
whatsapp-axi scope set --chat 120363000000000001@g.us full --confirm
whatsapp-axi scope set --chat 120363000000000002@g.us none
```

Every command prints [TOON](https://toonformat.dev/). For scripts, `--json-out[=path]` also writes
the daemon's complete response as JSON to an owner-only file and prints where:

```sh
whatsapp-axi events --after 0 --json-out=/tmp/events.json
jq '.events[]' /tmp/events.json
```

`whatsapp-axi --help` lists every command, and `<command> --help` shows its flags. For agents,
`whatsapp-axi setup hooks` installs a session-start hook, and
[`skills/whatsapp-axi/`](skills/whatsapp-axi/SKILL.md) is an installable skill.

## Unofficial client: read this first

whatsapp-axi uses WhatsApp's multi-device (linked device) protocol through whatsmeow, the same
mechanism WhatsApp Web uses. It is **not** Meta's WhatsApp Business Platform API, and it is not
endorsed by WhatsApp or Meta. WhatsApp can restrict or ban accounts that it considers automated
or abusive. Use a number you can afford to lose, and keep volumes human.

## Layout

| Path | What |
| --- | --- |
| `daemon/` | Go module for the daemon (`whatsapp-axid`) |
| `bin/`, `src/`, `test/` | the TypeScript CLI (`whatsapp-axi`) |
| `specs/` | what should be true |
| `plans/` | work in flight, per the plan protocol |
| `docs/research/` | research notes that feed the specs; not specs themselves |

## Development

Toolchain versions are pinned in `.tool-versions` (asdf). Build the daemon with `npm run build:daemon`,
not a plain `go build`: the script stamps the version from `package.json`, which the CLI and
`doctor` compare with their own. An unstamped build reports `0.0.0-dev` and `doctor` warns of a
version mismatch.

```sh
# daemon
cd daemon && go vet ./... && go test ./... && cd ..
npm run build:daemon   # daemon/bin/whatsapp-axid, stamped with the version in package.json

# CLI
npm ci && npm run lint && npm run typecheck && npm run build && npm test
```

## Licence

The source in this repository is MIT, see [LICENSE](LICENSE).

The daemon links [whatsmeow](https://github.com/tulir/whatsmeow) (MPL-2.0), which in turn links
`go.mau.fi/libsignal` (**GPL-3.0**). A compiled daemon binary is therefore a combined work that can
only be distributed under GPL-3.0 terms, with its complete source offered alongside. The CLI is a
separate program that talks to the daemon over a socket. See
[`docs/research/whatsmeow.md`](docs/research/whatsmeow.md#licence) for the details; this is not
legal advice.
