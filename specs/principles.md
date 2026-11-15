# Principles

The trade-offs this tool decides. Each spec ends with a `## Principles` section naming the ones
it rests on.

## The daemon decides what is kept

What an account can read is settled before anything is written, by the account's scope, in the
one process that holds the session. No later layer can widen it.

> Why: a consumer that filters after the fact has already stored what it promised not to read.

## Say exactly what is promised

The discard guarantee is stated at the level the underlying library allows, with what it does
not cover named beside it.

> Why: "it only reads what it is tagged in" is what an operator will repeat to the people in a
> group. If that sentence is wider than the truth, the tool has lied on their behalf.

## One Unix user, one trust boundary

There is no network listener and no token. Whoever can open the account's socket is the
account's operator.

> Why: the previous bridge listened on a port any local process could call. A file mode is a
> boundary the operating system already enforces.

## Unknown is said as unknown

A send whose result could not be determined, a receipt that was not sent, an account whose
files cannot be read: each is reported as what it is, never as a failure and never as nothing.

> Why: an agent retries a failure and ignores an empty result. Both are wrong when the truth is
> "this may have happened".

## Modest by default, loosened on purpose

A new account reads the least and sends the least. Widening what it reads or loosening a send
limit takes `--confirm`, and the daemon enforces it. Routine sends are never gated.

> Why: WhatsApp restricts accounts that behave like automation, and the people in a group did
> not choose to have a bot among them. The safe setting should be the one nobody had to pick.

## What others see is true

Read ticks mean the consumer has the message. A typing indicator means a reply is being
written. Nothing is signalled on the daemon's own initiative.

> Why: a receipt is a statement to another person about what happened.

## A transport, not an agent

The tool keeps, delivers and sends. Whether to answer, what may be said and to whom are the
consumer's decisions, and the tool gives it the facts to make them.

> Why: a bot's rules change with its operator; the transport's guarantees should not.

## One vocabulary

The daemon's error codes, field names and states are the CLI's, and a script reads them from a
file, never from the TOON view.

> Why: a second spelling of the same fact is a translation someone has to keep correct.

## Follow the house style, and write down each departure

Flags, errors, output, accounts, home, hooks and `doctor` follow the conventions the tool
family shares ([conventions.md](conventions.md)). Where this tool differs, that file says where
and why.

> Why: an agent that has used one tool of the family should be right about the next.
