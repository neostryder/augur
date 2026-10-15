# Jev gateway

The Jev gateway listens on `127.0.0.1:8020` and answers `POST /v1/systemone` the same way TypeSafe does. It forwards each request to Jev at `https://api.typesafe.ai/v1/systemone` with its own API key, or to a Laya server when the request's data tier says the text has to stay local. A program that already speaks System One only needs its base URL changed to `http://127.0.0.1:8020`, and it can drop its own copy of the key.

The gateway also replaces whatever model the caller names with the alias in its settings (`jev-preview` unless you change it), adds the TypeSafe Danger Zone headers a request needs, and writes a line per request to a usage log. That line never contains the request text or the answer.

## Running it

The gateway builds to a single JavaScript file for Node 24 or newer. In a checkout of this repository, after `pnpm install`:

```bash
node scripts/build-gateway.mjs
```

That writes `dist/jev-gateway/jev-gateway.mjs`. Pass a folder as the argument to put it somewhere else. The file runs on its own, without the checkout or `node_modules`, so it can be copied to another machine. `pnpm build:service` puts a copy in `dist/service` as well.

```bash
node jev-gateway.mjs serve
node jev-gateway.mjs token <consumer name>
node jev-gateway.mjs check
```

`serve` is what runs with no argument. It starts the listener and shuts down cleanly on SIGINT or SIGTERM.

`token` makes a token for a consumer and prints it once. Only the token's SHA-256 is saved, under `consumers` in the settings file, so a lost token cannot be recovered. Run `token` again with the same name to replace it. Names are 1 to 48 characters from letters, digits, `.`, `-`, and `_`.

`check` prints the settings the gateway would use, as JSON, and exits with 1 if the file has a problem. The output lists consumer names but not their hashes, and says whether a hosted key was found without showing it.

To start the gateway at logon or boot, point your system's scheduler or service manager at `node jev-gateway.mjs`.

## Settings

Settings are read from `~/.augur/jev-gateway.json`. Set `AUGUR_HOME` to move the whole folder, or `JEV_GATEWAY_CONFIG` to use a different file. With no file, the defaults below apply.

The gateway compares the file's modified time on each request and rereads it when it changes. A new model, token, or key source therefore takes effect on the next request. `host` and `port` are the exception: they are read once, at startup. If an edit breaks the JSON, the previous settings stay in use. A single bad value (a port of `"x"`, an `http://` endpoint) falls back to its default, and `check` names it.

