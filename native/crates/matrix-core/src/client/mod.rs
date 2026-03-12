use std::collections::VecDeque;

use chrono::Utc;

use crate::{
    api::{
        MatrixClientConfig, MatrixCustomEmojiUsageRequest, MatrixDiagnostics, MatrixKeyBackupState,
        MatrixListEmojiRequest, MatrixListReactionsRequest, MatrixNativeEvent, MatrixReactRequest,
        MatrixReactResult, MatrixReactionSummary, MatrixSendRequest, MatrixSendResult,
        MatrixSyncState, MatrixVerificationState, NativeLifecycleStage, StoredSession,
    },
    auth::session,
    crypto, emoji, reactions, state, sync, MatrixError, MatrixResult,
};

pub struct MatrixCoreService {
    running: bool,
    config: Option<MatrixClientConfig>,
    session: Option<StoredSession>,
    diagnostics: MatrixDiagnostics,
    events: VecDeque<MatrixNativeEvent>,
    outbound_counter: u64,
}

impl MatrixCoreService {
    pub fn new() -> Self {
        Self {
            running: false,
            config: None,
            session: None,
            diagnostics: MatrixDiagnostics {
                account_id: String::new(),
                user_id: String::new(),
                device_id: String::new(),
                verification_state: MatrixVerificationState::Disabled,
                key_backup_state: MatrixKeyBackupState::Disabled,
                sync_state: MatrixSyncState::Stopped,
                last_successful_sync_at: None,
                last_successful_decryption_at: None,
                started_at: None,
            },
            events: VecDeque::new(),
            outbound_counter: 0,
        }
    }

    pub fn start(&mut self, config: MatrixClientConfig) -> MatrixResult<MatrixDiagnostics> {
        state::ensure_layout(&config.state_layout)?;
        self.events.clear();
        self.push_lifecycle(NativeLifecycleStage::LoadSession, "loading persisted session");
        self.push_lifecycle(NativeLifecycleStage::InitStores, "initializing sdk, crypto, media, and emoji stores");
        let session = session::load_or_create_session(&config)?;
        self.push_lifecycle(
            NativeLifecycleStage::RestoreOrLogin,
            &format!("restored session for {}", session.user_id),
        );
        self.push_lifecycle(
            NativeLifecycleStage::PersistSession,
            &format!("persisted session at {}", config.state_layout.session_file),
        );
        self.push_lifecycle(
            NativeLifecycleStage::InitCrypto,
            "persistent crypto store ready for Matrix SDK bootstrap",
        );

        let (verification_state, key_backup_state, recovery_detail) =
            crypto::resolve_verification_state(&config);
        self.push_lifecycle(NativeLifecycleStage::RestoreRecovery, &recovery_detail);
        self.push_lifecycle(
            NativeLifecycleStage::EnableBackup,
            &format!("key backup state is {:?}", key_backup_state),
        );
        self.push_lifecycle(
            NativeLifecycleStage::StartSync,
            "sync loop can start once the Matrix SDK is attached",
        );

        let now = Utc::now();
        let diagnostics = MatrixDiagnostics {
            account_id: config.account_id.clone(),
            user_id: config.user_id.clone(),
            device_id: session.device_id.clone(),
            verification_state,
            key_backup_state,
            sync_state: sync::ready_state(),
            last_successful_sync_at: Some(now),
            last_successful_decryption_at: None,
            started_at: Some(now),
        };

        self.events
            .push_back(MatrixNativeEvent::SyncState { state: MatrixSyncState::Ready, at: now });
        self.running = true;
        self.config = Some(config);
        self.session = Some(session);
        self.diagnostics = diagnostics.clone();
        Ok(diagnostics)
    }

    pub fn stop(&mut self) {
        self.running = false;
        self.diagnostics.sync_state = MatrixSyncState::Stopped;
        self.events
            .push_back(MatrixNativeEvent::SyncState { state: MatrixSyncState::Stopped, at: Utc::now() });
    }

    pub fn diagnostics(&self) -> MatrixDiagnostics {
        self.diagnostics.clone()
    }

