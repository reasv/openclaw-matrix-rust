# OpenClaw Matrix Rust Connector

This is an OpenClaw Matrix channel connector based on the Rust `matrix-sdk`, written mainly in order to properly support E2EE verification, which doesn't work with the official matrix integration.

It keeps the OpenClaw plugin shell in TypeScript and moves the Matrix lifecycle boundary into a Rust `napi-rs` native core. The current implementation now covers the planned Phase 2 lifecycle milestone:

- standalone plugin package metadata
- OpenClaw channel registration and config schema
- native config and event contract
- persisted Matrix session/device state layout
- real `matrix-sdk` login and session restore
- SQLite-backed state and crypto stores
- startup lifecycle, diagnostics, and background sync state emission

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

- inbound event normalization is not implemented yet
- room/member/media/link-preview parity is not implemented yet
- verification and backup diagnostics are real, but the richer remediation flows still need more work
- action parity is not complete

Implementation note:

- the repo pins Rust to `1.93.0` because `matrix-sdk` `0.16.0` does not build cleanly on the current local `1.94.0` toolchain
