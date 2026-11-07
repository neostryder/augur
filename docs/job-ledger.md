# Job ledger

The service keeps a metadata ledger in its existing `state.db`. Augur jobs use the existing `jobs` rows, with a `ledger` metadata column. Remote work uses `ledger_remote`. The service combines both when it answers a ledger query. The CLI and MCP server stamp submissions. The desktop app, service-served PWA, and terminal Jobs page read this ledger.

```mermaid
flowchart LR
  Caller[CLI or MCP caller] -->|Stamp and request| Supervisor
  Supervisor -->|Existing job pipeline| Jobs[SQLite jobs]
  Jobs -->|Durable dirty marker| Changes[Ledger change log]
  Live[Existing live job activity] -->|Transient progress and stall state| Ledger[Unified ledger query]
  Nodes[Cogitator nodes] -->|GET /api/v1/jobs since cursor| Poller[Per-node poller]
  Poller -->|Atomic events and cursor| Remote[SQLite remote jobs]
  Remote --> Changes
  Jobs --> Ledger
  Remote --> Ledger
  Ledger --> Clients[IPC clients]
  Ledger --> Rules[Alert rules]
  Rules --> Alerts[Durable alerts and sink interface]
```

## Record

`packages/dispatch-protocol/src/job-ledger.ts` exports the wire types and validation functions. `LedgerJob` wraps an Augur `JobRecord` by reference through `node`, `localId`, and `id`; it does not embed a request or result.

| Field | Meaning |
| --- | --- |
| `id`, `node`, `localId` | The global id is `<node>:<localId>`. Each component has 1 to 128 ASCII letters, digits, dots, underscores, or hyphens. |
| `kind` | `augur-job`, `media-job`, `llm-request`, `model-load`, `model-evict`, `install`, or `download`. |
| `state` | `queued`, `running`, `stalled`, `done`, `failed`, `canceled`, or `node-lost`. |
| `stamp`, `attribution` | Caller metadata and its source, described below. |
| `summary`, `summarySource` | One ASCII line of at most 120 characters, supplied by the `caller`, written by a `local-model`, or empty with source `none`. |
| `route`, `model`, `activity` | The route, served or configured model, and activity. A route or model can be null. |
| `createdAt`, `startedAt`, `endedAt`, `updatedAt`, `lastActivityAt` | Milliseconds since the Unix epoch. Start, end, and last activity can be null. The local `updatedAt` records the latest execution-state timestamp. |
| `durationMs` | The end minus the start, or creation when the job never started. It is null while the job is active. Clients calculate elapsed time from their current time and `startedAt ?? createdAt`. |
| `activityLine` | A transient live progress line, at most 120 ASCII characters. The ledger does not persist it. |
| `parentId`, `retryOf`, `retriedAs` | Qualified ledger ids, or null. |
| `usage` | Provider-reported token counts and cost, or null. The existing accounting call supplies Augur's derived and imputed figures separately. |
| `exitReason` | A metadata exit reason, or null. Local jobs use their execution state here rather than harness error text. |
| `compacted` | Whether the detail retention window has expired. |

The service maps local `completed` to `done`, `cancelled` to `canceled`, and terminal failures, including a lost runner, to `failed`. Approval and queue states appear as `queued`; cancellation in flight appears as `running`. A live stall overlays the running state. A failed local runner has a known end time. An unreachable remote node has an unknown outcome and appears as `node-lost` until the node answers again.

## Stamp

`Stamp` accepts these optional fields. A job request carries `stamp`, and a caller can also carry `caller.stamp`. An IPC request can carry a connection-level `stamp`; request fields override connection fields. Stamps are claims about attribution and grant no permission.

| Field | HTTP header |
| --- | --- |
| `sessionId` | `X-Augur-Session` |
| `sessionTitle` | `X-Augur-Session-Title` |
| `origin` | `X-Augur-Origin` |
| `originLabel` | `X-Augur-Origin-Label` |
| `pid` | `X-Augur-Pid` |
| `parentPid` | `X-Augur-Parent-Pid` |
| `host` | `X-Augur-Host` |
| `summary` | `X-Augur-Summary` |

Header values use UTF-8 percent encoding through `encodeURIComponent`; receivers decode once. Header names ignore case. The exported `stampHeaders` and `stampFromHeaders` functions share this mapping. Text fields have at most 256 characters and no control characters. Process ids are positive safe integers. Summaries also satisfy the shorter ASCII rule. Unknown stamp fields are rejected.

