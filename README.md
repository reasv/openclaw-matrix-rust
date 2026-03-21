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
      "threadReplies": "inbound",
      "autoDownloadAttachmentMaxBytes": 0,
      "autoDownloadAttachmentScope": "rooms",
      "imageHandlingMode": "dual",
      "otherMediaPaths": true
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
- `autoDownloadAttachmentMaxBytes`
- `autoDownloadAttachmentScope`
- `imageHandlingMode`
- `otherMediaPaths`

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
- Short inbound batching for contiguous same-sender bursts, so common Matrix client patterns like `text -> image`, `image -> text`, or DM caption splits trigger the agent once instead of multiple times.
- Direct-message and group-room policy handling through OpenClaw config.
- Reply and thread-aware routing, including per-room `threadReplies` overrides.
- Startup grace filtering so stale sync events do not immediately trigger bot replies on boot.
- Typing-backed reply dispatch and reaction acknowledgements in the OpenClaw flow.

#### Reply anchoring and threading

The connector treats Matrix thread placement and Matrix explicit replies as separate things.

- `threadId` means "send this into a Matrix thread"
- `replyToId` means "make this an explicit reply to this specific event"

Those are related but not identical. A message can stay inside a Matrix thread without also being an explicit reply to the triggering event.

This connector uses plugin-side policy to decide when a reply to the current triggering message should be kept, stripped, or added. That policy exists because the useful choice depends on room state that the model does not reliably know at send time, such as whether newer messages arrived while the agent was working or whether the outbound message is the first, middle, or final message in a multi-message reply sequence.

The high-level rules are:

- Explicit replies to a non-current event are always preserved.
- Replies to the current triggering event are heuristic-driven.
- `threadId` is preserved independently of reply stripping or reply insertion.

This gives the model a strong escape hatch for intentional "reply to that earlier message" behavior, while keeping routine reply-to-current behavior deterministic and less spammy.

##### Strong signal: explicit reply to an earlier message

If the outbound payload targets a Matrix event that is not the event that triggered the current run, the connector always preserves it.

That applies in:

- DMs
- normal rooms
- thread conversations

This is treated as a strong semantic signal. If the model deliberately targets some earlier event in context, the connector does not second-guess it.

##### Current-target replies in DMs

In DMs, replies to the current triggering message are always stripped.

Reason:

- in a 1:1 chat there is usually no ambiguity about what the bot is answering
- repeated explicit replies are visually noisy
- the connector still preserves explicit replies to some other earlier event if the model asked for that intentionally

So in practice:

- explicit reply to current: stripped
- no reply target: left unset
- explicit reply to some older message: preserved

##### Current-target replies in rooms and threads

For normal rooms and Matrix thread conversations, replies to the current triggering event are controlled by a positional heuristic.

The connector classifies each outbound message in a reply run as one of:

- `only`
- `first`
- `middle`
- `last`

It then checks whether the triggering event is still effectively the latest room activity from someone other than the bot.

The resulting policy is:

- `only`
  - add or preserve a reply to current only if newer non-bot room activity exists
- `first`
  - add or preserve a reply to current only if newer non-bot room activity exists
- `middle`
  - never reply to current
- `last`
  - add or preserve a reply to current if newer non-bot room activity exists
  - otherwise add or preserve a reply to current only if more than 30 seconds have passed since the triggering event

This is meant to match human behavior more closely:

- if the triggering message is still the latest relevant room activity, replying to it is usually redundant
- the first message in a long bot run should anchor itself only when the room has already moved on
- intermediate status/progress messages should not generate a wall of reply pills
- the final answer can re-anchor when the room has moved or when enough time has passed that explicitly surfacing the result is useful

##### Multi-message replies

The connector supports live block-streamed output and end-of-run final payloads. Reply anchoring is applied across the whole outbound sequence, not per transport primitive.

That means:

- live intermediate messages are treated as `first` or `middle`
- end-of-run payloads are classified so the connector can still distinguish `only` from `last`
- intermediate progress updates generally do not keep replying to the same event repeatedly

The connector uses a one-message rolling buffer for final payloads so it can identify the last final message without delaying the full reply set.

##### How newer room activity is detected

The connector tracks the latest inbound event for each room or thread scope before same-session work is queued. This matters because inbound handling is serialized per session, and without early tracking the active run would not notice newer same-room activity until after it finished.

Practical effect:

- if another user talks while the bot is still working, the final message can re-anchor to the original triggering message
- this works even though the newer inbound event itself may still be waiting in the same per-session queue

##### Model signals vs plugin policy

The plugin deliberately does not leave reply-to-current behavior entirely to the model.

