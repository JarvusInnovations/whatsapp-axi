# Plans

`plans/` holds the work in flight. Each plan is one file, `plans/<slug>.md`, with YAML frontmatter
(`status`, `depends`, `specs`, optional `issues` and `pr`) and the sections Scope, Implements,
Approach, Validation, Risks, Notes and Follow-ups. A plan freezes at `status: done` when its PR
merges, and becomes the record of what was built.

The frontmatter is the only source of status and dependencies; this file keeps no table.

- In flight: `grep -l '^status: in-progress' plans/*.md`
- Done: `grep -l '^status: done' plans/*.md`

The first set of plans follows the bootstrap specs; `daemon-core` has no prerequisites.
