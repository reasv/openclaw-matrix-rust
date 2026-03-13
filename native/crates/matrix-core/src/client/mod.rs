use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::Utc;
use matrix_sdk::{
    Client,
    Error as MatrixSdkError,
    HttpError,
    RefreshTokenError,
    Room,
    RoomState,
    SessionTokens,
    config::RequestConfig,
    deserialized_responses::SyncOrStrippedState,
    encryption::EncryptionSettings,
    room::{IncludeRelations, MessagesOptions, RelationsOptions, edit::EditedContent},
    ruma::{
        EventId, OwnedEventId, OwnedRoomId, OwnedRoomOrAliasId, OwnedUserId, RoomAliasId,
        RoomOrAliasId, RoomId, UInt, UserId,
        api::Direction,
        events::{
            AnySyncMessageLikeEvent, AnySyncTimelineEvent, TimelineEventType,
            reaction::ReactionEventContent,
            relation::{Annotation, RelationType},
        },
        events::room::pinned_events::RoomPinnedEventsEventContent,
        events::room::message::{
            OriginalSyncRoomMessageEvent, RoomMessageEventContent,
            RoomMessageEventContentWithoutRelation,
        },
    },
};
use serde_json::Value;
use tokio::{runtime::Runtime, sync::watch, task::JoinHandle};

