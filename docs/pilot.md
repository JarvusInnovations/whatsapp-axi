# Pilot: one account on one Linux host

The first run against real WhatsApp, from a source checkout. It follows
[`plans/pilot.md`](../plans/pilot.md). Use a WhatsApp account you can afford to lose, and keep the
volume small. Every id below is invented; `example` is the account's local name.

## 1. Build

```sh
npm ci && npm run build:daemon && npm run build
alias whatsapp-axi="node $PWD/dist/bin/whatsapp-axi.js"
```

`build:daemon` stamps the daemon with the version in `package.json`; a plain `go build` reports
`0.0.0-dev`, and `doctor` then warns that the versions disagree.

## 2. Create the account and run it as a service

```sh
whatsapp-axi account add example
whatsapp-axi daemon install example      # refuses if lingering is off, and prints the fix
whatsapp-axi doctor
```

`doctor` should show the service running and the account `unlinked`. Nothing has connected to
WhatsApp yet.

## 3. Link

Have the phone that holds the account in hand, unlocked, with WhatsApp open at
**Linked devices → Link a device → Link with phone number instead**. The code is only good for a
little under three minutes.

```sh
whatsapp-axi auth link --phone +15550100001
```

Type the eight-character code into the phone. The command ends with the result; `doctor` should
now show `connected`. If the phone holds a different number than the one given, the link is
refused.

## 4. Operators

```sh
whatsapp-axi operators add +15550100002     # the person the account answers to
```

## 5. Direct messages

1. From the operator's phone, send the account a message. `whatsapp-axi events` shows it, marked
   as from an operator.
2. From a phone that is not an operator, send the account a message. `events` shows nothing new,
   and `chats --fields discarded` shows the shared direct-chat counter went up.
3. Reply from the account: `whatsapp-axi send <chat> "hello" --reply <ref>`. On the operator's
   phone it should render as a quote.
4. Send a file: `whatsapp-axi send-file <chat> ./some.pdf`. It should arrive as a document with its
   name.

## 6. One group, in `tagged` scope

Add the account to a small group. Pick a marker nobody would type, for example
`zq-marker-7f3a91`. Then, from other members' phones:

| Step | Send | Expect |
| --- | --- | --- |
| a | a plain message containing the marker | nothing in `events`; the group's discard count goes up |
| b | a message that mentions the account | kept (`kept_by: mention`) |
| c | a reply to (b) without a mention | kept (`kept_by: reply`) |
| d | a new plain message with an attachment, then a reply to it that mentions the account | the attachment message is kept (`kept_by: parent`), then the reply; `download` fetches the file |
| e | another reply to the attachment message, without a mention | nothing |
| f | a reply to something the account sent | kept |

## 7. The marker search

The marker from step 6a must be in no file of the account, the library's database included:

```sh
grep -r -a -l "zq-marker-7f3a91" \
  ~/.config/whatsapp-axi/example ~/.local/state/whatsapp-axi/example ; echo "exit $?"
```

Exit status 1 with no file names is a pass. Also search the service log:

```sh
whatsapp-axi daemon logs example --lines 2000 | grep -c "zq-marker-7f3a91"
```

## 8. Reboot

Reboot the host and, without logging in to it at a desktop, check from another machine that
`whatsapp-axi doctor` shows the service running and `connected`.

## 9. Record what the traffic showed

For each open question in the plan's Notes (what a quoted copy contains, how a mention looks in a
hidden-id group, group-wide mentions, per-message secrets, the phone's reaction to history not
being downloaded), write the answer into the spec it belongs to.
