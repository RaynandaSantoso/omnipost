# Triage labels

Use these labels when explicitly asked to triage or publish tracker issues.

| Label | Meaning |
| --- | --- |
| `needs-triage` | A maintainer needs to evaluate the issue. |
| `needs-info` | Work is waiting on information from the reporter. |
| `ready-for-agent` | The outcome, dependencies, and acceptance criteria are clear enough for an agent to implement independently. |
| `ready-for-human` | Implementation requires human involvement. |
| `wontfix` | The issue will not be implemented. |

An implementation ticket's `ready-for-agent` status must also account for its
blockers: a specified ticket is not ready to execute while a blocking ticket
remains unresolved. See [the tracker guide](issue-tracker.md) for dependencies.
