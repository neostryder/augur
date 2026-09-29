# Security

## Reporting a problem

Please report security problems privately through GitHub's [private vulnerability reporting](https://github.com/neostryder/augur/security/advisories/new) rather than in a public issue. Include what you found, how to reproduce it, and which version you tested. You should hear back within a week.

## What Augur holds

- **API keys** you enter in the desktop app are stored in the operating system's keychain (Windows Credential Manager, the macOS Keychain, or the Secret Service on Linux). In the web app they are encrypted with a key that the browser keeps and cannot export.
- **Sign-ins for Claude, Codex and Grok** are never copied. The desktop app reads the login files those apps already keep on your computer and renews them the same way the apps do.
- **The TypeSafe console session** lives in the desktop app's own browser profile, and is used only to read your billing page.
- **Phone sync** is encrypted on your computer with a key that only your paired phone holds. Unless you turn off Send API keys to the phone, it also carries the API keys for providers the phone can read itself, so the phone can refresh them. The relay stores that ciphertext for up to 14 days and cannot read it. The phone's refresh button also leaves the time of the tap on the relay for an hour, so the desktop knows to read your providers again. Nothing else goes with it.

## The hosted relay

The relay at augur.rpgm.tools forwards requests from the web app to a fixed list of usage and status endpoints. Its code stores and logs none of them, though Cloudflare, which runs it, keeps its own request logs. It passes your API key through to the provider in the request you make, the same as a direct call. If you would rather not use it, deploy your own copy from `apps/relay` and enter its address in settings.

## The dispatch service

The dispatch service, `augurd`, is a separate program from the desktop app and runs only once you set it up. It keeps a record of each job in a SQLite database in your user profile, and the job's output and results in a folder there for 30 days by default. A prompt is held only until its job starts. It is not stored unless you turn that on. Each job's process receives only the environment variables its adapter names, not the rest of the service's environment.

The service listens on a named pipe. Windows lets any local account open that pipe for reading but not for writing, and every request also has to carry a token kept in a file in your profile, so another account cannot send it commands. Nothing the service holds goes to the relay or the phone.

Hermes, Copilot and short OpenCode prompts travel as command-line arguments, and Grok and long OpenCode prompts go through a file, so a prompt can be visible in the process list or on disk while its job runs. The service deletes those files when the job ends and blanks the prompt in its own record of the job.

The key for an API connector comes from the environment variable its route names and is never written to the job's files. Sandboxed harnesses work on a copy of the working folder and hand back a patch, so your folder stays as it is until you run `augur apply`.

The service takes the caller's word that a person named a model, and that a job may skip the pick or usage check. It cannot verify either, so it records both with the job.

Rules apply to jobs started through the service. A harness started directly from a shell is outside it.

## Supported versions

Only the latest release receives fixes. The desktop app updates itself unless you turn that off.