use crate::{
    api::{
        MatrixAuthConfig, MatrixChannelInfo, MatrixChannelInfoRequest, MatrixClientConfig,
        MatrixCustomEmojiUsageRequest, MatrixDeleteMessageRequest, MatrixDeleteMessageResult,
        MatrixDiagnostics, MatrixDownloadMediaRequest, MatrixDownloadMediaResult,
        MatrixEditMessageRequest, MatrixEditMessageResult, MatrixJoinRequest, MatrixJoinResult,
        MatrixKeyBackupState, MatrixLinkPreviewResult, MatrixListEmojiRequest,
        MatrixListPinsRequest, MatrixListReactionsRequest, MatrixMemberInfo,
        MatrixMemberInfoRequest, MatrixNativeEvent, MatrixPinMessageRequest, MatrixPinsResult,
        MatrixReactRequest, MatrixReactResult, MatrixReactionSummary, MatrixReadMessagesRequest,
        MatrixReadMessagesResult, MatrixResolveLinkPreviewsRequest, MatrixResolveTargetRequest,
        MatrixResolveTargetResult, MatrixSendRequest, MatrixSendResult, MatrixSyncState,
        MatrixTypingRequest, MatrixUploadMediaRequest, MatrixUploadMediaResult,
        MatrixVerificationState, NativeLifecycleStage, StoredSession,
    },
    auth::session,
    crypto, emoji, events, media, previews, reactions, state, sync, MatrixError, MatrixResult,
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

    fn push_inbound(&self, event: crate::api::MatrixInboundEvent) {
        self.events
            .lock()
            .expect("matrix event queue mutex poisoned")
            .push_back(MatrixNativeEvent::Inbound { event });
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
    client_slot: Arc<Mutex<Option<Client>>>,
    running: bool,
    config: Option<MatrixClientConfig>,
    stop_tx: Option<watch::Sender<bool>>,
    sync_task: Option<JoinHandle<()>>,
}

impl MatrixCoreService {
    pub fn new() -> Self {
        Self {
            runtime: Runtime::new().expect("tokio runtime"),
            shared: Arc::new(SharedState::new()),
            client_slot: Arc::new(Mutex::new(None)),
            running: false,
            config: None,
            stop_tx: None,
            sync_task: None,
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

        let mut client = self.runtime.block_on(build_client(&config))?;
        install_session_callbacks(&client, &config)?;
        let mut active_session = match self.runtime.block_on(restore_or_login(
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
            Err(err) if is_authentication_failure(&err) => {
                match self.runtime.block_on(recover_startup_client(
                    &config,
                    &self.shared,
                    client.clone(),
                    &active_session,
                )) {
                    Ok((replacement_client, replacement_session, replacement_sync_token)) => {
                        self.release_client(client);
                        client = replacement_client;
                        active_session = replacement_session;
                        replacement_sync_token
                    }
                    Err(recovery_err) => {
                        self.release_client(client);
                        return Err(recovery_err);
                    }
                }
            }
            Err(err) => {
                self.release_client(client);
                return Err(err);
            }
        };

        register_inbound_handler(&client, self.shared.clone());
        *self.client_slot.lock().expect("matrix client slot mutex poisoned") = Some(client.clone());

        let (stop_tx, stop_rx) = watch::channel(false);
        let sync_task = self.runtime.spawn(run_sync_loop(
            client.clone(),
            config.clone(),
            active_session.clone(),
            self.shared.clone(),
            self.client_slot.clone(),
            stop_rx,
            initial_sync_token,
        ));

        self.running = true;
        self.config = Some(config);
        self.stop_tx = Some(stop_tx);
        self.sync_task = Some(sync_task);
        Ok(self.shared.diagnostics())
    }

    pub fn stop(&mut self) {
        if let Some(stop_tx) = self.stop_tx.take() {
            let _ = stop_tx.send(true);
        }

        if let Some(task) = self.sync_task.take() {
            let _ = self.runtime.block_on(task);
        }
        if let Some(client) = self
            .client_slot
            .lock()
            .expect("matrix client slot mutex poisoned")
            .take()
        {
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
        let client = self.client()?;
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| MatrixError::State("client config is unavailable".to_string()))?;
        let (room, resolved_target) = self
            .runtime
            .block_on(resolve_room_for_send(&client, &request.room_id))?;
        let content = self.runtime.block_on(build_message_content(
            config,
            &room,
            request.text.clone(),
            request.reply_to_id.as_deref(),
            request.thread_id.as_deref(),
        ))?;
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
                room_id: resolved_target.resolved_room_id.clone(),
                message_id: response.event_id.to_string(),
                thread_id: request.thread_id.clone(),
                reply_to_id: request.reply_to_id.clone(),
                at: now,
            });

        Ok(MatrixSendResult {
            room_id: resolved_target.resolved_room_id,
            message_id: response.event_id.to_string(),
            thread_id: request.thread_id,
        })
    }

    pub fn resolve_target(
        &self,
        request: MatrixResolveTargetRequest,
    ) -> MatrixResult<MatrixResolveTargetResult> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        let client = self.client()?;
        self.runtime.block_on(resolve_target_internal(
            &client,
            &request.target,
            request.create_dm.unwrap_or(true),
        ))
    }

    pub fn join_room(&mut self, request: MatrixJoinRequest) -> MatrixResult<MatrixJoinResult> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        let client = self.client()?;
        let result = self.runtime.block_on(join_room_internal(&client, &request.target))?;
        Ok(result)
    }

    pub fn read_messages(
        &self,
        request: MatrixReadMessagesRequest,
    ) -> MatrixResult<MatrixReadMessagesResult> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        let client = self.client()?;
        self.runtime.block_on(read_messages_internal(&client, &request))
    }

    pub fn edit_message(
        &mut self,
        request: MatrixEditMessageRequest,
    ) -> MatrixResult<MatrixEditMessageResult> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        let client = self.client()?;
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| MatrixError::State("client config is unavailable".to_string()))?;
        self.runtime
            .block_on(edit_message_internal(&client, config, &request))
    }

    pub fn delete_message(
        &mut self,
        request: MatrixDeleteMessageRequest,
    ) -> MatrixResult<MatrixDeleteMessageResult> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        let client = self.client()?;
        self.runtime.block_on(delete_message_internal(&client, &request))
    }

    pub fn pin_message(&mut self, request: MatrixPinMessageRequest) -> MatrixResult<MatrixPinsResult> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        let client = self.client()?;
        self.runtime.block_on(pin_message_internal(&client, &request))
    }

    pub fn unpin_message(
        &mut self,
        request: MatrixPinMessageRequest,
    ) -> MatrixResult<MatrixPinsResult> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        let client = self.client()?;
        self.runtime.block_on(unpin_message_internal(&client, &request))
    }

    pub fn list_pins(&self, request: MatrixListPinsRequest) -> MatrixResult<MatrixPinsResult> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        let client = self.client()?;
        self.runtime.block_on(list_pins_internal(&client, &request))
    }

    pub fn member_info(&self, request: MatrixMemberInfoRequest) -> MatrixResult<MatrixMemberInfo> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        let client = self.client()?;
        self.runtime
            .block_on(member_info_internal(&client, &request.room_id, &request.user_id))
    }

    pub fn channel_info(
        &self,
        request: MatrixChannelInfoRequest,
    ) -> MatrixResult<MatrixChannelInfo> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        let client = self.client()?;
        self.runtime
            .block_on(channel_info_internal(&client, &request.room_id))
    }

    pub fn upload_media(
        &mut self,
        request: MatrixUploadMediaRequest,
    ) -> MatrixResult<MatrixUploadMediaResult> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        let client = self.client()?;
        let (room, resolved_target) = self
            .runtime
            .block_on(resolve_room_for_send(&client, &request.room_id))?;
        let message_id = self.runtime.block_on(media::upload_media(&room, &request))?;
        Ok(MatrixUploadMediaResult {
            room_id: resolved_target.resolved_room_id,
            message_id,
            filename: request.filename,
            content_type: request.content_type,
        })
    }

    pub fn download_media(
        &self,
        request: MatrixDownloadMediaRequest,
    ) -> MatrixResult<MatrixDownloadMediaResult> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        let client = self.client()?;
        self.runtime
            .block_on(download_media_internal(&client, &request.room_id, &request.event_id))
    }

    pub fn react_message(&mut self, request: MatrixReactRequest) -> MatrixResult<MatrixReactResult> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        let client = self.client()?;
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| MatrixError::State("client config is unavailable".to_string()))?;
        let sender_id = self
            .client()?
            .user_id()
            .map(|user_id| user_id.to_string())
            .unwrap_or_else(|| self.shared.diagnostics().user_id);
        self.runtime.block_on(react_message_internal(
            &client,
            config,
            &request,
            &sender_id,
        ))
    }

    pub fn list_reactions(
        &self,
        request: MatrixListReactionsRequest,
    ) -> MatrixResult<Vec<MatrixReactionSummary>> {
        let client = self.client()?;
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| MatrixError::State("client config is unavailable".to_string()))?;
        self.runtime
            .block_on(list_reactions_internal(&client, config, &request))
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

    pub fn resolve_link_previews(
        &self,
        request: MatrixResolveLinkPreviewsRequest,
    ) -> MatrixResult<MatrixLinkPreviewResult> {
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| MatrixError::State("client config is unavailable".to_string()))?;
        let access_token = self
            .client()?
            .session_tokens()
            .map(|tokens| tokens.access_token)
            .ok_or_else(|| MatrixError::State("matrix session is unavailable".to_string()))?;
        self.runtime
            .block_on(previews::resolve_link_previews(config, &access_token, &request))
    }

    pub fn set_typing(&mut self, request: MatrixTypingRequest) -> MatrixResult<()> {
        if !self.running {
            return Err(MatrixError::State("client is not running".to_string()));
        }
        let client = self.client()?;
        let (room, _) = self
            .runtime
            .block_on(resolve_room_for_send(&client, &request.room_id))?;
        self.runtime
            .block_on(async { room.typing_notice(request.typing).await })?;
        Ok(())
    }

    fn release_client(&self, client: Client) {
        self.runtime.block_on(async move {
            drop(client);
        });
    }

    fn client(&self) -> MatrixResult<Client> {
        self.client_slot
            .lock()
            .expect("matrix client slot mutex poisoned")
            .as_ref()
            .cloned()
            .ok_or_else(|| MatrixError::State("client is not initialized".to_string()))
    }
}