`origin` is `claude-code`, `cli`, `mcp`, `hermes`, `scheduled-task`, `service`, or `other`. The `session`, `origin`, `process`, and `host` attribution groups each record `stamped`, `inferred`, or `unknown`. A partial claim stamps its group; inference fills only groups with no claim. A session title is caller metadata and is never guessed from task text.

`augur run` accepts `--session`, `--session-title`, `--origin`, and `--summary`. Flags override `AUGUR_SESSION`, `AUGUR_SESSION_TITLE`, `AUGUR_ORIGIN`, and `AUGUR_SUMMARY`. The same connection stamp accompanies related CLI calls. The CLI adds its process ids and host name. MCP uses origin `mcp` and label `augur-mcp`, passes the four environment fields, and uses the host session for pick matching. A nested Augur job receives its parent's session id and title through those environment names. It does not inherit the parent's summary.

For an unstamped Windows pipe caller, `jobhost.exe --peer-pid` reads the peer process id from the inherited server pipe handle. `--process-info` reads its executable name and parent id from the process snapshot. A process-tree walk recognizes supported origin names, stops after six processes, and detects loops. Linux reads process names and parent ids from `/proc/<pid>/stat`; macOS uses `ps` with `ppid` and `comm`. A transport that supplies Unix peer credentials can use the same walk. When the runtime supplies no Unix peer pid, or a process cannot be read, the missing groups remain `unknown`. HTTP dispatch uses the socket peer address and user agent as inferred metadata. It does not trust forwarding headers for attribution.

## Local summaries

`JobSummarizer.summarize(prompt, signal)` is the small service interface. `fillJobSummary` runs after submission without awaiting it, stops waiting after 750 ms, aborts the request, and leaves source `none` on timeout or failure. A late reply cannot replace a caller summary or patch a compacted record.

The default implementation calls the `summarize` role at `http://127.0.0.1:8470/v1/chat/completions`. It accepts only numeric loopback addresses, refuses redirects, and sends Cogitator's `X-Cogitator-Via` guard so the role cannot forward the prompt to a peer. It sends at most the first 8000 prompt characters. Its own request carries a fixed summary to prevent recursive summary work. When the usage engine is running, the call uses the existing Cogitator manage credential. A missing key, unavailable model, or unavailable local gateway leaves the summary empty.

## Node events

The service pulls `GET /api/v1/jobs?since=<cursor>` independently from each configured node every five seconds, at service startup, and through `ledger_refresh`. Pulling keeps a sleeping node independent of the service's uptime and does not make a central gateway a dependency for other nodes. Each request has a three-second timeout and refuses redirects. A refresh consumes up to ten pages per node; later refreshes continue from the committed cursor. Concurrent refreshes share the same in-flight poll.

The service's `config.json` accepts a `ledgerNodes` array. Each entry has a durable `node` id, a `url`, and an optional `keyName` reference to an existing secret-store entry. Without `keyName`, a running usage engine supplies `cogitator.manageKey`. URLs follow the existing key transport rule: HTTPS, or HTTP on the home network or loopback. Entries contain no key values. Each node must be registered directly so its collection does not depend on another node being up. The service reads this registry at startup.

```json
{
  "version": 1,
  "node": "node-uuid",
  "events": [],
  "next": "0",
  "more": false
}
```

Each event is `{ "seq": "1", "at": 1790000000000, "job": <LedgerJob> }`. `seq` and `next` are unsigned 64-bit decimal strings, with no leading zeros except `0`. A node persists its identity and sequence counter across restarts. Each new local id is unique for that node's lifetime. A reinstall that loses this state uses a new node id. The endpoint returns only its own work, including calls from other programs, and never re-exports another node's events. Remote pages cannot introduce `augur-job` records.

Events after `since` are contiguous and strictly increasing. An event carries the whole current metadata record, including its original creation time and unchanged kind. `next` is the last sequence returned, or exactly `since` for an empty page. `more` is true only when another page is ready. A node retains unconsumed events; this contract has no truncation or cursor-reset response. Clock time does not order events. Authentication uses a manage-scoped credential on Cogitator's receiving endpoint.