| Field | Default | Effect |
| --- | --- | --- |
| `host` | `127.0.0.1` | Address the listener binds to. Any address other than `localhost`, `::1`, or `127.x.x.x` turns `requireToken` on, even if the file sets it to `false`. |
| `port` | `8020` | Port the listener binds to. |
| `model` | `jev-preview` | Alias sent to TypeSafe on every hosted request. A model the caller names is swapped for this one unless it appears in `pins`. |
| `pins` | `[]` | Model ids a caller may name and keep, for example `jev-1.14.0` when a calibrated threshold was measured on that version. |
| `endpoint` | `https://api.typesafe.ai/v1/systemone` | Hosted System One URL. Must start with `https://`. |
| `defaultTier` | `internal` | Tier for a request with no `x-augur-data` header and no matching student term. One of `public`, `internal`, `sensitive`, `regulated`. |
| `consumers` | `{}` | Consumer name to the lowercase hex SHA-256 of its token. `token` writes these. |
| `requireToken` | `false` | When `true`, every request except `GET /health` needs a consumer token. When `false`, callers on this computer can skip it. |
| `laya` | `[{ "name": "local", "url": "http://127.0.0.1:8010" }]` | Laya servers, tried in order. Each needs a `name` and an `http://` or `https://` `url`. |
| `layaModel` | `laya` | Model sent to Laya for a local-only request that doesn't name a Laya model. |
| `key` | `{}` | Where to find the hosted API key. See [The API key](#the-api-key). |
| `usageLog` | `~/.augur/jev-gateway-usage.jsonl` | Path of the usage log. |
| `retries` | `2` | Extra attempts after a 429, 500, 502, 503, 504, or 529 from TypeSafe, or no response. 0 to 5. |
| `timeoutMs` | `60000` | Time limit for one hosted attempt, from 1000 to 600000 ms. |
| `maxBodyMb` | `32` | Largest request body in MB, checked before and after decompression. At most 32. |

If `requireToken` is on and `consumers` is empty, nothing can get through, and `check` warns about it.

Here is a file that lets callers keep one pinned version and reads the key from a file:

```json
{
  "model": "jev-preview",
  "pins": ["jev-1.14.0"],
  "key": { "file": "/path/to/typesafe-key.txt" }
}
```

## The API key

The `key` object can name environment variables, a file, a command, or any mix. They are tried in that order and the first one that yields a non-empty value wins.

- `env` is a list of variable names. It defaults to `["TYPESAFE_API_KEY", "JEV_API_KEY"]`, and a list you set replaces the default rather than adding to it.
- `file` is a path whose entire content is the key.
- `command` is a program and its arguments as a list, such as `["<secret tool>", "get", "<secret id>"]`. Its output is used as the key, and it is killed after 15 seconds.

A key that was found is cached for five minutes. If no key was found, the gateway looks again on the next request. A 401 from TypeSafe clears the cache, so a rotated key is picked up without a restart. The key is never logged or returned, and it is never written to the settings file.

## Data tiers

Callers set the tier with the `x-augur-data` header. Accepted values are `public`, `internal`, `sensitive`, `regulated`, and `local_only`, in any case, with `-` accepted for `_`. `local_only` is handled as `regulated`. Anything else gets a 400.

When the header is missing, the gateway looks at the request's `state`. One of the terms `gcu`, `student`, `students`, `roster`, `ferpa`, `mis-600`, or `bit-200` makes it `regulated`; everyday words such as course, rubric, or grade do not. A caller that handles student data should declare the tier, because this check is a backstop. Otherwise it gets `defaultTier`. A declared tier is trusted, so `x-augur-data: internal` sends text with student wording to the hosted model.

Only `public` and `internal` requests can go to TypeSafe. A `sensitive` or `regulated` request is sent to Laya, and if no Laya server answers it gets a 503 instead of being sent upstream. Laya handles text only. A local-only request with an image in `assets` or a Box question is refused with 422. So is one that asks for long context, which only the hosted model supports.

A request whose `model` is `laya` or begins with `laya:` goes to Laya whatever its tier, and keeps that model name.

Before posting to a Laya server, the gateway calls its `/load` endpoint. A server that says it is busy or not ready is skipped for 5 seconds. One that can't be reached is skipped for 30.

## Headers

Headers the gateway reads:

| Header | Meaning |
| --- | --- |
| `Authorization: Bearer <token>` | Consumer token. A valid one names the consumer in the usage log even when tokens aren't required. |
| `x-augur-data` | Data tier. |
| `x-augur-consumer` | Name for the usage log when there is no token. Only letters, digits, `.`, `-`, and `_` are kept, up to 48 characters. Without it the name is `local`. |
| `x-augur-long-context: true` | Request the long-context option. `TypeSafe-Danger-Zone-Long-Context: true`, or `"long_context": true` in the body, does the same. The body field is stripped before forwarding. |
| `Content-Encoding` | `identity`, `gzip`, or `zstd`. |
| `Content-Type` | JSON. Multipart gets a 415. Send images as base64 in the `assets` map. |

On the way to TypeSafe the gateway sets `Authorization` to its own key. It adds `TypeSafe-Danger-Zone-Images: true` when the body has a non-empty `assets` map or a Box question, and `TypeSafe-Danger-Zone-Long-Context: true` when the caller asked for long context. Callers never need to send the images header.

Responses to answered requests carry `x-augur-route` (`hosted` or `laya`), `x-augur-tier`, `x-augur-tier-source` (`declared`, `default`, or `content`), and `x-augur-model`, which is the model named in the answer, or the model sent if the answer names none. Upstream responses, errors included, keep their status and body and do not have `x-augur-gateway`. A 422 from TypeSafe, or a 429 that is still a 429 after the retries, reaches the caller unchanged. Responses the gateway writes itself have `x-augur-gateway: 1`. When the gateway refuses on a rule, it also sets `x-augur-refused: 1`.

## Who may call it

With `requireToken` off, the `Host` header must be `localhost`, `127.x.x.x`, or `[::1]`, and any request with an `Origin` header gets a 403. Browsers send `Origin`, so a web page cannot call the gateway even though it runs on the same machine. With `requireToken` on, a missing or unknown token gets a 401 on every path except `GET /health`. Token hashes are compared in constant time.

Callers get 15 seconds to send headers and 120 seconds to finish the request.

## Falling back to TypeSafe

If the gateway can't be reached, or answers 502 or 503 without `x-augur-refused`, a client can call TypeSafe directly with its own key. A 503 of that kind means the gateway has no key. A 502 means TypeSafe didn't respond after the retries. A direct call bypasses the tier check, so the client must apply it itself and fall back only for `public` and `internal` requests. Sensitive and regulated requests never go to TypeSafe from the client, whether or not the gateway is running.

Don't retry a response that has `x-augur-refused: 1` anywhere else. A response without `x-augur-gateway` came from TypeSafe, and calling TypeSafe directly would get the same answer.

## Endpoints

`POST /v1/systemone` is the protocol endpoint. Unknown paths and methods get 404.

`GET /health` works without a token and returns:

```json
{ "ok": true, "model": "jev-preview", "hostedKey": true, "laya": ["local"], "tokens": false, "loopback": true, "defaultTier": "internal" }
```

`hostedKey` says whether a key was found, `laya` lists server names, `tokens` is `requireToken`, and `loopback` says whether the listener is on a loopback address.

`GET /usage?days=7` summarizes the usage log. `days` defaults to 7 and is clamped to 1 through 90. It needs the same token, or the same local-only conditions, as `/v1/systemone`. The response contains `requests`, a `byConsumer` map with each consumer's `hosted`, `laya`, `refused`, and `failed` counts, a `byModel` count of answering models, `inputTokens` summed from the `input_tokens` or `prompt_tokens` the answers reported, and `p50Ms`, the median time of successful requests (`null` when there were none).

## Logs

Each request to `/v1/systemone` appends one JSON line to `usageLog`, for example:

```json
{"at":"2026-10-14T18:02:11.204Z","consumer":"local","route":"hosted","tier":"internal","tierSource":"default","modelAsked":"jev-1.13.0","modelSent":"jev-preview","modelAnswered":"jev-1.14.0","status":200,"ms":412,"images":false,"longContext":false,"attempts":1,"usage":{"input_tokens":12}}
```

`route` can also be `laya` or `refused`. `tierSource` is `declared`, `default`, or `content` when the request named no tier and its state contained one of `gcu`, `student`, `students`, `ferpa`, `roster`, `mis-600`, or `bit-200`. Callers that handle student data should declare the tier rather than rely on that check. Laya requests add `server`, the Laya server that answered, and refused or failed ones add `reason`, which never quotes the request. If the log can't be written, the request still succeeds.

`~/.augur/jev-gateway.log` gets the address and model at startup, settings problems found at startup, listener errors, the signal that stopped the gateway, and the stack trace of any crash. Problems introduced by a later edit are not logged there; run `check` after editing.

## Errors and refusals

Errors the gateway writes look like this and carry `x-augur-gateway: 1`:

```json
{ "error": { "status": 503, "type": "augur_gateway", "message": "The gateway has no API key for the hosted model. Set one in its key source." } }
```

| Status | `x-augur-refused` | Cause |
| --- | --- | --- |
| 400 | yes | Body isn't a JSON object, or `x-augur-data` has an unknown value. |
| 400 | no | Body isn't valid JSON, or a compressed body can't be decoded or grows past `maxBodyMb`. |
| 401 | yes | Tokens are required and the token is missing or wrong. |
| 403 | yes | No token, and the request has an `Origin` header or a `Host` other than this computer. |
| 404 | no | Unknown path or method. |
| 413 | no | Body is over `maxBodyMb`. |
| 415 | no | `Content-Encoding` other than `identity`, `gzip`, or `zstd`, or a multipart body. |
| 422 | yes | A local-only request has an image, a Box question, or the long-context option. |
| 4xx | no | A Laya server rejected the request. Its status is passed on. |
| 500 | no | Internal error in the gateway. |
| 502 | no | TypeSafe didn't respond after all retries. |
| 503 | no | No API key found. |
| 503 | yes | No Laya server answered a local-only request. |

Between attempts at TypeSafe the gateway waits 0.4 seconds, then 0.8, doubling each time.
