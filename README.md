# OpenClaw Matrix Rust Connector

This is an OpenClaw Matrix channel connector based on the Rust matrix-sdk, written mainly in order to properly support E2EE verification, which doesn't work with the official matrix integration.

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