fn register_inbound_handler(client: &Client, shared: Arc<SharedState>) {
    client.add_event_handler(move |event: OriginalSyncRoomMessageEvent, room: Room| {
        let shared = shared.clone();
        async move {
            if let Some(inbound) = events::normalize_inbound_event(&room, &event).await {
                let now = Utc::now();
                shared.update_diagnostics(|diagnostics| {
                    diagnostics.last_successful_decryption_at = Some(now);
                });
                shared.push_inbound(inbound);
            }
        }
    });
}

fn normalize_target(raw: &str) -> MatrixResult<String> {
    let mut value = raw.trim().to_string();
    if value.is_empty() {
        return Err(MatrixError::State("matrix target is required".to_string()));
    }

    loop {
        let lowered = value.to_ascii_lowercase();
        let stripped = if lowered.starts_with("matrix:") {
            Some(value["matrix:".len()..].trim().to_string())
        } else if lowered.starts_with("room:") {
            Some(value["room:".len()..].trim().to_string())
        } else if lowered.starts_with("channel:") {
            Some(value["channel:".len()..].trim().to_string())
        } else {
            None
        };

        match stripped {
            Some(next) if !next.is_empty() => value = next,
            Some(_) => return Err(MatrixError::State("matrix target is required".to_string())),
            None => break,
        }
    }

    let lowered = value.to_ascii_lowercase();
    if lowered.starts_with("user:") {
        let user = value["user:".len()..].trim();
        if user.is_empty() {
            return Err(MatrixError::State("matrix user target is required".to_string()));
        }
        return Ok(if user.starts_with('@') {
            user.to_string()
        } else {
            format!("@{user}")
        });
    }

    Ok(value)
}

async fn resolve_target_internal(
    client: &Client,
    target: &str,
    create_dm: bool,
) -> MatrixResult<MatrixResolveTargetResult> {
    let normalized = normalize_target(target)?;

    if normalized.starts_with('@') {
        let user_id: OwnedUserId = UserId::parse(normalized.as_str())?.to_owned();
        let room = if let Some(room) = client.get_dm_room(&user_id) {
            room
        } else if create_dm {
            client.create_dm(&user_id).await?
        } else {
            return Err(MatrixError::State(format!(
                "no direct room found for {user_id}"
            )));
        };

        return Ok(MatrixResolveTargetResult {
            input: target.to_string(),
            resolved_room_id: room.room_id().to_string(),
            canonical_target: user_id.to_string(),
            is_direct: true,
            room_alias: room.canonical_alias().map(|value| value.to_string()),
        });
    }

    if normalized.starts_with('#') {
        let alias = RoomAliasId::parse(normalized.as_str())?.to_owned();
        let response = client.resolve_room_alias(&alias).await?;
        let room = client.get_room(&response.room_id);
        let is_direct = match room.as_ref() {
            Some(room) => room.is_direct().await.unwrap_or(false),
            None => false,
        };
        let room_alias = room
            .as_ref()
            .and_then(|value| value.canonical_alias().map(|alias| alias.to_string()))
            .or_else(|| Some(alias.to_string()));
        return Ok(MatrixResolveTargetResult {
            input: target.to_string(),
            resolved_room_id: response.room_id.to_string(),
            canonical_target: alias.to_string(),
            is_direct,
            room_alias,
        });
    }

    let room_id: OwnedRoomId = RoomId::parse(normalized.as_str())?.to_owned();
    let room = client.get_room(&room_id);
    let is_direct = match room.as_ref() {
        Some(room) => room.is_direct().await.unwrap_or(false),
        None => false,
    };
    Ok(MatrixResolveTargetResult {
        input: target.to_string(),
        resolved_room_id: room_id.to_string(),
        canonical_target: room_id.to_string(),
        is_direct,
        room_alias: room
            .as_ref()
            .and_then(|value| value.canonical_alias().map(|alias| alias.to_string())),
    })
}

async fn resolve_room_for_send(
    client: &Client,
    target: &str,
) -> MatrixResult<(Room, MatrixResolveTargetResult)> {
    let resolved = resolve_target_internal(client, target, true).await?;
    let room_id: OwnedRoomId = RoomId::parse(resolved.resolved_room_id.as_str())?.to_owned();

    if let Some(room) = client.get_room(&room_id) {
        if room.state() == RoomState::Joined {
            return Ok((room, resolved));
        }
    }

    let normalized = normalize_target(target)?;
    if normalized.starts_with('@') {
        let room = client
            .get_room(&room_id)
            .ok_or_else(|| MatrixError::State(format!("room {room_id} is not known to the client")))?;
        return Ok((room, resolved));
    }

    let room_or_alias: OwnedRoomOrAliasId = RoomOrAliasId::parse(normalized.as_str())?.to_owned();
    let room = client.join_room_by_id_or_alias(&room_or_alias, &[]).await?;
    Ok((room, resolved))
}

async fn build_message_content(
    config: &MatrixClientConfig,
    room: &Room,
    text: String,
    reply_to_id: Option<&str>,
    thread_id: Option<&str>,
) -> MatrixResult<RoomMessageEventContent> {
    let formatted = emoji::render_text_with_custom_emoji(
        config,
        &text,
        Some(room.room_id().as_str()),
        Utc::now().timestamp_millis(),
    )?;
    let reply = media::build_reply(reply_to_id, thread_id)?;
    if let Some(reply) = reply {
        let base = match formatted {
            Some(formatted) => RoomMessageEventContentWithoutRelation::text_html(text, formatted),
            None => RoomMessageEventContentWithoutRelation::text_plain(text),
        };
        return room
            .make_reply_event(base, reply)
            .await
            .map_err(|err| MatrixError::State(format!("failed to build reply metadata: {err}")));
    }
    Ok(match formatted {
        Some(formatted) => RoomMessageEventContent::text_html(text, formatted),
        None => RoomMessageEventContent::text_plain(text),
    })
}

