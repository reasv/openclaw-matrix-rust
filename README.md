# OpenClaw Matrix Rust Connector

## Introduction

`openclaw-matrix-rust` is a Matrix channel plugin for OpenClaw.

It exists because the Matrix lifecycle problems are the hard part of a serious Matrix bot: login, persistent device reuse, end-to-end encryption, cross-signing recovery, key backup, sync startup ordering, media encryption, and long-lived state are all much easier to get wrong than the OpenClaw-facing plugin logic above them.

This project splits those concerns cleanly:

- Rust owns the Matrix protocol, crypto, sync, media, and persistent state.
- TypeScript owns the OpenClaw plugin boundary, config, routing, and runtime integration.

The result is a Matrix connector meant for real OpenClaw usage on encrypted homeservers, where the bot needs to survive restarts, keep the same device, restore its crypto state correctly, and still preserve OpenClaw-specific behavior such as mention gating, buffered context, threading rules, actions, previews, custom emoji handling, and media handoff.

Use this project when you want OpenClaw to operate as a Matrix bot through a Rust-backed native core instead of a JS-only Matrix stack.

## Prerequisites

You need a Linux system with the following available.

### Required software

- `git`
- `node` and `pnpm`
- `rustup` with Rust `1.93.0`
- a C/C++ toolchain for building native modules

On Debian or Ubuntu, the usual baseline is:

```bash
sudo apt update
sudo apt install -y git curl build-essential pkg-config
```

Install `pnpm` if you do not already have it:

```bash
npm install -g pnpm
```

Install Rust and the pinned toolchain:

```bash
curl https://sh.rustup.rs -sSf | sh
rustup toolchain install 1.93.0
rustup default 1.93.0
```

### Matrix-side requirements

You also need Matrix credentials for the bot account:

- homeserver URL
- Matrix user ID
- password
- optional recovery key if you want cross-signing restore and backup bootstrap

### OpenClaw requirement

This plugin expects OpenClaw `>= 2026.3.11`.

For source-based local development, this repository is normally used next to an OpenClaw checkout, for example:

```text
~/projects/oclaw/openclaw
~/projects/oclaw/openclaw-matrix-rust
```

## Install and Run with OpenClaw on Linux

The steps below assume you are running OpenClaw from source on Linux and want to load this plugin from a local path.

### 1. Clone the repositories

Clone OpenClaw and this plugin into the same parent directory:

```bash
mkdir -p ~/projects/oclaw
cd ~/projects/oclaw
git clone <your-openclaw-repo-url> openclaw
git clone <this-repo-url> openclaw-matrix-rust
```

### 2. Install dependencies

Install OpenClaw dependencies:

```bash
cd ~/projects/oclaw/openclaw
pnpm install
```

Install this plugin's dependencies:

```bash
cd ~/projects/oclaw/openclaw-matrix-rust
pnpm install
```

### 3. Build the native module and verify the plugin

From the plugin repository:

```bash
cd ~/projects/oclaw/openclaw-matrix-rust
pnpm build
```

That will:

- build the Rust native module through `napi-rs`
- run TypeScript typechecking
- run Rust and JS tests

### 4. Configure OpenClaw to load the plugin

Add this repository path to `plugins.load.paths` in your OpenClaw config, and configure the Matrix channel.

Example:

```json
{
  "plugins": {
    "allow": ["matrix-rust"],
    "load": {
      "paths": [
        "/home/you/projects/oclaw/openclaw-matrix-rust"
      ]
    },
    "entries": {
      "matrix-rust": {
        "enabled": true
      }
    }
  },
  "channels": {
    "matrix": {
      "enabled": true,
      "homeserver": "https://matrix.example.org",
      "userId": "@bot:example.org",
      "password": "your-password",
      "recoveryKey": "optional recovery key",
      "deviceName": "OpenClaw Gateway",
      "encryption": true,
      "threadReplies": "inbound"
    }
  }
}
```

Important gotcha:

- the plugin id is `matrix-rust`
- the channel id is still `matrix`
- so OpenClaw plugin selection uses `plugins.allow` and `plugins.entries.matrix-rust`
- but the actual Matrix account config still lives under `channels.matrix`

That split is intentional. It keeps this project as a drop-in Matrix channel replacement without colliding with OpenClaw's bundled `matrix` plugin id.

Useful optional settings include:

- `rooms`
- `groups`
- `dm`
- `actions`
- `roomHistoryMaxEntries`
- `replyToMode`
- `threadReplies`
- `xPreviewViaFxTwitter`

See `src/config-schema.ts` for the exact schema.

### 5. Start OpenClaw

Start OpenClaw normally, with your config pointing at this plugin:

```bash
cd ~/projects/oclaw
./run-openclaw.sh gateway --verbose
```

Or, if you run OpenClaw directly from its own checkout:

```bash
cd ~/projects/oclaw/openclaw
pnpm openclaw gateway --verbose
```

### 6. What successful startup looks like

