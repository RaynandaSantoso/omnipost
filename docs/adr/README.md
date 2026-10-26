# Architectural decisions

These records explain choices that are costly or surprising to change. Each
record includes its own context and rationale; old chats, local PRDs, and issue
comments are not prerequisites for understanding it.

| Record | Status | Decision |
| --- | --- | --- |
| [0001](0001-oracle-free-vm-and-dynamic-dns.md) | Superseded by 0004 | Historical cloud VM and dynamic-DNS plan; never deployed. |
| [0002](0002-generalize-platform-connection-schema.md) | Accepted | Platform-neutral account identifiers; application validation of platform values. |
| [0003](0003-tiktok-self-only-until-audited.md) | Accepted | TikTok Direct Post remains private; public posting needs separate review and implementation. |
| [0004](0004-operator-machine-is-the-host.md) | Accepted | Primary runtime is the operator's Mac with a reserved tunnel; Docker remains an alternative. |

Read [architecture.md](../architecture.md) for the current code structure and
[CONTEXT.md](../../CONTEXT.md) for domain vocabulary. A superseded record explains
history; follow its replacement for current behavior.

When updating a decision, explain the constraint, alternatives, chosen approach,
and consequences in the record itself. Link relevant implementation files.
Issue and commit links may supplement the explanation, but must not carry its
only rationale. Mark replaced decisions as superseded and link both records.
