# ADR-0001: Oracle Cloud VM and dynamic DNS for deployment

Status: superseded by [ADR-0004](0004-operator-machine-is-the-host.md).
The VM was not provisioned. This records a rejected deployment plan, not setup
instructions or a dependency on an existing cloud account.

## Context

OmniPost needs a persistent process for its background Job runner, which polls
for work, claims Leases, and renews them during uploads. SQLite and uploaded
video files must survive between requests, and transfers can take minutes.
Request-scoped serverless functions were rejected because the application
assumes both durable local storage and work that continues after an HTTP
response. Moving to serverless would require redesigning those boundaries.

The deployment plan also sought no recurring hosting or domain charge.

## Decision at the time

Use an Oracle Cloud Always Free AMD micro VM with a free dynamic-DNS subdomain.
Run the repository's Docker image with a persistent data volume and put a
TLS-terminating reverse proxy in front of it. A bare VM was preferred over a
paid managed host to meet the cost constraint; dynamic DNS avoided buying a
domain. The small VM also motivated bounded-memory video transfers.

## Consequences and replacement

The operator would have maintained the operating system, Docker, TLS, and DNS,
and accepted limited memory and the risk of losing a free instance. OAuth
callbacks would have needed a stable public hostname and the public instance
would have required an access password.

[ADR-0004](0004-operator-machine-is-the-host.md) replaces the VM with the
operator's Mac and a reserved tunnel. The persistent-process and durable-disk
requirements remain. Docker remains an alternative self-hosting workflow; the
old VM's memory budget is no longer a deployment requirement.