fn build_message_edit_content(
    config: &MatrixClientConfig,
    room: &Room,
    text: &str,
) -> MatrixResult<RoomMessageEventContentWithoutRelation> {
    let formatted = emoji::render_text_with_custom_emoji(
        config,
        text,
        Some(room.room_id().as_str()),
        Utc::now().timestamp_millis(),
    )?;
    Ok(match formatted {
        Some(formatted) => RoomMessageEventContentWithoutRelation::text_html(text, formatted),
        None => RoomMessageEventContentWithoutRelation::text_plain(text),
    })
}

async fn join_room_internal(client: &Client, target: &str) -> MatrixResult<MatrixJoinResult> {
    let normalized = normalize_target(target)?;
    if normalized.starts_with('@') {
        let resolved = resolve_target_internal(client, target, true).await?;
        return Ok(MatrixJoinResult {
            room_id: resolved.resolved_room_id,
            joined: true,
        });
    }

    let room_or_alias: OwnedRoomOrAliasId = RoomOrAliasId::parse(normalized.as_str())?.to_owned();
    let room_id_before = if normalized.starts_with('!') {
        Some(RoomId::parse(normalized.as_str())?.to_owned())
    } else {
        None
    };
    if let Some(room_id) = room_id_before.as_ref() {
        if let Some(room) = client.get_room(room_id) {
            if room.state() == RoomState::Joined {
                return Ok(MatrixJoinResult {
                    room_id: room.room_id().to_string(),
                    joined: true,
                });
            }
        }
    }

    let room = client.join_room_by_id_or_alias(&room_or_alias, &[]).await?;
    Ok(MatrixJoinResult {
        room_id: room.room_id().to_string(),
        joined: room.state() == RoomState::Joined,
    })
}

async fn read_messages_internal(
    client: &Client,
    request: &MatrixReadMessagesRequest,
) -> MatrixResult<MatrixReadMessagesResult> {
    let resolved_room_id = resolve_target_internal(client, &request.room_id, false)
        .await?
        .resolved_room_id;
    let room_id: OwnedRoomId = RoomId::parse(resolved_room_id.as_str())?.to_owned();
    let room = client
        .get_room(&room_id)
        .ok_or_else(|| MatrixError::State(format!("room {room_id} is not known to the client")))?;
    let token = request
        .after
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            request
                .before
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        });
    let mut options = if request
        .after
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        MessagesOptions::forward()
    } else {
        MessagesOptions::backward()
    };
    if let Some(token) = token.as_deref() {
        options = options.from(token);
    }
    if let Some(limit) = request.limit {
        let clamped = limit.clamp(1, 1000) as u64;
        options.limit = UInt::try_from(clamped)
            .map_err(|_| MatrixError::State(format!("invalid message limit: {clamped}")))?;
    }
    let response = room.messages(options).await?;
    let messages = response
        .chunk
        .iter()
        .filter_map(events::summarize_timeline_event)
        .collect();

    Ok(MatrixReadMessagesResult {
        messages,
        next_batch: response.end,
        prev_batch: Some(response.start),
    })
}

async fn edit_message_internal(
    client: &Client,
    config: &MatrixClientConfig,
    request: &MatrixEditMessageRequest,
) -> MatrixResult<MatrixEditMessageResult> {
    let trimmed = request.text.trim();
    if trimmed.is_empty() {
        return Err(MatrixError::State("matrix edit requires content".to_string()));
    }
    let (room, resolved_target) = resolve_room_for_send(client, &request.room_id).await?;
    let message_id = EventId::parse(request.message_id.trim())?.to_owned();
    let content = room
        .make_edit_event(
            &message_id,
            EditedContent::RoomMessage(build_message_edit_content(config, &room, trimmed)?),
        )
        .await
        .map_err(|err| MatrixError::State(format!("failed to build matrix edit event: {err}")))?;
    let response = room.send(content).await?;

    Ok(MatrixEditMessageResult {
        room_id: resolved_target.resolved_room_id,
        message_id: message_id.to_string(),
        event_id: response.event_id.to_string(),
    })
}

async fn delete_message_internal(
    client: &Client,
    request: &MatrixDeleteMessageRequest,
) -> MatrixResult<MatrixDeleteMessageResult> {
    let (room, resolved_target) = resolve_room_for_send(client, &request.room_id).await?;
    let message_id = EventId::parse(request.message_id.trim())?.to_owned();
    let response = room
        .redact(&message_id, request.reason.as_deref(), None)
        .await?;

    Ok(MatrixDeleteMessageResult {
        room_id: resolved_target.resolved_room_id,
        message_id: message_id.to_string(),
        event_id: response.event_id.to_string(),
    })
}

async fn read_pinned_events(room: &Room) -> MatrixResult<Vec<OwnedEventId>> {
    let Some(raw) = room
        .get_state_event_static::<RoomPinnedEventsEventContent>()
        .await?
    else {
        return Ok(Vec::new());
    };
    let event = raw
        .deserialize()
        .map_err(|err| MatrixError::State(format!("failed to decode pinned events: {err}")))?;
    Ok(match event {
        SyncOrStrippedState::Sync(ev) => ev
            .as_original()
            .map(|value| value.content.pinned.clone())
            .unwrap_or_default(),
        SyncOrStrippedState::Stripped(ev) => ev.content.pinned.unwrap_or_default(),
    })
}

async fn summarize_pinned_events(room: &Room, pinned: &[OwnedEventId]) -> Vec<crate::api::MatrixMessageSummary> {
    let mut output = Vec::new();
    for event_id in pinned {
        let Ok(event) = room.load_or_fetch_event(event_id, None).await else {
            continue;
        };
        if let Some(summary) = events::summarize_timeline_event(&event) {
            output.push(summary);
        }
    }
    output
}

async fn update_pins_internal(
    client: &Client,
    request: &MatrixPinMessageRequest,
    update: impl FnOnce(Vec<OwnedEventId>, OwnedEventId) -> Vec<OwnedEventId>,
) -> MatrixResult<MatrixPinsResult> {
    let (room, resolved_target) = resolve_room_for_send(client, &request.room_id).await?;
    let message_id = EventId::parse(request.message_id.trim())?.to_owned();
    let next = update(read_pinned_events(&room).await?, message_id);
    room.send_state_event(RoomPinnedEventsEventContent::new(next.clone()))
        .await?;
    let events = summarize_pinned_events(&room, &next).await;

    Ok(MatrixPinsResult {
        room_id: resolved_target.resolved_room_id,
        pinned: next.into_iter().map(|value| value.to_string()).collect(),
        events,
    })
}

