use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::Utc;
use matrix_sdk::{
    Client,
    SessionChange,
    config::RequestConfig,
    encryption::EncryptionSettings,
    ruma::{OwnedRoomId, events::room::message::RoomMessageEventContent},
};
use tokio::{runtime::Runtime, sync::watch, task::JoinHandle};

use crate::{
    api::{
        MatrixAuthConfig, MatrixClientConfig, MatrixCustomEmojiUsageRequest, MatrixDiagnostics,
        MatrixKeyBackupState, MatrixListEmojiRequest, MatrixListReactionsRequest,
        MatrixNativeEvent, MatrixReactRequest, MatrixReactResult, MatrixReactionSummary,
        MatrixSendRequest, MatrixSendResult, MatrixSyncState, MatrixVerificationState,
        NativeLifecycleStage, StoredSession,
    },
    auth::session,
    crypto, emoji, reactions, state, sync, MatrixError, MatrixResult,
};

struct SharedState {
    diagnostics: Mutex<MatrixDiagnostics>,
    events: Mutex<VecDeque<MatrixNativeEvent>>,
}

impl SharedState {
    fn new() -> Self {
        Self {
            diagnostics: Mutex::new(MatrixDiagnostics {
                account_id: String::new(),
                user_id: String::new(),
                device_id: String::new(),
                verification_state: MatrixVerificationState::Disabled,
                key_backup_state: MatrixKeyBackupState::Disabled,
                sync_state: MatrixSyncState::Stopped,
                last_successful_sync_at: None,
                last_successful_decryption_at: None,
                started_at: None,
            }),
            events: Mutex::new(VecDeque::new()),
        }
    }

    fn reset(&self) {
        *self.diagnostics.lock().expect("matrix diagnostics mutex poisoned") = MatrixDiagnostics {
            account_id: String::new(),
            user_id: String::new(),
            device_id: String::new(),
            verification_state: MatrixVerificationState::Disabled,
            key_backup_state: MatrixKeyBackupState::Disabled,
            sync_state: MatrixSyncState::Stopped,
            last_successful_sync_at: None,
            last_successful_decryption_at: None,
            started_at: None,
        };
        self.events.lock().expect("matrix event queue mutex poisoned").clear();
    }

    fn diagnostics(&self) -> MatrixDiagnostics {
        self.diagnostics.lock().expect("matrix diagnostics mutex poisoned").clone()
    }

    fn set_diagnostics(&self, diagnostics: MatrixDiagnostics) {
        *self.diagnostics.lock().expect("matrix diagnostics mutex poisoned") = diagnostics;
    }

    fn update_diagnostics(&self, update: impl FnOnce(&mut MatrixDiagnostics)) {
        let mut diagnostics = self.diagnostics.lock().expect("matrix diagnostics mutex poisoned");
        update(&mut diagnostics);
    }

    fn poll_events(&self) -> Vec<MatrixNativeEvent> {
        self.events
            .lock()
            .expect("matrix event queue mutex poisoned")
            .drain(..)
            .collect()
    }

    fn push_lifecycle(&self, stage: NativeLifecycleStage, detail: impl Into<String>) {
        self.events
            .lock()
            .expect("matrix event queue mutex poisoned")
            .push_back(MatrixNativeEvent::Lifecycle {
                stage,
                detail: detail.into(),
                at: Utc::now(),
            });
    }

    fn set_sync_state(&self, state: MatrixSyncState) {
        let mut diagnostics = self.diagnostics.lock().expect("matrix diagnostics mutex poisoned");
        if diagnostics.sync_state == state {
            return;
        }
        diagnostics.sync_state = state;
        drop(diagnostics);

        self.events
            .lock()
            .expect("matrix event queue mutex poisoned")
            .push_back(MatrixNativeEvent::SyncState { state, at: Utc::now() });
    }
}

