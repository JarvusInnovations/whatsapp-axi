# whatsapp-axi

Agent-ergonomic CLI and local daemon for WhatsApp accounts.

**Status: early. The specs are being written; nothing here is usable yet.** The repository
currently holds a build skeleton for both halves and research notes for the spec author.

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
| `specs/` | what should be true (in progress) |
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

MIT, see [LICENSE](LICENSE). The daemon links whatsmeow, which is licensed under the
[Mozilla Public License 2.0](https://github.com/tulir/whatsmeow/blob/main/LICENSE). MPL-2.0 is a
file-level copyleft: whatsmeow's own files stay under MPL-2.0 (including any changes made to them),
while this project's files can be MIT. A binary that includes whatsmeow must tell recipients where
to get whatsmeow's source. See `docs/research/whatsmeow.md` for the details.