async fn pin_message_internal(
    client: &Client,
    request: &MatrixPinMessageRequest,
) -> MatrixResult<MatrixPinsResult> {
    update_pins_internal(client, request, |current, message_id| {
        if current.iter().any(|value| value == &message_id) {
            current
        } else {
            let mut next = current;
            next.push(message_id);
            next
        }
    })
    .await
}

async fn unpin_message_internal(
    client: &Client,
    request: &MatrixPinMessageRequest,
) -> MatrixResult<MatrixPinsResult> {
    update_pins_internal(client, request, |current, message_id| {
        current
            .into_iter()
            .filter(|value| value != &message_id)
            .collect()
    })
    .await
}

async fn list_pins_internal(
    client: &Client,
    request: &MatrixListPinsRequest,
) -> MatrixResult<MatrixPinsResult> {
    let resolved_room_id = resolve_target_internal(client, &request.room_id, false)
        .await?
        .resolved_room_id;
    let room_id: OwnedRoomId = RoomId::parse(resolved_room_id.as_str())?.to_owned();
    let room = client
        .get_room(&room_id)
        .ok_or_else(|| MatrixError::State(format!("room {room_id} is not known to the client")))?;
    let pinned = read_pinned_events(&room).await?;
    let events = summarize_pinned_events(&room, &pinned).await;

    Ok(MatrixPinsResult {
        room_id: resolved_room_id,
        pinned: pinned.into_iter().map(|value| value.to_string()).collect(),
        events,
    })
}

async fn member_info_internal(
    client: &Client,
    room_id: &str,
    user_id: &str,
) -> MatrixResult<MatrixMemberInfo> {
    let room_id: OwnedRoomId = RoomId::parse(room_id.trim())?.to_owned();
    let user_id: OwnedUserId = UserId::parse(user_id.trim())?.to_owned();
    let room = client
        .get_room(&room_id)
        .ok_or_else(|| MatrixError::State(format!("room {room_id} is not known to the client")))?;
    let member = room.get_member(&user_id).await?;
    let self_user_id = client
        .user_id()
        .ok_or_else(|| MatrixError::State("matrix session is unavailable".to_string()))?;

    Ok(MatrixMemberInfo {
        room_id: room.room_id().to_string(),
        user_id: user_id.to_string(),
        display_name: member.as_ref().map(|value| value.name().to_string()),
        avatar_url: member
            .as_ref()
            .and_then(|value| value.avatar_url().map(|avatar| avatar.to_string())),
        membership: member
            .as_ref()
            .map(|value| format!("{:?}", value.membership()).to_lowercase()),
        is_self: user_id == self_user_id,
        is_direct: room.is_direct().await.unwrap_or(false),
    })
}

async fn channel_info_internal(
    client: &Client,
    room_id: &str,
) -> MatrixResult<MatrixChannelInfo> {
    let room_id: OwnedRoomId = RoomId::parse(room_id.trim())?.to_owned();
    let room = client
        .get_room(&room_id)
        .ok_or_else(|| MatrixError::State(format!("room {room_id} is not known to the client")))?;

    Ok(MatrixChannelInfo {
        room_id: room.room_id().to_string(),
        display_name: room.display_name().await.ok().map(|value| value.to_string()),
        canonical_alias: room.canonical_alias().map(|value| value.to_string()),
        alt_aliases: room.alt_aliases().into_iter().map(|value| value.to_string()).collect(),
        joined: room.state() == RoomState::Joined,
        is_direct: room.is_direct().await.unwrap_or(false),
        member_count: Some(room.clone_info().active_members_count() as u64),
    })
}

async fn download_media_internal(
    client: &Client,
    room_id: &str,
    event_id: &str,
) -> MatrixResult<MatrixDownloadMediaResult> {
    let room_id: OwnedRoomId = RoomId::parse(room_id.trim())?.to_owned();
    let event_id = matrix_sdk::ruma::EventId::parse(event_id.trim())?;
    let room = client
        .get_room(&room_id)
        .ok_or_else(|| MatrixError::State(format!("room {room_id} is not known to the client")))?;
    media::download_media(client, &room, &event_id).await
}

#[derive(Debug)]
struct MatrixReactionEvent {
    event_id: String,
    sender_id: String,
    key: String,
}

async fn react_message_internal(
    client: &Client,
    config: &MatrixClientConfig,
    request: &MatrixReactRequest,
    sender_id: &str,
) -> MatrixResult<MatrixReactResult> {
    let (room, resolved_target) = resolve_room_for_send(client, &request.room_id).await?;
    let message_id = EventId::parse(request.message_id.trim())?.to_owned();
    let reaction = reactions::resolve_reaction_key_info(
        config,
        &request.key,
        Some(resolved_target.resolved_room_id.as_str()),
        Utc::now().timestamp_millis(),
    )?;

    if request.remove.unwrap_or(false) {
        let events = fetch_reaction_events(&room, &message_id, 200).await?;
        let mut removed = 0u64;
        for event in events.into_iter().filter(|event| {
            event.sender_id == sender_id && reaction_key_matches(&event.key, &reaction)
        }) {
            room.redact(&EventId::parse(event.event_id.as_str())?, None, None)
                .await?;
            removed += 1;
        }
        return Ok(MatrixReactResult {
            removed,
            reaction: Some(reaction),
        });
    }

    let content = ReactionEventContent::new(Annotation::new(message_id, reaction.raw.clone()));
    let _ = room.send(content).await?;
    if reaction.kind == crate::api::MatrixReactionKeyKind::Custom {
        if let Some(shortcode) = reaction.shortcode.as_ref() {
            emoji::record_usage(
                config,
                &crate::api::MatrixCustomEmojiUsageRequest {
                    emoji: vec![crate::api::MatrixCustomEmojiRef {
                        shortcode: shortcode.clone(),
                        mxc_url: reaction.normalized.clone(),
                    }],
                    room_id: Some(resolved_target.resolved_room_id),
                    observed_at_ms: Some(Utc::now().timestamp_millis()),
                },
            )?;
        }
    }

    Ok(MatrixReactResult {
        removed: 0,
        reaction: Some(reaction),
    })
}