pub struct MatrixCoreService {
    runtime: Runtime,
    shared: Arc<SharedState>,
    running: bool,
    config: Option<MatrixClientConfig>,
    session: Option<StoredSession>,
    client: Option<Client>,
    stop_tx: Option<watch::Sender<bool>>,
    sync_task: Option<JoinHandle<()>>,
    session_task: Option<JoinHandle<()>>,
}

impl MatrixCoreService {
    pub fn new() -> Self {
        Self {
            runtime: Runtime::new().expect("tokio runtime"),
            shared: Arc::new(SharedState::new()),
            running: false,
            config: None,
            session: None,
            client: None,
            stop_tx: None,
            sync_task: None,
            session_task: None,
        }
    }

    pub fn start(&mut self, config: MatrixClientConfig) -> MatrixResult<MatrixDiagnostics> {
        if self.running {
            self.stop();
        }

        state::ensure_layout(&config.state_layout)?;
        self.shared.reset();
        self.shared
            .push_lifecycle(NativeLifecycleStage::LoadSession, "loading persisted session");
        let existing_session = session::load_session(&config)?;

        self.shared.push_lifecycle(
            NativeLifecycleStage::InitStores,
            "initializing matrix-sdk sqlite state and crypto stores",
        );

        let client = self.runtime.block_on(build_client(&config))?;
        let active_session = match self.runtime.block_on(restore_or_login(
            &client,
            &config,
            existing_session.as_ref(),
            &self.shared,
        )) {
            Ok(active_session) => active_session,
            Err(err) => {
                self.release_client(client);
                return Err(err);
            }
        };

        self.shared.push_lifecycle(
            NativeLifecycleStage::PersistSession,
            format!("persisted matrix session at {}", config.state_layout.session_file),
        );
        self.shared.push_lifecycle(
            NativeLifecycleStage::InitCrypto,
            "persistent crypto identity loaded from sqlite store",
        );

        let recovery_detail = self
            .runtime
            .block_on(async { crypto::restore_recovery(&client, config.recovery_key.as_deref()).await });
        self.shared
            .push_lifecycle(NativeLifecycleStage::RestoreRecovery, recovery_detail);

        let backup_detail = self.runtime.block_on(async { crypto::ensure_backup(&client).await });
        self.shared
            .push_lifecycle(NativeLifecycleStage::EnableBackup, backup_detail);

        let started_at = Utc::now();
        let initial_diagnostics = MatrixDiagnostics {
            account_id: config.account_id.clone(),
            user_id: active_session.user_id.clone(),
            device_id: active_session.device_id.clone(),
            verification_state: MatrixVerificationState::Pending,
            key_backup_state: MatrixKeyBackupState::Pending,
            sync_state: MatrixSyncState::Stopped,
            last_successful_sync_at: None,
            last_successful_decryption_at: None,
            started_at: Some(started_at),
        };
        self.shared.set_diagnostics(initial_diagnostics);
        self.shared.set_sync_state(MatrixSyncState::Starting);
        self.shared.push_lifecycle(
            NativeLifecycleStage::StartSync,
            "starting initial sync before exposing ready state",
        );

        let initial_sync_token = match self.runtime.block_on(initial_sync(
            &client,
            &config,
            &active_session,
            &self.shared,
        )) {
            Ok(initial_sync_token) => initial_sync_token,
            Err(err) => {
                self.release_client(client);
                return Err(err);
            }
        };

        let (stop_tx, stop_rx) = watch::channel(false);
        let session_task = self.runtime.spawn(run_session_persist_loop(
            client.clone(),
            config.clone(),
            active_session.clone(),
            stop_rx.clone(),
        ));
        let sync_task = self.runtime.spawn(run_sync_loop(
            client.clone(),
            config.clone(),
            active_session.clone(),
            self.shared.clone(),
            stop_rx,
            initial_sync_token,
        ));

        self.running = true;
        self.config = Some(config);
        self.session = Some(active_session);
        self.client = Some(client);
        self.stop_tx = Some(stop_tx);
        self.sync_task = Some(sync_task);
        self.session_task = Some(session_task);
        Ok(self.shared.diagnostics())
    }

