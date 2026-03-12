use std::collections::BTreeMap;

use crate::{
    api::{
        MatrixClientConfig, MatrixCustomEmojiRef, MatrixListReactionsRequest, MatrixReactRequest,
        MatrixReactResult, MatrixReactionInfo, MatrixReactionKeyKind, MatrixReactionSummary,
    },
    emoji, state, MatrixError, MatrixResult,
};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedReactionStore {
    version: u32,
    entries: Vec<PersistedReactionEntry>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedReactionEntry {
    room_id: String,
    message_id: String,
    sender_id: String,
    raw_key: String,
    normalized_key: String,
    display: String,
    kind: MatrixReactionKeyKind,
    shortcode: Option<String>,
    created_at_ms: i64,
}

pub fn react_message(
    config: &MatrixClientConfig,
    request: &MatrixReactRequest,
    default_sender_id: &str,
) -> MatrixResult<MatrixReactResult> {
    let sender_id = request
        .sender_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_sender_id);
    if request.room_id.trim().is_empty() || request.message_id.trim().is_empty() {
        return Err(MatrixError::State("room_id and message_id are required".to_string()));
    }

    let mut store = load_store(config)?;
    if request.remove.unwrap_or(false) {
        let target = resolve_reaction_key_info(
            config,
            &request.key,
            Some(request.room_id.as_str()),
            now_ms(),
        )?;
        let before = store.entries.len();
        store.entries.retain(|entry| {
            !(entry.room_id == request.room_id
                && entry.message_id == request.message_id
                && entry.sender_id == sender_id
                && reaction_matches_entry(entry, &target))
        });
        let removed = (before - store.entries.len()) as u64;
        save_store(config, &store)?;
        return Ok(MatrixReactResult {
            removed,
            reaction: Some(target),
        });
    }

    let reaction = resolve_reaction_key_info(
        config,
        &request.key,
        Some(request.room_id.as_str()),
        now_ms(),
    )?;
    store.entries.push(PersistedReactionEntry {
        room_id: request.room_id.clone(),
        message_id: request.message_id.clone(),
        sender_id: sender_id.to_string(),
        raw_key: reaction.raw.clone(),
        normalized_key: reaction.normalized.clone(),
        display: reaction.display.clone(),
        kind: reaction.kind,
        shortcode: reaction.shortcode.clone(),
        created_at_ms: now_ms(),
    });
    save_store(config, &store)?;

    if reaction.kind == MatrixReactionKeyKind::Custom {
        if let Some(shortcode) = &reaction.shortcode {
            emoji::record_usage(
                config,
                &crate::api::MatrixCustomEmojiUsageRequest {
                    emoji: vec![MatrixCustomEmojiRef {
                        shortcode: shortcode.clone(),
                        mxc_url: reaction.normalized.clone(),
                    }],
                    room_id: Some(request.room_id.clone()),
                    observed_at_ms: Some(now_ms()),
                },
            )?;
        }
    }

    Ok(MatrixReactResult {
        removed: 0,
        reaction: Some(reaction),
    })
}

pub fn list_reactions(
    config: &MatrixClientConfig,
    request: &MatrixListReactionsRequest,
) -> MatrixResult<Vec<MatrixReactionSummary>> {
    let store = load_store(config)?;
    let mut summaries = BTreeMap::<String, MatrixReactionSummary>::new();
    for entry in store
        .entries
        .into_iter()
        .filter(|entry| entry.room_id == request.room_id && entry.message_id == request.message_id)
    {
        let summary = summaries
            .entry(entry.normalized_key.clone())
            .or_insert(MatrixReactionSummary {
                key: entry.normalized_key.clone(),
                normalized_key: entry.normalized_key.clone(),
                display: entry.display.clone(),
                kind: entry.kind,
                shortcode: entry.shortcode.clone(),
                count: 0,
                users: Vec::new(),
                raw_keys: Vec::new(),
            });
        summary.count += 1;
        if !summary.users.iter().any(|user| user == &entry.sender_id) {
            summary.users.push(entry.sender_id.clone());
        }
        if !summary.raw_keys.iter().any(|raw| raw == &entry.raw_key) {
            summary.raw_keys.push(entry.raw_key.clone());
        }
        if summary.shortcode.is_none() && entry.shortcode.is_some() {
            summary.shortcode = entry.shortcode.clone();
            summary.display = entry.display.clone();
        }
    }
    let mut output = summaries.into_values().collect::<Vec<_>>();
    output.sort_by(|left, right| right.count.cmp(&left.count).then_with(|| left.display.cmp(&right.display)));
    if let Some(limit) = request.limit {
        output.truncate(limit);
    }
    Ok(output)
}

