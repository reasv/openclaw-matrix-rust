use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use matrix_sdk::{
    Client,
    authentication::matrix::MatrixSession,
    ruma::{
        OwnedDeviceId, OwnedUserId,
        api::client::session::login,
    },
    store::RoomLoadSettings,
};
use serde::{Deserialize, Serialize};

use crate::{
    api::{MatrixAuthConfig, MatrixClientConfig, StoredSession},
    state, MatrixError, MatrixResult,
};

const ACCESS_TOKEN_REFRESH_SKEW: TimeDelta = TimeDelta::seconds(30);

pub fn auth_mode(config: &MatrixClientConfig) -> &'static str {
    match config.auth {
        MatrixAuthConfig::Password { .. } => "password",
        MatrixAuthConfig::AccessToken { .. } => "accessToken",
    }
}

pub fn load_session(config: &MatrixClientConfig) -> MatrixResult<Option<StoredSession>> {
    let Some(mut existing) = state::read_json::<StoredSession>(&config.state_layout.session_file)? else {
        return Ok(None);
    };

    if existing.account_id != config.account_id {
        return Err(MatrixError::State(format!(
            "persisted session account {} does not match requested account {}",
            existing.account_id, config.account_id
        )));
    }

    if existing.user_id != config.user_id {
        return Err(MatrixError::State(format!(
            "persisted session user {} does not match requested user {}",
            existing.user_id, config.user_id
        )));
    }

    if existing.homeserver != config.homeserver {
        return Err(MatrixError::State(format!(
            "persisted session homeserver {} does not match requested homeserver {}",
            existing.homeserver, config.homeserver
        )));
    }

    existing.updated_at = Utc::now();
    state::write_json(&config.state_layout.session_file, &existing)?;
    Ok(Some(existing))
}

pub async fn restore_session(client: &Client, stored: &StoredSession) -> MatrixResult<()> {
    client
        .matrix_auth()
        .restore_session(stored.to_matrix_session()?, RoomLoadSettings::default())
        .await?;
    Ok(())
}

pub fn persist_client_session(
    config: &MatrixClientConfig,
    client: &Client,
    previous: Option<&StoredSession>,
    sync_token: Option<String>,
) -> MatrixResult<StoredSession> {
    let session = client
        .matrix_auth()
        .session()
        .ok_or_else(|| MatrixError::State("matrix session is unavailable".to_string()))?;
    let stored = StoredSession::from_matrix_session(
        config,
        auth_mode(config),
        session,
        previous.map(|value| value.created_at).unwrap_or_else(Utc::now),
        previous.and_then(|value| value.access_token_expires_at),
        sync_token.or_else(|| previous.and_then(|value| value.sync_token.clone())),
    );
    state::write_json(&config.state_layout.session_file, &stored)?;
    Ok(stored)
}

pub fn persist_login_response(
    config: &MatrixClientConfig,
    response: &login::v3::Response,
    previous: Option<&StoredSession>,
    sync_token: Option<String>,
) -> MatrixResult<StoredSession> {
    persist_matrix_session(
        config,
        auth_mode(config),
        response.into(),
        previous.map(|value| value.created_at).unwrap_or_else(Utc::now),
        expires_at_from_duration(response.expires_in),
        sync_token.or_else(|| previous.and_then(|value| value.sync_token.clone())),
    )
}

pub fn persist_matrix_session(
    config: &MatrixClientConfig,
    auth_mode: &str,
    session: MatrixSession,
    created_at: DateTime<Utc>,
    access_token_expires_at: Option<DateTime<Utc>>,
    sync_token: Option<String>,
) -> MatrixResult<StoredSession> {
    let stored = StoredSession::from_matrix_session(
        config,
        auth_mode,
        session,
        created_at,
        access_token_expires_at,
        sync_token,
    );
    state::write_json(&config.state_layout.session_file, &stored)?;
    Ok(stored)
}