    pub fn stop(&mut self) {
        if let Some(stop_tx) = self.stop_tx.take() {
            let _ = stop_tx.send(true);
        }

        if let Some(task) = self.sync_task.take() {
            let _ = self.runtime.block_on(task);
        }
        if let Some(task) = self.session_task.take() {
            let _ = self.runtime.block_on(task);
        }
        if let Some(client) = self.client.take() {
            self.release_client(client);
        }

        self.running = false;
        self.shared.set_sync_state(MatrixSyncState::Stopped);
    }

    pub fn diagnostics(&self) -> MatrixDiagnostics {
        self.shared.diagnostics()
    }

    pub fn poll_events(&mut self) -> Vec<MatrixNativeEvent> {
        self.shared.poll_events()
    }

    pub fn send_message(&mut self, request: MatrixSendRequest) -> MatrixResult<MatrixSendResult> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        if request.room_id.trim().is_empty() {
            return Err(MatrixError::State("room_id is required".to_string()));
        }

        let client = self
            .client
            .as_ref()
            .ok_or_else(|| MatrixError::State("client is not initialized".to_string()))?
            .clone();
        let room_id: OwnedRoomId = request.room_id.parse()?;
        let room = client
            .get_room(&room_id)
            .ok_or_else(|| MatrixError::State(format!("room {room_id} is not known to the client")))?;
        let content = RoomMessageEventContent::text_plain(request.text.clone());
        let response = self.runtime.block_on(async { room.send(content).await })?;
        let now = Utc::now();

        self.shared.update_diagnostics(|diagnostics| {
            diagnostics.last_successful_sync_at = Some(now);
        });
        self.shared
            .events
            .lock()
            .expect("matrix event queue mutex poisoned")
            .push_back(MatrixNativeEvent::Outbound {
                room_id: request.room_id.clone(),
                message_id: response.event_id.to_string(),
                thread_id: request.thread_id.clone(),
                reply_to_id: request.reply_to_id.clone(),
                at: now,
            });