async fn list_reactions_internal(
    client: &Client,
    config: &MatrixClientConfig,
    request: &MatrixListReactionsRequest,
) -> MatrixResult<Vec<MatrixReactionSummary>> {
    let room_id = resolve_target_internal(client, &request.room_id, false)
        .await?
        .resolved_room_id;
    let room_id_owned: OwnedRoomId = RoomId::parse(room_id.as_str())?.to_owned();
    let room = client
        .get_room(&room_id_owned)
        .ok_or_else(|| MatrixError::State(format!("room {room_id_owned} is not known to the client")))?;
    let message_id = EventId::parse(request.message_id.trim())?.to_owned();
    let events = fetch_reaction_events(&room, &message_id, request.limit.unwrap_or(100)).await?;
    let mut summaries = std::collections::BTreeMap::<String, MatrixReactionSummary>::new();

    for event in events {
        let info = reactions::resolve_reaction_key_info(
            config,
            &event.key,
            Some(room_id.as_str()),
            Utc::now().timestamp_millis(),
        )?;
        let summary = summaries
            .entry(info.normalized.clone())
            .or_insert(MatrixReactionSummary {
                key: info.raw.clone(),
                normalized_key: info.normalized.clone(),
                display: info.display.clone(),
                kind: info.kind,
                shortcode: info.shortcode.clone(),
                count: 0,
                users: Vec::new(),
                raw_keys: Vec::new(),
            });
        summary.count += 1;
        if !summary.users.iter().any(|user| user == &event.sender_id) {
            summary.users.push(event.sender_id.clone());
        }
        if !summary.raw_keys.iter().any(|key| key == &event.key) {
            summary.raw_keys.push(event.key.clone());
        }
    }

    let mut output = summaries.into_values().collect::<Vec<_>>();
    output.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.display.cmp(&right.display))
    });
    if let Some(limit) = request.limit {
        output.truncate(limit);
    }
    Ok(output)
}