pub async fn refresh_session(
    config: &MatrixClientConfig,
    stored: &StoredSession,
) -> MatrixResult<StoredSession> {
    let refresh_token = stored
        .refresh_token
        .clone()
        .ok_or_else(|| MatrixError::State("matrix session has no refresh token".to_string()))?;
    let endpoint = format!("{}/_matrix/client/v3/refresh", config.homeserver.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(endpoint)
        .json(&RefreshRequest { refresh_token })
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let payload = response.text().await?;
        let detail = serde_json::from_str::<MatrixClientError>(&payload)
            .map(|error| format!("[{status} / {}] {}", error.errcode, error.error))
            .unwrap_or_else(|_| format!("[{status}] {payload}"));
        return Err(MatrixError::State(format!("the server returned an error: {detail}")));
    }

    let payload: RefreshResponse = response.json().await?;
    let refreshed_session = MatrixSession {
        meta: stored.to_matrix_session()?.meta,
        tokens: matrix_sdk::SessionTokens {
            access_token: payload.access_token,
            refresh_token: payload.refresh_token.or_else(|| stored.refresh_token.clone()),
        },
    };

    persist_matrix_session(
        config,
        &stored.auth_mode,
        refreshed_session,
        stored.created_at,
        expires_at_from_duration(payload.expires_in_ms.map(Duration::from_millis)),
        stored.sync_token.clone(),
    )
}

fn expires_at_from_duration(expires_in: Option<Duration>) -> Option<DateTime<Utc>> {
    expires_in
        .and_then(|duration| TimeDelta::from_std(duration).ok())
        .map(|duration| Utc::now() + duration)
}

#[derive(Deserialize)]
struct MatrixClientError {
    errcode: String,
    error: String,
}

#[derive(Serialize)]
struct RefreshRequest {
    refresh_token: String,
}

#[derive(Deserialize)]
struct RefreshResponse {
    access_token: String,
    refresh_token: Option<String>,
    #[serde(default, rename = "expires_in_ms")]
    expires_in_ms: Option<u64>,
}

impl StoredSession {
    pub fn to_matrix_session(&self) -> MatrixResult<MatrixSession> {
        let user_id: OwnedUserId = self.user_id.parse()?;
        let device_id: OwnedDeviceId = self.device_id.clone().into();

        Ok(MatrixSession {
            meta: matrix_sdk::SessionMeta { user_id, device_id },
            tokens: matrix_sdk::SessionTokens {
                access_token: self.access_token.clone(),
                refresh_token: self.refresh_token.clone(),
            },
        })
    }

    pub fn from_matrix_session(
        config: &MatrixClientConfig,
        auth_mode: &str,
        session: MatrixSession,
        created_at: chrono::DateTime<Utc>,
        access_token_expires_at: Option<DateTime<Utc>>,
        sync_token: Option<String>,
    ) -> Self {
        Self {
            account_id: config.account_id.clone(),
            homeserver: config.homeserver.clone(),
            auth_mode: auth_mode.to_string(),
            user_id: session.meta.user_id.to_string(),
            device_id: session.meta.device_id.to_string(),
            access_token: session.tokens.access_token,
            refresh_token: session.tokens.refresh_token,
            access_token_expires_at,
            sync_token,
            created_at,
            updated_at: Utc::now(),
        }
    }

    pub fn should_refresh_before_request(&self) -> bool {
        let Some(refresh_token) = self.refresh_token.as_ref() else {
            return false;
        };
        if refresh_token.is_empty() {
            return false;
        }
        self.access_token_expires_at
            .map(|expires_at| Utc::now() + ACCESS_TOKEN_REFRESH_SKEW >= expires_at)
            .unwrap_or(false)
    }

    pub fn should_bootstrap_expiry_metadata(&self) -> bool {
        self.refresh_token
            .as_ref()
            .is_some_and(|refresh_token| !refresh_token.is_empty())
            && self.access_token_expires_at.is_none()
    }
}
