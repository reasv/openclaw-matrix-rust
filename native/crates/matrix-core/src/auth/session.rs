use chrono::Utc;
use uuid::Uuid;

use crate::{
    api::{MatrixAuthConfig, MatrixClientConfig, StoredSession},
    state,
    MatrixError, MatrixResult,
};

pub fn load_or_create_session(config: &MatrixClientConfig) -> MatrixResult<StoredSession> {
    if let Some(mut existing) = state::read_json::<StoredSession>(&config.state_layout.session_file)? {
        if existing.user_id != config.user_id {
            return Err(MatrixError::State(format!(
                "persisted session user {} does not match requested user {}",
                existing.user_id, config.user_id
            )));
        }
        existing.updated_at = Utc::now();
        state::write_json(&config.state_layout.session_file, &existing)?;
        return Ok(existing);
    }

    let now = Utc::now();
    let device_id = format!("OCLAW{}", Uuid::new_v4().simple()).chars().take(12).collect();
    let auth_mode = match &config.auth {
        MatrixAuthConfig::Password { .. } => "password",
        MatrixAuthConfig::AccessToken { .. } => "accessToken",
    }
    .to_string();

    let session = StoredSession {
        account_id: config.account_id.clone(),
        homeserver: config.homeserver.clone(),
        user_id: config.user_id.clone(),
        device_id,
        created_at: now,
        updated_at: now,
        auth_mode,
    };
    state::write_json(&config.state_layout.session_file, &session)?;
    Ok(session)
}
