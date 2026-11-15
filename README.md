# whatsapp-axi

Agent-ergonomic CLI and local daemon for WhatsApp accounts.

**Status: early. The specs are written and the build is starting; nothing here is usable yet.** The repository
currently holds the specs, the plans, a build skeleton for both halves and the research notes behind the specs.

## What it will be

- A small **daemon per WhatsApp account**, written in Go on
  [whatsmeow](https://github.com/tulir/whatsmeow), that holds the account's linked-device
  session and talks to WhatsApp.
- A **CLI** for agents and people, written in TypeScript on
  [axi-sdk-js](https://www.npmjs.com/package/axi-sdk-js), that talks only to the local daemon and
  prints token-efficient [TOON](https://toonformat.dev/) output following the AXI conventions.
- Configurable **scopes** that decide what the daemon keeps for an account (for example, only
  messages that mention the account in a group).

How each of these works is decided in [`specs/`](specs/), not here.

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

Toolchain versions are pinned in `.tool-versions` (asdf).

```sh
# daemon
cd daemon && go vet ./... && go test ./... && go build -o bin/whatsapp-axid ./cmd/whatsapp-axid

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