pub fn resolve_reaction_key_info(
    config: &MatrixClientConfig,
    raw: &str,
    room_id: Option<&str>,
    now_ms: i64,
) -> MatrixResult<MatrixReactionInfo> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(MatrixError::State("reaction key is required".to_string()));
    }

    let normalized_shortcode = emoji::normalize_shortcode(trimmed);
    let resolved_custom = normalized_shortcode
        .as_deref()
        .map(|shortcode| emoji::resolve_for_shortcode(config, shortcode, room_id, now_ms))
        .transpose()?
        .flatten();

    let reaction_raw = resolved_custom
        .as_ref()
        .map(|entry| entry.mxc_url.clone())
        .unwrap_or_else(|| trimmed.to_string());
    let shortcode = resolved_custom
        .as_ref()
        .map(|entry| entry.shortcode.clone())
        .or(normalized_shortcode.clone());
    let decoded = decode_matrix_to_target(&reaction_raw);
    let normalized = normalize_reaction_key(&decoded);
    let kind = if decoded.starts_with("mxc://") {
        MatrixReactionKeyKind::Custom
    } else if normalized.is_empty() {
        MatrixReactionKeyKind::Text
    } else if normalized.chars().any(|ch| ch.is_alphanumeric()) {
        MatrixReactionKeyKind::Text
    } else {
        MatrixReactionKeyKind::Unicode
    };
    let display = if kind == MatrixReactionKeyKind::Custom {
        shortcode.clone().unwrap_or_else(|| format!("[custom reaction {}]", describe_mxc_uri(&decoded)))
    } else {
        normalized.clone()
    };

    Ok(MatrixReactionInfo {
        raw: reaction_raw,
        normalized,
        display,
        kind,
        shortcode,
    })
}

fn reaction_matches_entry(entry: &PersistedReactionEntry, target: &MatrixReactionInfo) -> bool {
    entry.raw_key == target.raw
        || entry.normalized_key == target.normalized
        || entry.display == target.display
        || (entry.shortcode.is_some() && entry.shortcode == target.shortcode)
}

fn decode_matrix_to_target(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(target) = trimmed.strip_prefix("https://matrix.to/#/") {
        return percent_decode(target);
    }
    if let Some(target) = trimmed.strip_prefix("http://matrix.to/#/") {
        return percent_decode(target);
    }
    trimmed.to_string()
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = String::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &input[index + 1..index + 3];
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                output.push(value as char);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index] as char);
        index += 1;
    }
    output
}

fn normalize_reaction_key(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("mxc://") {
        return trimmed.to_string();
    }
    trimmed
        .chars()
        .filter(|ch| *ch != '\u{FE0E}' && *ch != '\u{FE0F}')
        .collect()
}

fn describe_mxc_uri(raw: &str) -> String {
    decode_matrix_to_target(raw)
        .strip_prefix("mxc://")
        .unwrap_or(raw)
        .to_string()
}

fn load_store(config: &MatrixClientConfig) -> MatrixResult<PersistedReactionStore> {
    Ok(
        state::read_json::<PersistedReactionStore>(&config.state_layout.reactions_file)?
            .unwrap_or(PersistedReactionStore {
                version: 1,
                entries: Vec::new(),
            }),
    )
}

