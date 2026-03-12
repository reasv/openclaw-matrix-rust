use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "mode")]
pub enum MatrixAuthConfig {
    Password { password: String },
    AccessToken {
        #[serde(rename = "accessToken")]
        access_token: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixStateLayout {
    pub root_dir: String,
    pub session_file: String,
    pub sdk_store_dir: String,
    pub crypto_store_dir: String,
    pub media_cache_dir: String,
    pub emoji_catalog_file: String,
    pub logs_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRoomOverride {
    pub thread_replies: Option<String>,
    pub require_mention: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixClientConfig {
    pub account_id: String,
    pub homeserver: String,
    pub user_id: String,
    pub auth: MatrixAuthConfig,
    pub recovery_key: Option<String>,
    pub device_name: Option<String>,
    pub initial_sync_limit: u32,
    pub encryption_enabled: bool,
    pub default_thread_replies: String,
    pub reply_to_mode: String,
    pub state_layout: MatrixStateLayout,
    pub room_overrides: std::collections::BTreeMap<String, MatrixRoomOverride>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MatrixSyncState {
    Stopped,
    Starting,
    Ready,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MatrixVerificationState {
    Disabled,
    Pending,
    Verified,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MatrixKeyBackupState {
    Disabled,
    Pending,
    Enabled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixDiagnostics {
    pub account_id: String,
    pub user_id: String,
    pub device_id: String,
    pub verification_state: MatrixVerificationState,
    pub key_backup_state: MatrixKeyBackupState,
    pub sync_state: MatrixSyncState,
    pub last_successful_sync_at: Option<DateTime<Utc>>,
    pub last_successful_decryption_at: Option<DateTime<Utc>>,
    pub started_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeLifecycleStage {
    LoadSession,
    InitStores,
    RestoreOrLogin,
    PersistSession,
    InitCrypto,
    RestoreRecovery,
    EnableBackup,
    StartSync,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MatrixNativeEvent {
    Lifecycle {
        stage: NativeLifecycleStage,
        detail: String,
        at: DateTime<Utc>,
    },
    SyncState {
        state: MatrixSyncState,
        at: DateTime<Utc>,
    },
    Outbound {
        room_id: String,
        message_id: String,
        thread_id: Option<String>,
        reply_to_id: Option<String>,
        at: DateTime<Utc>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixSendRequest {
    pub room_id: String,
    pub text: String,
    pub reply_to_id: Option<String>,
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixSendResult {
    pub room_id: String,
    pub message_id: String,
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub account_id: String,
    pub homeserver: String,
    pub user_id: String,
    pub device_id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub auth_mode: String,
}
