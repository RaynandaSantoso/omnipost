# OmniPost domain context

OmniPost lets one operator publish a video to selected platform accounts and
track the resulting background work. This glossary defines the project's
language; implementation details live in [the architecture guide](docs/architecture.md)
and rationale lives in [the decision records](docs/adr/README.md).

## Publishing

- **Operator** — the person who configures and uses an OmniPost instance.
- **User** — the single seeded application identity that owns Uploads and
  PlatformConnections. It is not the audience viewing a published video.
- **Platform** — a supported publishing destination: YouTube, TikTok, or
  Instagram; `dry-run` represents processing without publishing externally.
- **PlatformAdapter** — a platform integration that accepts a video and
  Resolved metadata, reports transfer progress where supported, and returns
  a result or classified failure. DryRunAdapter is the implementation of the
  user-visible dry-run feature.
- **PlatformConnection** — the operator's authorization to publish to one
  platform account, including its credentials, account identifier, and label.
- **Connectable platform** — a Platform that can have a PlatformConnection;
  `dry-run` has no external account to connect.
- **Connection status** — whether an account is connected or needs
  reconnecting, together with its identifying information; it excludes secrets.
- **Connection load state** — whether the dashboard is still loading a
  Connection status, has loaded it, or could not retrieve it. An unavailable
  status is not the same as a confirmed disconnected account.
- **Target platform** — a connected Platform selected for a particular Upload.
  Connection authorizes an account; selection expresses publishing intent.
- **Upload** — one publish action: a stored source video and shared title,
  description, and hashtags. It fans out to one Job per target platform, or a
  dry-run Job when no platform is connected.
- **Job** — the background work for one Upload on one Platform. It has its own
  status, attempts, result, and optional metadata overrides.
- **Resolved metadata** — the title, description or caption, and hashtags for
  an attempt after combining shared defaults with that Job's overrides. The
  active attempt keeps its snapshot even if saved text is edited later.

## Recovery and media

- **Lease** — a time-limited claim held and renewed by a worker while processing
  a Job; expiry permits another worker to recover interrupted work.
- **Transfer state** — the platform-side upload session and confirmed byte
  offset retained between attempts where the platform supports resuming.
- **ResumableTransfer** — the Transfer state supplied to a PlatformAdapter so
  it can continue an earlier transfer.
- **TransferTracker** — the interface through which an adapter reads and
  reports Transfer state.
- **Resume-query** — asking the platform how many bytes it holds before
  resending data; its answer takes precedence over the saved offset.
- **VideoFile** — a stored video accessed in bounded portions for transfer,
  rather than loading the entire video at once.
- **Public media URL** — a temporary, upload-scoped authorization URL allowing
  Instagram to fetch a stored video without a browser login.
- **Retryable failure** — a temporary failure scheduled for another attempt
  with backoff, within the Job's attempt budget.
- **Terminal failure** — a failure that stops automatic attempts and requires
  operator action, such as reconnecting credentials or checking an uncertain
  publishing result before retrying.

## Operating the application

- **Access gate** — the shared-password boundary protecting an instance. It is
  not a system of individual user accounts.
- **Local-only run** — a development session without a public origin or tunnel,
  suitable for local UI work and dry-run processing; it cannot provide the
  public callbacks and media retrieval needed by TikTok and Instagram.
- **Launcher** — the operator's production entry point, available through the
  macOS menu-bar application or terminal commands.
- **Preflight** — the prerequisite checks performed before the Launcher starts
  the app, tunnel, or idle-sleep prevention.
- **Launcher session** — one owned production runtime: the app, reserved
  tunnel, and idle-sleep prevention started and stopped together.
- **Lifecycle state** — Starting, Running, Stopping, Stopped, or Failed for a
  Launcher session. It describes the runtime, not an individual publishing Job.
- **Session log** — the retained, redacted record of Launcher supervision and
  managed-process output, used to diagnose startup and runtime failures.
