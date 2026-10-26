# Repository instructions

## Product specifications and implementation tickets

- Store local product-planning artifacts under `docs/prd/`.
- For every feature, create one kebab-case feature folder: `docs/prd/<feature-slug>/`.
- Put the complete PRD in `docs/prd/<feature-slug>/spec.md`.
- Put implementation tickets in that same feature folder, one Markdown file per ticket, named in dependency order: `01-<ticket-slug>.md`, `02-<ticket-slug>.md`, and so on.
- Do not place a feature's spec or ticket files directly in `docs/prd/`.
- Each ticket must work independently in a fresh agent context. Include the complete user-visible outcome, blocking tickets, `ready-for-agent` status, and testable acceptance criteria. Do not assume the implementing agent has read the originating conversation.
- Prefer tracer-bullet tickets that deliver a narrow, verifiable behavior end to end. Put blockers before dependants and state blocking edges explicitly.
- When asked to create a spec or tickets locally, create or update these files before publishing anything to an external issue tracker. Only publish tracker issues when the user explicitly asks for publication.
- Use `CONTEXT.md` vocabulary and respect relevant decisions in `docs/adr/` when writing specs and tickets.