The receiver validates every record and the entire envelope before writing. It commits the remote projections, change-log rows, and node cursor in one SQLite transaction. Replayed events do not add duplicate rows. An invalid transition rolls back the whole page. A terminal state cannot change into another state, and running work cannot return to queued. Retries use new ids and chain links.

The service persists `unreachableSince`, `lastSeenAt`, and the last cursor for every polled node. It overlays `node-lost` on that node's active jobs after a failed poll and leaves finished jobs unchanged. A successful page clears the overlay, including an empty page with no new events. Collection resumes at the persisted cursor after a restart or outage.

## Query API

The shared `Methods` interface in `packages/dispatch-protocol/src/ipc.ts` types these calls. Owner and agent tokens can read them. The HTTP dispatch bridge also serves the nonstreaming calls.

| Method | Parameters | Result |
| --- | --- | --- |
| `ledger_list` | `LedgerQuery`, or no parameters | `{ jobs, next }` |
| `ledger_get` | `{ id }`, using the qualified ledger id | `{ job, parent, children, retries }`, or null |
| `ledger_counts` | `LedgerQuery`, or no parameters | Counts for every ledger state, including zero counts |
| `ledger_changes` | `{ since?, limit? }` | `{ changes, cursor, more }` |
| `ledger_watch` | `{ since? }` | Initial `{ cursor }`, then newline-delimited `{ event: "ledger_change", change }` messages on the same connection |
| `ledger_nodes` | None | Node cursor and reachability records |
| `ledger_refresh` | None | Node records after a poll |
| `ledger_alerts` | None | Persisted alert events |

`LedgerQuery` filters by `session` id, `origin`, `node`, `state` array, `kind` array, exact `route`, inclusive creation-time `from` and `to`, and case-insensitive substring `text`. Text searches ids, summaries, session titles, origin labels, routes, models, and activities. A session filter means jobs started with that caller session id. It is separate from a model conversation name.

Sorting uses `createdAt`, `startedAt`, `endedAt`, or `durationMs`, with `order` set to `asc` or `desc`. The default is creation time descending. Null values sort as -1. The qualified id breaks ties. `limit` defaults to 100 and accepts 1 through 1000. A client passes `next` as `page` to continue with the same filters and ordering. The opaque keyset cursor binds to that query. Concurrent state changes can move records when sorting by mutable fields, so a client uses the watch for current state.

Changes use a service-local durable sequence, independent of node cursors. A watch replays after `since`, then sends changes as they arrive. The exported `watchLedger` client handles this connection. A slow reader exceeding the socket buffer limit is disconnected and can reconnect with its last processed cursor. Activity text stays transient and is available from list and get; durable change events carry state and activity timestamps.

## Retention and privacy

The existing database uses WAL mode and full synchronous commits. Triggers put local job ids into a durable dirty queue inside the job writer's transaction. A ledger read or service refresh drains that queue into the append-only change log. A restart drains any remaining markers, so a crash between a job update and its projection does not lose the job.

`policy.balance.ledger.retentionDays` defaults to 90 and accepts whole days from 0 through 3650. It is documented in `BALANCE_FIELDS` and the classic balance fixture. The service checks compaction at startup and hourly. The existing `retentionDays` service setting still controls execution-folder cleanup separately.

Each old finished job becomes a summary row that keeps its id, node, origin, session id and title, route, model, activity, summary, creation, start, end, duration, state, reported usage, and exit reason. Session ids and chain links remain for historical queries. Process details, host attribution, activity timestamps, and detailed change history are removed. Local execution metadata and events are cleared in the same transaction. Active jobs remain detailed. A transaction replaces each job's detail with its summary, and interruption rolls back that job without deleting its row. Rerunning skips completed compactions. SQLite can retain freed pages and WAL history until it reuses or checkpoints them; compaction is logical retention, not secure erasure.

The ledger accepts a fixed metadata schema and rejects request, prompt, answer, key, and unknown fields. It never copies environment values apart from the four stamp names. The existing execution subsystem can keep results and opted-in prompts in job folders under its existing settings. That subsystem is separate from ledger persistence. Caller-supplied summaries and titles are metadata supplied by the caller; the ledger does not inspect their meaning. Local execution output becomes the fixed live label "Output activity" in the ledger. Remote nodes supply metadata-only progress lines. The ledger strips live lines before writing SQLite events or remote projections.