- The model is authoritative when it explicitly targets a non-current event.
- The plugin is authoritative for whether to reply to the current triggering event.

This split is intentional:

- omission of a current-target reply is not a strong signal
- the model does not reliably know room freshness or outbound message position
- the plugin does know those things

As a result, the connector may add a reply to the current event even if the model did not emit one, and may strip a reply-to-current even if the model requested one.

##### Interaction with Matrix thread delivery

`threadReplies` still controls whether the connector should keep delivery inside a Matrix thread.

That is separate from whether the message is also rendered as an explicit reply to a particular event.

So for thread conversations:

- the connector can preserve thread placement
- while still suppressing unnecessary reply-to-current noise inside the thread
- and still preserving explicit replies to older thread events when the model intentionally targets them

##### Practical examples

- DM, one answer, no special target:
  - no explicit reply is sent
- Room, one answer, no one else has spoken:
  - no explicit reply is sent
- Room, first progress update after other users already spoke:
  - the first progress message replies to the triggering event
- Room, several progress updates:
  - middle progress messages do not keep replying
- Room, final answer after 45 seconds with no newer non-bot messages:
  - the final message may reply to wake the user up
- Model explicitly targets an older event in room history:
  - that reply target is preserved regardless of the current-target heuristic

#### Inbound batching

Matrix clients frequently split what the user thinks of as one action into multiple adjacent events. Common examples include:

- an image followed by a text message addressing the bot
- a text message followed by an image upload
- DM caption-like flows that arrive as separate events

The connector handles this with a short debounce window on inbound events from the same sender in the same resolved session.

- Messages are not merged or rewritten.
- The last event in the burst becomes the subject message that the bot replies to.
- Earlier events in that burst are preserved and injected as prior context, the same way buffered room history is preserved as prior context.
- The goal is to suppress duplicate agent runs while preserving the real chat structure.

Media treatment stays conservative:

- The subject message keeps normal top-level media handling.
- Earlier batched messages stay contextual by default rather than being promoted to top-level `MediaPaths` or prompt images.
- If the subject has no top-level media inputs of its own, the connector may fall back to the last earlier media-bearing message in that burst and use only that one message for top-level media handoff.

This behavior exists to make normal Matrix client usage "just work" more often without requiring a custom client flow or changing OpenClaw's conversation model into a synthetic merged-message model.

### Messaging and media

- Inbound Matrix messages are normalized into OpenClaw-usable events in the native core.
- Outbound sends support plain messages, replies, and thread-aware sends.
- Room target resolution and room join are implemented in the native core.
- Media upload and download are implemented in Rust, with handoff to OpenClaw on the TS side.
- Outbound attachment captions are sent as separate text follow-up messages instead of inline media captions, so Matrix clients that derive download names from media `body` fields keep stable filenames across image, file, audio, and video sends.
- Multiple Matrix media types are surfaced into the OpenClaw runtime.
- Every inbound message now includes explicit attachment manifest text with filename and MIME type, including buffered history entries.
- Attachments can be auto-downloaded into the agent workspace under `./msg-attach/` when `autoDownloadAttachmentMaxBytes` is enabled.
- Current-message and direct-parent reply images can be passed to multimodal agent runs as raw image blocks.
- Image handoff is configurable with `imageHandlingMode`:
  - `dual`: raw image blocks plus normal `MediaPaths`
  - `multimodal-only`: raw image blocks without image `MediaPaths`
  - `analysis-only`: image `MediaPaths` only, no raw image blocks
- Non-image attachment propagation into `MediaPaths` is separately controlled by `otherMediaPaths`.
- Auto-download into `./msg-attach/` is controlled by `autoDownloadAttachmentMaxBytes`:
  - `0`: disabled
  - `-1`: unlimited
  - positive value: maximum attachment size in bytes
- Auto-download target scope is controlled by `autoDownloadAttachmentScope`:
  - `rooms`: room messages only (default)
  - `dms`: direct messages only
  - `all`: both rooms and direct messages

### Custom emoji and reactions

- Inbound formatted HTML is scanned for Matrix custom emoji.
- Custom emoji observations are persisted in an on-disk catalog with usage statistics.
- Outbound `:shortcode:` text is resolved to the best known Matrix custom emoji mapping.
- If no recorded custom emoji matches, outbound shortcode text and shortcode reactions fall back to standard unicode emoji shortcodes such as `:joy:` and `:eyes:`.
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

Notes on `read`:

- `read` with timeline params (`limit`, `before`, `after`) still returns paginated message summaries.
- `read` with `eventId` returns a single message summary.
- Attachment retrieval is now primarily handled on inbound by the workspace auto-download path instead of extra `read` flags.

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
