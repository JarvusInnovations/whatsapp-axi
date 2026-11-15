# Specs

This project is spec-driven. Files in `specs/` describe what **should be true** of whatsapp-axi:
its architecture, behaviours, commands, errors and security rules. They are the source of truth.

- **Specs lead.** Behaviour changes start as a spec change; code is brought into conformance after.
  Drift between a spec and the code is a bug.
- **Plans bridge specs to code.** Each chunk of work is a file in [`plans/`](../plans/) that names
  the specs it implements and how it will be validated.

No specs have been written yet. Research that feeds them lives in
[`docs/research/`](../docs/research/); it is input, not a spec.