On a healthy first start you should see Matrix lifecycle logs similar to:

- `load_session`
- `init_stores`
- `restore_or_login`
- `persist_session`
- `init_crypto`
- `restore_recovery`
- `enable_backup`
- `sync_state=ready`

On later restarts, a healthy startup should restore the persisted session instead of creating a new device.

### 7. State location

By default, the plugin stores Matrix state under OpenClaw's plugin state directory, for example:

```text
.openclaw/plugins/matrix-rust/<account-id>/
```

This contains persisted session data, SQLite SDK stores, crypto state, media cache, and custom emoji state.

## Features

This section lists the behavior this connector actually implements today.

### Encryption and recovery

- End-to-end encrypted Matrix rooms are supported through the Rust `matrix-sdk` core.
- The connector persists Matrix session, state, and crypto material across restart.
- The same Matrix device is reused across restart instead of creating a fresh device every boot.
- If you configure a recovery phrase, the connector restores cross-signing secrets on the live device and validates active key backup during startup.

### OpenClaw conversation behavior

- Mention-gated behavior for group rooms.
- Buffered room history before a triggering mention, so the first routed message can carry recent context.
- Direct-message and group-room policy handling through OpenClaw config.
- Reply and thread-aware routing, including per-room `threadReplies` overrides.
- Startup grace filtering so stale sync events do not immediately trigger bot replies on boot.
- Typing-backed reply dispatch and reaction acknowledgements in the OpenClaw flow.

### Messaging and media

- Inbound Matrix messages are normalized into OpenClaw-usable events in the native core.
- Outbound sends support plain messages, replies, and thread-aware sends.
- Room target resolution and room join are implemented in the native core.
- Media upload and download are implemented in Rust, with handoff to OpenClaw on the TS side.
- Multiple Matrix media types are surfaced into the OpenClaw runtime.

### Custom emoji and reactions

- Inbound formatted HTML is scanned for Matrix custom emoji.
- Custom emoji observations are persisted in an on-disk catalog with usage statistics.
- Outbound `:shortcode:` text is resolved to the best known Matrix custom emoji mapping.
- Reaction keys are normalized consistently.
- Reactions can be added, removed, and listed.
- Shortcode-backed custom emoji reactions are supported.
- Known shortcodes can be listed through actions/tools.

### Link previews

- X/Twitter-family links are normalized and resolved through the FXTwitter preview path.
- Non-X links are resolved through the homeserver preview path.
- Preview text and preview media are returned from Rust and injected into the OpenClaw context layer.

### Actions

- `send`
- `react`
- `reactions`
- `emoji-list`
- `read`
- `edit`
- `delete`
- `pin`
- `unpin`
- `list-pins`
- `member-info`
- `channel-info`

## Architecture

The repository is a single plugin project with two layers.

### TypeScript layer

The TypeScript side is the OpenClaw shell:

- registers the `matrix` channel with OpenClaw
- defines and validates config
- maps config into the native contract
- handles routing, access policy, mention gating, and reply orchestration
- persists downloaded media through OpenClaw APIs
- exposes OpenClaw-facing actions and tools

Relevant files:

- `index.ts`
- `src/channel.ts`
- `src/actions.ts`
- `src/config-schema.ts`
- `src/matrix/`

### Rust layer

The Rust side is the Matrix core, built with `matrix-sdk` and exported to Node through `napi-rs`.

It owns:

- login and session restore
- same-device reuse across restart
- persistent state and crypto stores
- cross-signing recovery and backup enablement
- sync loop and normalized event emission
- reply and thread relation handling
- media upload and download
- custom emoji catalog logic
- reactions
- link previews
- message and pin actions

Relevant files:

- `native/crates/matrix-core/src/lib.rs`
- `native/crates/matrix-core/src/client/`
- `native/crates/matrix-core/src/auth/`
- `native/crates/matrix-core/src/crypto/`
- `native/crates/matrix-core/src/events/`
- `native/crates/matrix-core/src/media/`
- `native/crates/matrix-core/src/emoji/`
- `native/crates/matrix-core/src/reactions/`
- `native/crates/matrix-core/src/previews/`
- `native/crates/matrix-core/src/state/`

### Repository structure

```text
openclaw-matrix-rust/
  index.ts
  package.json
  src/
    channel.ts
    actions.ts
    config-schema.ts
    matrix/
  native/
    Cargo.toml
    crates/
      matrix-core/
        src/
          lib.rs
          auth/
          client/
          crypto/
          events/
          media/
          emoji/
          reactions/
          previews/
          state/
```

## Notes

- The project pins Rust `1.93.0`. That is intentional.
- The native core uses `matrix-sdk 0.16.0` with `bundled-sqlite`, so you do not need a system SQLite development package just to build it.
- This project now uses plugin id `matrix-rust`, while continuing to register channel id `matrix`. If you forget that split and enable `plugins.entries.matrix` instead of `plugins.entries.matrix-rust`, OpenClaw will not load this plugin even though your `channels.matrix` config is valid.