async fn fetch_reaction_events(
    room: &Room,
    message_id: &EventId,
    limit: usize,
) -> MatrixResult<Vec<MatrixReactionEvent>> {
    let options = RelationsOptions {
        dir: Direction::Backward,
        limit: Some((limit.min(1000) as u32).into()),
        include_relations: IncludeRelations::RelationsOfTypeAndEventType(
            RelationType::Annotation,
            TimelineEventType::Reaction,
        ),
        recurse: false,
        from: None,
    };
    let relations = room.relations(message_id.to_owned(), options).await?;
    let mut output = Vec::new();

    for timeline_event in relations.chunk {
        let raw = timeline_event.into_raw();
        let event: AnySyncTimelineEvent = raw.deserialize().map_err(|err| {
            MatrixError::State(format!("failed to deserialize reaction event: {err}"))
        })?;
        let AnySyncTimelineEvent::MessageLike(message_like) = event else {
            continue;
        };
        let AnySyncMessageLikeEvent::Reaction(_) = message_like else {
            continue;
        };
        let value: Value = raw.deserialize_as_unchecked().map_err(|err| {
            MatrixError::State(format!("failed to decode reaction payload: {err}"))
        })?;
        let key = value
            .get("m.relates_to")
            .and_then(|value| value.get("key"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let sender_id = value
            .get("sender")
            .and_then(Value::as_str)
            .map(str::to_string);
        let event_id = value
            .get("event_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let (Some(key), Some(sender_id), Some(event_id)) = (key, sender_id, event_id) else {
            continue;
        };
        output.push(MatrixReactionEvent {
            event_id,
            sender_id,
            key,
        });
    }

    Ok(output)
}

fn reaction_key_matches(key: &str, info: &crate::api::MatrixReactionInfo) -> bool {
    key == info.raw
        || key == info.normalized
        || info.shortcode.as_deref() == Some(key)
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

fn install_session_callbacks(client: &Client, config: &MatrixClientConfig) -> MatrixResult<()> {
    let save_config = config.clone();
    let reload_config = config.clone();
    client.set_session_callbacks(
        Box::new(move |_client| {
            let Some(stored) = session::load_session(&reload_config)
                .map_err(session_callback_error)?
            else {
                return Err(session_callback_error(MatrixError::State(
                    "persisted matrix session is unavailable".to_string(),
                )));
            };
            Ok(SessionTokens {
                access_token: stored.access_token,
                refresh_token: stored.refresh_token,
            })
        }),
        Box::new(move |client| {
            let previous = state::read_json::<StoredSession>(&save_config.state_layout.session_file)
                .map_err(session_callback_error)?;
            session::persist_client_session(&save_config, &client, previous.as_ref(), None)
                .map(|_| ())
                .map_err(session_callback_error)
        }),
    )?;
    Ok(())
}

fn session_callback_error(
    err: impl std::fmt::Display,
) -> Box<dyn std::error::Error + Send + Sync> {
    Box::new(std::io::Error::other(err.to_string()))
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

    login_with_password(client, config, existing_session, password, shared).await
}

async fn login_with_password(
    client: &Client,
    config: &MatrixClientConfig,
    existing_session: Option<&StoredSession>,
    password: &str,
    shared: &Arc<SharedState>,
) -> MatrixResult<StoredSession> {
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

async fn run_sync_loop(
    mut client: Client,
    config: MatrixClientConfig,
    mut stored_session: StoredSession,
    shared: Arc<SharedState>,
    client_slot: Arc<Mutex<Option<Client>>>,
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

                if is_authentication_expired(&err) {
                    match recover_sync_client(
                        &config,
                        &shared,
                        &client_slot,
                        &client,
                        &stored_session,
                    )
                    .await
                    {
                        Ok((replacement_client, replacement_session, replacement_sync_token)) => {
                            client = replacement_client;
                            stored_session = replacement_session;
                            sync_token = Some(replacement_sync_token);
                            continue;
                        }
                        Err(recovery_err) => {
                            shared.push_lifecycle(
                                NativeLifecycleStage::RestoreOrLogin,
                                format!("session recovery failed: {recovery_err}"),
                            );
                        }
                    }
                }

                tokio::select! {
                    _ = wait_for_stop(&mut stop_rx) => break,
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                }
            }
        }
    }
}

fn is_authentication_expired(err: &MatrixSdkError) -> bool {
    match err {
        MatrixSdkError::Http(http_err) => is_authentication_http_error(http_err.as_ref()),
        _ => false,
    }
}

fn is_authentication_failure(err: &MatrixError) -> bool {
    match err {
        MatrixError::MatrixSdk(inner) => is_authentication_expired(inner),
        MatrixError::Http(inner) => is_authentication_http_error(inner),
        _ => false,
    }
}

fn is_authentication_http_error(err: &HttpError) -> bool {
    matches!(
        err.client_api_error_kind(),
        Some(matrix_sdk::ruma::api::client::error::ErrorKind::UnknownToken { .. })
    ) || matches!(
        err,
        HttpError::RefreshToken(RefreshTokenError::RefreshTokenRequired)
            | HttpError::RefreshToken(RefreshTokenError::MatrixAuth(_))
    )
}

async fn recover_sync_client(
    config: &MatrixClientConfig,
    shared: &Arc<SharedState>,
    client_slot: &Arc<Mutex<Option<Client>>>,
    current_client: &Client,
    stored_session: &StoredSession,
) -> MatrixResult<(Client, StoredSession, String)> {
    let password = match &config.auth {
        MatrixAuthConfig::Password { password } => password.as_str(),
        MatrixAuthConfig::AccessToken { .. } => {
            return Err(MatrixError::State(
                "matrix session expired and no password auth is configured for recovery".to_string(),
            ))
        }
    };

    shared.set_sync_state(MatrixSyncState::Starting);
    shared.push_lifecycle(
        NativeLifecycleStage::RestoreOrLogin,
        format!(
            "session expired for {}; re-authenticating with device {}",
            stored_session.user_id, stored_session.device_id
        ),
    );

    let replacement_client = build_client(config).await?;
    install_session_callbacks(&replacement_client, config)?;
    let replacement_session =
        login_with_password(&replacement_client, config, Some(stored_session), password, shared).await?;
    shared.push_lifecycle(
        NativeLifecycleStage::PersistSession,
        format!("persisted matrix session at {}", config.state_layout.session_file),
    );
    let replacement_sync_token =
        initial_sync(&replacement_client, config, &replacement_session, shared).await?;
    register_inbound_handler(&replacement_client, shared.clone());

    let old_client = {
        let mut slot = client_slot.lock().expect("matrix client slot mutex poisoned");
        slot.replace(replacement_client.clone())
    };
    if let Some(old_client) = old_client {
        drop(old_client);
    } else {
        drop(current_client.clone());
    }

    Ok((replacement_client, replacement_session, replacement_sync_token))
}

async fn recover_startup_client(
    config: &MatrixClientConfig,
    shared: &Arc<SharedState>,
    current_client: Client,
    stored_session: &StoredSession,
) -> MatrixResult<(Client, StoredSession, String)> {
    let password = match &config.auth {
        MatrixAuthConfig::Password { password } => password.as_str(),
        MatrixAuthConfig::AccessToken { .. } => {
            return Err(MatrixError::State(
                "matrix session expired and no password auth is configured for recovery".to_string(),
            ))
        }
    };

    shared.push_lifecycle(
        NativeLifecycleStage::RestoreOrLogin,
        format!(
            "startup session expired for {}; re-authenticating with device {}",
            stored_session.user_id, stored_session.device_id
        ),
    );

    drop(current_client);

    let replacement_client = build_client(config).await?;
    install_session_callbacks(&replacement_client, config)?;
    let replacement_session =
        login_with_password(&replacement_client, config, Some(stored_session), password, shared).await?;
    shared.push_lifecycle(
        NativeLifecycleStage::PersistSession,
        format!("persisted matrix session at {}", config.state_layout.session_file),
    );
    let replacement_sync_token =
        initial_sync(&replacement_client, config, &replacement_session, shared).await?;

    Ok((replacement_client, replacement_session, replacement_sync_token))
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
    use std::{fs, path::PathBuf, time::Duration};

    use tokio::runtime::Runtime;
    use uuid::Uuid;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_partial_json, header, method, path, query_param},
    };

    use crate::{
        api::{MatrixAuthConfig, MatrixClientConfig, MatrixStateLayout, MatrixSyncState, StoredSession},
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
        mount_login_response(server, "token-1", "refresh-1", 1).await;
    }

    async fn mount_login_response(
        server: &MockServer,
        access_token: &str,
        refresh_token: &str,
        priority: u8,
    ) {
        mount_versions(server).await;

        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/login"))
            .and(header("content-type", "application/json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user_id": "@bot:example.org",
                "device_id": "OCLAWDEVICE",
                "access_token": access_token,
                "refresh_token": refresh_token
            })))
            .with_priority(priority)
            .up_to_n_times(1)
            .mount(server)
            .await;

        Mock::given(method("POST"))
            .and(path("/_matrix/client/r0/login"))
            .and(header("content-type", "application/json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user_id": "@bot:example.org",
                "device_id": "OCLAWDEVICE",
                "access_token": access_token,
                "refresh_token": refresh_token
            })))
            .with_priority(priority)
            .up_to_n_times(1)
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
        mount_sync_for_token(server, "token-1", since, next_batch).await;
    }

    async fn mount_sync_for_token(
        server: &MockServer,
        access_token: &str,
        since: Option<&str>,
        next_batch: &str,
    ) {
        let mock = Mock::given(method("GET"))
            .and(path("/_matrix/client/v3/sync"))
            .and(header("authorization", format!("Bearer {access_token}")))
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
            .and(header("authorization", format!("Bearer {access_token}")))
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

    #[test]
    fn relogs_after_refresh_token_rejection() {
        let root = unique_root();
        let runtime = Runtime::new().unwrap();
        let server = runtime.block_on(MockServer::start());
        runtime.block_on(mount_login_response(&server, "token-1", "refresh-1", 1));
        runtime.block_on(mount_login_response(&server, "token-2", "refresh-2", 2));
        runtime.block_on(mount_sync_for_token(&server, "token-1", None, "next-1"));
        runtime.block_on(mount_sync_for_token(&server, "token-2", Some("next-1"), "next-2"));
        runtime.block_on(async {
            Mock::given(method("GET"))
                .and(path("/_matrix/client/v3/sync"))
                .and(header("authorization", "Bearer token-2"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "next_batch": "steady",
                    "rooms": {},
                    "presence": {},
                    "account_data": {},
                    "to_device": {},
                    "device_lists": {},
                    "device_one_time_keys_count": {}
                })))
                .with_priority(10)
                .mount(&server)
                .await;
        });
        runtime.block_on(async {
            Mock::given(method("GET"))
                .and(path("/_matrix/client/v3/sync"))
                .and(header("authorization", "Bearer token-1"))
                .and(query_param("since", "next-1"))
                .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                    "errcode": "M_UNKNOWN_TOKEN",
                    "error": "Expired access token",
                    "soft_logout": false
                })))
                .with_priority(1)
                .up_to_n_times(1)
                .mount(&server)
                .await;

            Mock::given(method("POST"))
                .and(path("/_matrix/client/v3/refresh"))
                .and(body_partial_json(serde_json::json!({
                    "refresh_token": "refresh-1"
                })))
                .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                    "errcode": "M_UNKNOWN_TOKEN",
                    "error": "Invalid refresh token",
                    "soft_logout": false
                })))
                .up_to_n_times(1)
                .mount(&server)
                .await;
        });

        let config = sample_config(&root, &server.uri());
        let mut service = MatrixCoreService::new();
        let started = service.start(config).unwrap();
        assert_eq!(started.sync_state, MatrixSyncState::Ready);

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let (diagnostics, stored) = loop {
            let diagnostics = service.diagnostics();
            let stored = fs::read_to_string(root.join("session.json"))
                .ok()
                .and_then(|value| serde_json::from_str::<StoredSession>(&value).ok());

            if diagnostics.sync_state == MatrixSyncState::Ready
                && stored
                    .as_ref()
                    .is_some_and(|session| session.access_token == "token-2")
            {
                break (diagnostics, stored.unwrap());
            }

            if std::time::Instant::now() >= deadline {
                service.stop();
                panic!(
                    "matrix client did not recover session in time; diagnostics={diagnostics:?} stored={stored:?}"
                );
            }

            std::thread::sleep(Duration::from_millis(100));
        };
        service.stop();

        assert_eq!(diagnostics.device_id, "OCLAWDEVICE");
        assert_eq!(diagnostics.sync_state, MatrixSyncState::Ready);
        assert_eq!(stored.access_token, "token-2");
        assert_eq!(stored.refresh_token.as_deref(), Some("refresh-2"));
        assert_ne!(stored.sync_token.as_deref(), Some("next-1"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovers_expired_session_during_startup_initial_sync() {
        let root = unique_root();
        let runtime = Runtime::new().unwrap();
        let server = runtime.block_on(MockServer::start());
        runtime.block_on(mount_login_response(&server, "token-1", "refresh-1", 1));
        runtime.block_on(mount_sync_for_token(&server, "token-1", None, "next-1"));

        let config = sample_config(&root, &server.uri());
        let mut first = MatrixCoreService::new();
        let first_diagnostics = first.start(config.clone()).unwrap();
        first.stop();

        assert_eq!(first_diagnostics.sync_state, MatrixSyncState::Ready);

        runtime.block_on(mount_login_response(&server, "token-2", "refresh-2", 2));
        runtime.block_on(async {
            Mock::given(method("GET"))
                .and(path("/_matrix/client/v3/sync"))
                .and(header("authorization", "Bearer token-2"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "next_batch": "startup-steady",
                    "rooms": {},
                    "presence": {},
                    "account_data": {},
                    "to_device": {},
                    "device_lists": {},
                    "device_one_time_keys_count": {}
                })))
                .with_priority(10)
                .mount(&server)
                .await;

            Mock::given(method("GET"))
                .and(path("/_matrix/client/v3/sync"))
                .and(header("authorization", "Bearer token-1"))
                .and(query_param("since", "next-1"))
                .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                    "errcode": "M_UNKNOWN_TOKEN",
                    "error": "Expired access token",
                    "soft_logout": false
                })))
                .with_priority(1)
                .up_to_n_times(1)
                .mount(&server)
                .await;

            Mock::given(method("POST"))
                .and(path("/_matrix/client/v3/refresh"))
                .and(body_partial_json(serde_json::json!({
                    "refresh_token": "refresh-1"
                })))
                .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                    "errcode": "M_UNKNOWN_TOKEN",
                    "error": "Invalid refresh token",
                    "soft_logout": false
                })))
                .up_to_n_times(1)
                .mount(&server)
                .await;
        });

        let mut recovered = MatrixCoreService::new();
        let diagnostics = recovered.start(config).unwrap();
        recovered.stop();

        let stored = fs::read_to_string(root.join("session.json")).unwrap();
        let stored: StoredSession = serde_json::from_str(&stored).unwrap();

        assert_eq!(diagnostics.sync_state, MatrixSyncState::Ready);
        assert_eq!(diagnostics.device_id, "OCLAWDEVICE");
        assert_eq!(stored.access_token, "token-2");
        assert_eq!(stored.refresh_token.as_deref(), Some("refresh-2"));

        fs::remove_dir_all(root).unwrap();
    }
}