    pub fn poll_events(&mut self) -> Vec<MatrixNativeEvent> {
        self.events.drain(..).collect()
    }

    pub fn send_message(&mut self, request: MatrixSendRequest) -> MatrixResult<MatrixSendResult> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        if request.room_id.trim().is_empty() {
            return Err(MatrixError::State("room_id is required".to_string()));
        }

        self.outbound_counter += 1;
        let message_id = format!(
            "$oclaw-{}-{}",
            self.diagnostics.device_id.to_lowercase(),
            self.outbound_counter
        );
        let now = Utc::now();
        self.events.push_back(MatrixNativeEvent::Outbound {
            room_id: request.room_id.clone(),
            message_id: message_id.clone(),
            thread_id: request.thread_id.clone(),
            reply_to_id: request.reply_to_id.clone(),
            at: now,
        });
        self.diagnostics.last_successful_sync_at = Some(now);
        Ok(MatrixSendResult {
            room_id: request.room_id,
            message_id,
            thread_id: request.thread_id,
        })
    }

    pub fn react_message(&mut self, request: MatrixReactRequest) -> MatrixResult<MatrixReactResult> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| MatrixError::State("client config is unavailable".to_string()))?;
        let sender_id = self
            .session
            .as_ref()
            .map(|session| session.user_id.as_str())
            .unwrap_or(self.diagnostics.user_id.as_str());
        reactions::react_message(config, &request, sender_id)
    }

    pub fn list_reactions(
        &self,
        request: MatrixListReactionsRequest,
    ) -> MatrixResult<Vec<MatrixReactionSummary>> {
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| MatrixError::State("client config is unavailable".to_string()))?;
        reactions::list_reactions(config, &request)
    }

    pub fn record_custom_emoji_usage(
        &self,
        request: MatrixCustomEmojiUsageRequest,
    ) -> MatrixResult<()> {
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| MatrixError::State("client config is unavailable".to_string()))?;
        emoji::record_usage(config, &request)
    }

    pub fn list_known_shortcodes(
        &self,
        request: MatrixListEmojiRequest,
    ) -> MatrixResult<Vec<String>> {
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| MatrixError::State("client config is unavailable".to_string()))?;
        emoji::list_shortcodes(config, &request)
    }

    fn push_lifecycle(&mut self, stage: NativeLifecycleStage, detail: &str) {
        self.events.push_back(MatrixNativeEvent::Lifecycle {
            stage,
            detail: detail.to_string(),
            at: Utc::now(),
        });
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use uuid::Uuid;

    use crate::{
        api::{MatrixAuthConfig, MatrixClientConfig, MatrixStateLayout},
        client::MatrixCoreService,
    };

    fn unique_root() -> PathBuf {
        std::env::temp_dir().join(format!("openclaw-matrix-rust-{}", Uuid::new_v4()))
    }

    fn sample_config(root: &PathBuf) -> MatrixClientConfig {
        MatrixClientConfig {
            account_id: "default".to_string(),
            homeserver: "https://matrix.example".to_string(),
            user_id: "@bot:example.org".to_string(),
            auth: MatrixAuthConfig::Password {
                password: "secret".to_string(),
            },
            recovery_key: Some("mock-recovery-key".to_string()),
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
            room_overrides: Default::default(),
        }
    }

    #[test]
    fn reuses_device_across_restart() {
        let root = unique_root();
        let config = sample_config(&root);
        let mut first = MatrixCoreService::new();
        let first_diagnostics = first.start(config.clone()).unwrap();
        first.stop();

        let mut second = MatrixCoreService::new();
        let second_diagnostics = second.start(config).unwrap();

        assert_eq!(first_diagnostics.device_id, second_diagnostics.device_id);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persists_session_file() {
        let root = unique_root();
        let config = sample_config(&root);
        let mut service = MatrixCoreService::new();
        service.start(config.clone()).unwrap();

        let persisted = fs::read_to_string(config.state_layout.session_file).unwrap();
        assert!(persisted.contains("@bot:example.org"));
        fs::remove_dir_all(root).unwrap();
    }
}
