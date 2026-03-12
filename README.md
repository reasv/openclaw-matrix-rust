# OpenClaw Matrix Rust Connector

This repository is the parallel Matrix rewrite described in `../Plan.md`.

It keeps the OpenClaw plugin shell in TypeScript and moves the Matrix lifecycle boundary into a Rust `napi-rs` native core. The current implementation is the Phase 1 scaffold plus a minimal Phase 2 bootstrap:

- standalone plugin package metadata
- OpenClaw channel registration and config schema
- native config and event contract
- persisted native session/device state layout
- diagnostics and startup lifecycle emission

The Rust core is intentionally structured around the plan's future domains:

- `auth/`
- `client/`
- `crypto/`
- `sync/`
- `events/`
- `media/`
- `emoji/`
- `reactions/`
- `previews/`
- `state/`

Current limitations:

- no live Matrix network traffic yet
- no Matrix SDK integration yet
- action parity is not complete

Those are the next phases in `Plan.md`, but the repository is now ready for that work without extending the old plugin.