## Alert events

`LedgerAlert` is a versioned JSON object with `version`, stable `id`, `type`, `at`, `jobId`, `node`, `state`, `route`, nullable `sessionId`, `summary`, `elapsedMs`, nullable `usualMs`, and `samples`. Types are `job.stalled`, `job.failed`, and `job.over-usual-time`. An id combines the qualified job id and the alert type. The service persists each type at most once per job, including across restarts.

By default, the duration rule uses completed jobs from the same node, kind, and route. It waits for at least eight samples, takes their median duration, and flags a running job when its elapsed time exceeds both three times that median and one minute. Stalled and failed jobs have their own rules. A node outage alone does not produce a failure alert.

`AlertSink.emit(LedgerAlert)` is the delivery interface. The standalone ledger defaults to a no-op sink; the running service attaches durable delivery, and `MemoryAlertSink` records events for tests. A sink exception does not stop jobs. `ledger_alerts` supplies the persisted events to a later delivery process. The service delivers events through desktop, outbox, and optional webhook sinks.

## Jobs page

The Jobs page opens from the usage panel or the terminal Dispatch screen. The desktop and service-served browser share the same page. A link with `?session=<session-id>` opens this session by default, and `?job=<qualified-id>` opens a job. Without a known session, the page starts with all jobs. The terminal uses `AUGUR_SESSION` when it is set. The session switch requires a session id, and an empty session never falls back to all jobs. A standalone relay PWA has no ledger service connection; open the PWA served by `augur web` for ledger access.

Filters cover state, kind, node, origin, exact route, session id, creation-time range, and text. Counts use the current filters across the whole result, with 50 rows per page. First page resets paging. The terminal keeps the less common filters behind More filters and accepts ISO date strings for time filters. A compacted row remains searchable and is marked Compacted. Its removed metadata appears as unknown or empty.

A selected row opens its metadata details. The details include attribution sources, summary source, process ids, timestamps, live activity, elapsed time, usage, cost, exit reason, and links to parents, children, and retries. The page does not request results or logs. Local active jobs retain their Cancel job action, using the local execution id. Remote work has no execution control on this page.

The desktop bridge and terminal use `watchLedger` and reconnect from their last cursor. A service-served browser polls `ledger_changes` through `POST /api/dispatch` every three seconds. The terminal refreshes with its existing page polling loop. Lists and details also refresh to read transient activity. The desktop and browser update elapsed time once per second; the terminal calculates it when drawing. Finished jobs use their recorded duration. The node strip shows reachability, the last poll attempt, and when an outage began. `LedgerNode.lastPollAt` is optional for older services, and clients fall back to `lastSeenAt`, the last successful poll.

## Job alert settings

Settings includes Job alerts in the existing Alerts area. The terminal Settings screen has the same switches and thresholds. These controls write the service's `config.json` and take effect immediately. They are separate from provider usage alert outlets. The Service page reports pending, delivered, and failed deliveries per sink. The Service settings editor also exposes the saved settings, with its existing restart workflow.

| Service setting | Default | Accepted values |
| --- | --- | --- |
| `ledgerAlerts.stalled` | `true` | Boolean |
| `ledgerAlerts.failed` | `true` | Boolean |
| `ledgerAlerts.overUsualTime` | `true` | Boolean |
| `stallMinutes` | `10` | Whole minutes, at least 1; applies to local execution inactivity |
| `ledgerAlerts.usualMultiple` | `3` | Whole multiplier from 1 through 1000 |
| `ledgerAlerts.minSamples` | `8` | Whole sample count from 1 through 10000 |
| `ledgerAlerts.webhookUrl` | Empty | Optional HTTPS URL without credentials, query, or fragment |
| `ledgerAlerts.webhookKeyName` | Empty | Optional `ledger-alerts.name` secret-store reference |

The switches control creation of new events. They do not discard an already pending event. A node reports its own remote stall state. A missing or unreachable node does not become a failed-job alert. Duration alerts compare the same node, kind, and route and require elapsed time above both the configured multiple of the median and one minute.

The owner-only calls `ledger_settings`, `ledger_settings_set` with `{ "key": "ledgerAlerts.failed", "value": "false" }`, and `ledger_delivery` read settings, save one setting, and report sink health. The authenticated web app can use these through `/api/dispatch`. An agent token cannot call them. No other service setting can be changed through these calls, and execution calls on the HTTP endpoint retain their automated-caller restrictions.

