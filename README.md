# OpenClaw Matrix Rust Connector

This is an OpenClaw Matrix channel connector based on the Rust `matrix-sdk`, written mainly in order to properly support E2EE verification, which doesn't work with the official matrix integration.

It keeps the OpenClaw plugin shell in TypeScript and moves the Matrix lifecycle boundary into a Rust `napi-rs` native core. The implementation now covers the full plan in `Plan.md`:

- standalone plugin package metadata
- OpenClaw channel registration and config schema
- native config and event contract
- persisted Matrix session/device state layout
- real `matrix-sdk` login and session restore
- SQLite-backed state and crypto stores
- startup lifecycle, diagnostics, and background sync state emission
- normalized inbound event delivery into the TS routing layer
- room join and target resolution
- reply and thread-aware message send
- media upload and download
- custom emoji catalog extraction, persistence, resolution, and outbound formatting
- reaction send, remove, and list
- link preview resolution in Rust
- message read, edit, delete, and pin action parity
- per-room `threadReplies` overrides
- inbound mention gating, buffering, access policy, and typing parity

The Rust core is structured around the connector's Matrix domains:

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

Cutover status:

- this repo is the active Matrix plugin implementation
- the old `openclaw-matrix` repo is reference material only

Implementation note:

- the repo pins Rust to `1.93.0` because `matrix-sdk` `0.16.0` does not build cleanly on the current local `1.94.0` toolchain