fn save_store(config: &MatrixClientConfig, payload: &PersistedReactionStore) -> MatrixResult<()> {
    state::write_json(&config.state_layout.reactions_file, payload)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, fs, path::PathBuf};

    use uuid::Uuid;

    use crate::api::{
        MatrixAuthConfig, MatrixClientConfig, MatrixListReactionsRequest, MatrixReactRequest,
        MatrixReactionKeyKind, MatrixStateLayout,
    };

    use super::{list_reactions, react_message, resolve_reaction_key_info};

    fn unique_root() -> PathBuf {
        std::env::temp_dir().join(format!("openclaw-matrix-rust-reactions-{}", Uuid::new_v4()))
    }

    fn sample_config(root: &PathBuf) -> MatrixClientConfig {
        MatrixClientConfig {
            account_id: "default".to_string(),
            homeserver: "https://matrix.example".to_string(),
            user_id: "@bot:example.org".to_string(),
            auth: MatrixAuthConfig::Password {
                password: "secret".to_string(),
            },
            recovery_key: None,
            device_name: Some("OpenClaw Matrix Rust".to_string()),
            initial_sync_limit: 50,
            encryption_enabled: true,
            default_thread_replies: "inbound".to_string(),
            reply_to_mode: "off".to_string(),
            state_layout: MatrixStateLayout {
                root_dir: root.display().to_string(),
                session_file: root.join("session.json").display().to_string(),
                sdk_store_dir: root.join("sdk-store").display().to_string(),
                crypto_store_dir: root.join("crypto-store").display().to_string(),
                media_cache_dir: root.join("media-cache").display().to_string(),
                emoji_catalog_file: root.join("emoji.json").display().to_string(),
                reactions_file: root.join("reactions.json").display().to_string(),
                logs_dir: root.join("logs").display().to_string(),
            },
            room_overrides: BTreeMap::new(),
        }
    }

    #[test]
    fn normalizes_unicode_variants() {
        let root = unique_root();
        let config = sample_config(&root);
        let left = resolve_reaction_key_info(&config, "⭐", None, 1000).unwrap();
        let right = resolve_reaction_key_info(&config, "⭐️", None, 1000).unwrap();
        assert_eq!(left.normalized, right.normalized);
        fs::remove_dir_all(root).unwrap_or_default();
    }

    #[test]
    fn aggregates_reactions_by_normalized_key() {
        let root = unique_root();
        let config = sample_config(&root);
        react_message(
            &config,
            &MatrixReactRequest {
                room_id: "!room:example.org".to_string(),
                message_id: "$event".to_string(),
                key: "⭐".to_string(),
                remove: None,
                sender_id: Some("@alice:example.org".to_string()),
            },
            "@bot:example.org",
        )
        .unwrap();
        react_message(
            &config,
            &MatrixReactRequest {
                room_id: "!room:example.org".to_string(),
                message_id: "$event".to_string(),
                key: "⭐️".to_string(),
                remove: None,
                sender_id: Some("@bob:example.org".to_string()),
            },
            "@bot:example.org",
        )
        .unwrap();

        let reactions = list_reactions(
            &config,
            &MatrixListReactionsRequest {
                room_id: "!room:example.org".to_string(),
                message_id: "$event".to_string(),
                limit: None,
            },
        )
        .unwrap();
        assert_eq!(reactions.len(), 1);
        assert_eq!(reactions[0].count, 2);
        assert_eq!(reactions[0].users.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolves_custom_shortcodes_through_catalog() {
        let root = unique_root();
        let config = sample_config(&root);
        react_message(
            &config,
            &MatrixReactRequest {
                room_id: "!room:example.org".to_string(),
                message_id: "$seed".to_string(),
                key: "mxc://matrix.example.org/party".to_string(),
                remove: None,
                sender_id: Some("@alice:example.org".to_string()),
            },
            "@bot:example.org",
        )
        .unwrap();
        crate::emoji::record_usage(
            &config,
            &crate::api::MatrixCustomEmojiUsageRequest {
                emoji: vec![crate::api::MatrixCustomEmojiRef {
                    shortcode: ":party_parrot:".to_string(),
                    mxc_url: "mxc://matrix.example.org/party".to_string(),
                }],
                room_id: Some("!room:example.org".to_string()),
                observed_at_ms: Some(1000),
            },
        )
        .unwrap();
        let info = resolve_reaction_key_info(&config, ":party_parrot:", Some("!room:example.org"), 2000)
            .unwrap();
        assert_eq!(info.kind, MatrixReactionKeyKind::Custom);
        assert_eq!(info.normalized, "mxc://matrix.example.org/party");
        assert_eq!(info.shortcode.as_deref(), Some(":party_parrot:"));
        fs::remove_dir_all(root).unwrap();
    }
}