## Public alert JSON contract, version 1

Each outbox line and webhook body is exactly one `LedgerAlert` object. Consumers use `version` to select the schema and `id` to deduplicate. The stable id is the qualified job id followed by `:` and the event type. A job can produce one event of each type. Delivery retries reuse the same object and id.

| Field | JSON type and meaning |
| --- | --- |
| `version` | Number, always `1` |
| `id` | String, stable event identity |
| `type` | `job.stalled`, `job.failed`, or `job.over-usual-time` |
| `at` | Number, event creation time in Unix milliseconds |
| `jobId`, `node` | Strings, qualified job id and node id |
| `state` | Ledger state when the event was created |
| `route`, `sessionId` | String or null |
| `summary` | One-line metadata summary, at most 120 ASCII characters |
| `elapsedMs` | Number, nonnegative elapsed milliseconds at event creation |
| `usualMs` | Number or null, route median milliseconds when enough samples exist |
| `samples` | Number, count of completed duration samples for the node, kind, and route |

A stalled job:

```json
{"version":1,"id":"eru:24:job.stalled","type":"job.stalled","at":1794049200000,"jobId":"eru:24","node":"eru","state":"stalled","route":"local","sessionId":"review-42","summary":"Review release metadata","elapsedMs":720000,"usualMs":null,"samples":2}
```

A failed job:

```json
{"version":1,"id":"eru:25:job.failed","type":"job.failed","at":1794049200000,"jobId":"eru:25","node":"eru","state":"failed","route":"local","sessionId":null,"summary":"Download reference data","elapsedMs":5000,"usualMs":null,"samples":0}
```

A job over its usual time:

```json
{"version":1,"id":"eru:26:job.over-usual-time","type":"job.over-usual-time","at":1794049200000,"jobId":"eru:26","node":"eru","state":"running","route":"local","sessionId":"review-42","summary":"Index archive metadata","elapsedMs":190000,"usualMs":60000,"samples":12}
```

## Delivery and recovery

The service records one SQLite delivery receipt per alert id and sink. It recovers missing queue entries from the durable alert log after restart, keeps at most 1000 pending entries per sink, and leaves excess events in that log until queue space opens. Each pass attempts up to 20 events per enabled sink. Sinks run independently, and jobs do not wait for delivery. A failed attempt retries after 1, 2, 4, and then successively doubled seconds, capped at five minutes. Only fixed failure messages reach delivery state; transport response text and credentials do not.

The desktop sink waits for a connected desktop app. It reuses the notification request path and passes the qualified job id. The app's native job notification callback opens that job in Jobs when clicked. The service marks acceptance by the native notification API as delivered; it cannot confirm that the operating system displayed a banner or that a person read it. A disconnected app leaves delivery pending. The native app keeps at most 64 active banner callbacks; additional notifications wait for a callback slot. Existing provider usage notifications keep their existing path.

The outbox is `~/.augur/alerts-outbox.jsonl`, under `AUGUR_HOME` when overridden. Each append is flushed before its receipt is recorded. Before an append would exceed 5 MiB, the service rotates the current file to `.1`, then older files to `.2` and `.3`, removing the previous `.3`. The active file and three archives bound retained outbox data to 20 MiB. Readers should follow rotation and retain consumed ids. Startup scans the retained files for ids, so a crash after append and before the SQLite receipt does not repeat that line. A torn final line is preserved in a rotated file, and the next valid object starts a fresh file.

The optional webhook sends `POST` with `Content-Type: application/json` and `Idempotency-Key: <alert id>`. A configured key reference supplies `Authorization: Bearer <secret>` from the existing secret store. The dedicated `ledger-alerts` namespace prevents reuse of a provider credential. Config stores only the reference. The request refuses redirects and times out after ten seconds. Any non-2xx response or transport error leaves delivery pending. No response body enters the ledger or service log.

A crash after a remote receiver or operating system accepts delivery but before SQLite records the receipt can repeat an attempt. Webhook receivers must honor the idempotency key or deduplicate the JSON id. Desktop operating systems do not offer a transaction shared with the service database. A recorded delivery is not repeated after restart. Delivery receipts and alert events remain in SQLite independently of outbox rotation.