        Ok(MatrixSendResult {
            room_id: request.room_id,
            message_id: response.event_id.to_string(),
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
            .map(|session| session.user_id.clone())
            .unwrap_or_else(|| self.shared.diagnostics().user_id);
        reactions::react_message(config, &request, &sender_id)
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

    fn release_client(&self, client: Client) {
        self.runtime.block_on(async move {
            drop(client);
        });
    }
}

async fn build_client(config: &MatrixClientConfig) -> MatrixResult<Client> {
    let encryption_settings = EncryptionSettings {
        auto_enable_cross_signing: false,
        auto_enable_backups: false,
        ..Default::default()
    };

    Ok(Client::builder()
        .homeserver_url(&config.homeserver)
        .sqlite_store(&config.state_layout.sdk_store_dir, None)
        .handle_refresh_tokens()
        .with_encryption_settings(encryption_settings)
        .request_config(RequestConfig::short_retry())
        .build()
        .await?)
}

async fn restore_or_login(
    client: &Client,
    config: &MatrixClientConfig,
    existing_session: Option<&StoredSession>,
    shared: &Arc<SharedState>,
) -> MatrixResult<StoredSession> {
    if let Some(stored) = existing_session {
        match session::restore_session(client, stored).await {
            Ok(()) => {
                shared.push_lifecycle(
                    NativeLifecycleStage::RestoreOrLogin,
                    format!("restored persisted session for {}", stored.user_id),
                );
                return session::persist_client_session(config, client, Some(stored), stored.sync_token.clone());
            }
            Err(err) => {
                shared.push_lifecycle(
                    NativeLifecycleStage::RestoreOrLogin,
                    format!("persisted session restore failed, falling back to password login: {err}"),
                );
            }
        }
    }

    let password = match &config.auth {
        MatrixAuthConfig::Password { password } => password,
        MatrixAuthConfig::AccessToken { .. } => {
            return Err(MatrixError::State(
                "fresh startup requires password auth; access-token-only bootstrap is not supported"
                    .to_string(),
            ))
        }
    };

    let mut login = client.matrix_auth().login_username(&config.user_id, password);
    if let Some(existing_session) = existing_session {
        login = login.device_id(&existing_session.device_id);
    }
    if let Some(device_name) = config.device_name.as_deref() {
        login = login.initial_device_display_name(device_name);
    }

    login.request_refresh_token().send().await?;
    shared.push_lifecycle(
        NativeLifecycleStage::RestoreOrLogin,
        format!("logged in and activated device for {}", config.user_id),
    );
    session::persist_client_session(config, client, existing_session, None)
}

async fn initial_sync(
    client: &Client,
    config: &MatrixClientConfig,
    stored_session: &StoredSession,
    shared: &Arc<SharedState>,
) -> MatrixResult<String> {
    let response = client
        .sync_once(sync::build_settings(
            stored_session.sync_token.clone(),
            config.initial_sync_limit,
            Duration::from_secs(1),
        ))
        .await?;
    let stored_session = session::persist_client_session(
        config,
        client,
        Some(stored_session),
        Some(response.next_batch.clone()),
    )?;
    refresh_diagnostics(shared, client, config, &stored_session).await;
    shared.set_sync_state(MatrixSyncState::Ready);
    Ok(response.next_batch)
}

async fn refresh_diagnostics(
    shared: &Arc<SharedState>,
    client: &Client,
    config: &MatrixClientConfig,
    stored_session: &StoredSession,
) {
    let (verification_state, key_backup_state) =
        crypto::diagnostics(client, config.encryption_enabled).await;
    let now = Utc::now();

    shared.update_diagnostics(|diagnostics| {
        diagnostics.account_id = config.account_id.clone();
        diagnostics.user_id = stored_session.user_id.clone();
        diagnostics.device_id = stored_session.device_id.clone();
        diagnostics.verification_state = verification_state;
        diagnostics.key_backup_state = key_backup_state;
        diagnostics.last_successful_sync_at = Some(now);
        if diagnostics.started_at.is_none() {
            diagnostics.started_at = Some(now);
        }
    });
}

async fn run_session_persist_loop(
    client: Client,
    config: MatrixClientConfig,
    mut stored_session: StoredSession,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut session_changes = client.subscribe_to_session_changes();

    loop {
        tokio::select! {
            _ = wait_for_stop(&mut stop_rx) => break,
            result = session_changes.recv() => {
                match result {
                    Ok(SessionChange::TokensRefreshed) => {
                        if let Ok(updated_session) = session::persist_client_session(
                            &config,
                            &client,
                            Some(&stored_session),
                            stored_session.sync_token.clone(),
                        ) {
                            stored_session = updated_session;
                        }
                    }
                    Ok(SessionChange::UnknownToken { .. }) => break,
                    Err(_) => break,
                }
            }
        }
    }
}

async fn run_sync_loop(
    client: Client,
    config: MatrixClientConfig,
    mut stored_session: StoredSession,
    shared: Arc<SharedState>,
    mut stop_rx: watch::Receiver<bool>,
    initial_sync_token: String,
) {
    let mut sync_token = Some(initial_sync_token);

    loop {
        let settings =
            sync::build_settings(sync_token.clone(), config.initial_sync_limit, Duration::from_secs(30));
        let sync_result = tokio::select! {
            _ = wait_for_stop(&mut stop_rx) => break,
            result = client.sync_once(settings) => result,
        };

        match sync_result {
            Ok(response) => {
                sync_token = Some(response.next_batch.clone());
                if let Ok(updated_session) = session::persist_client_session(
                    &config,
                    &client,
                    Some(&stored_session),
                    sync_token.clone(),
                ) {
                    stored_session = updated_session;
                }
                refresh_diagnostics(&shared, &client, &config, &stored_session).await;
                shared.set_sync_state(MatrixSyncState::Ready);
            }
            Err(err) => {
                shared.push_lifecycle(
                    NativeLifecycleStage::StartSync,
                    format!("sync iteration failed: {err}"),
                );
                shared.set_sync_state(MatrixSyncState::Error);

                tokio::select! {
                    _ = wait_for_stop(&mut stop_rx) => break,
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                }
            }
        }
    }
}

async fn wait_for_stop(stop_rx: &mut watch::Receiver<bool>) {
    if *stop_rx.borrow() {
        return;
    }

    while stop_rx.changed().await.is_ok() {
        if *stop_rx.borrow() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use tokio::runtime::Runtime;
    use uuid::Uuid;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{header, method, path},
    };

    use crate::{
        api::{MatrixAuthConfig, MatrixClientConfig, MatrixStateLayout},
        client::MatrixCoreService,
    };

    fn unique_root() -> PathBuf {
        std::env::temp_dir().join(format!("openclaw-matrix-rust-{}", Uuid::new_v4()))
    }

    fn sample_config(root: &PathBuf, homeserver: &str) -> MatrixClientConfig {
        MatrixClientConfig {
            account_id: "default".to_string(),
            homeserver: homeserver.to_string(),
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
            room_overrides: Default::default(),
        }
    }

    async fn mount_login(server: &MockServer) {
        mount_versions(server).await;

        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/login"))
            .and(header("content-type", "application/json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user_id": "@bot:example.org",
                "device_id": "OCLAWDEVICE",
                "access_token": "token-1",
                "refresh_token": "refresh-1"
            })))
            .mount(server)
            .await;

        Mock::given(method("POST"))
            .and(path("/_matrix/client/r0/login"))
            .and(header("content-type", "application/json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user_id": "@bot:example.org",
                "device_id": "OCLAWDEVICE",
                "access_token": "token-1",
                "refresh_token": "refresh-1"
            })))
            .mount(server)
            .await;
    }

    async fn mount_versions(server: &MockServer) {
        Mock::given(method("GET"))
            .and(path("/_matrix/client/versions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "versions": ["r0.6.1", "v1.11"]
            })))
            .mount(server)
            .await;
    }

    async fn mount_sync(server: &MockServer, since: Option<&str>, next_batch: &str) {
        let mock = Mock::given(method("GET"))
            .and(path("/_matrix/client/v3/sync"))
            .and(header("authorization", "Bearer token-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "next_batch": next_batch,
                "rooms": {},
                "presence": {},
                "account_data": {},
                "to_device": {},
                "device_lists": {},
                "device_one_time_keys_count": {}
            })))
            .up_to_n_times(1);

        let _ = since;
        mock.mount(server).await;

        Mock::given(method("GET"))
            .and(path("/_matrix/client/r0/sync"))
            .and(header("authorization", "Bearer token-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "next_batch": next_batch,
                "rooms": {},
                "presence": {},
                "account_data": {},
                "to_device": {},
                "device_lists": {},
                "device_one_time_keys_count": {}
            })))
            .up_to_n_times(1)
            .mount(server)
            .await;
    }

    #[test]
    fn reuses_device_across_restart() {
        let root = unique_root();
        let runtime = Runtime::new().unwrap();
        let server = runtime.block_on(MockServer::start());
        runtime.block_on(mount_login(&server));
        runtime.block_on(mount_sync(&server, None, "next-1"));

        let config = sample_config(&root, &server.uri());
        let mut first = MatrixCoreService::new();
        let first_diagnostics = first.start(config.clone()).unwrap();
        first.stop();

        runtime.block_on(mount_sync(&server, Some("next-1"), "next-2"));

        let mut second = MatrixCoreService::new();
        let second_diagnostics = second.start(config).unwrap();
        second.stop();

        assert_eq!(first_diagnostics.device_id, second_diagnostics.device_id);

        fs::remove_dir_all(root).unwrap();
    }
}
