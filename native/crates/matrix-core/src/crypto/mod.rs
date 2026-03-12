use crate::api::{MatrixClientConfig, MatrixKeyBackupState, MatrixVerificationState};

pub fn resolve_verification_state(
    config: &MatrixClientConfig,
) -> (MatrixVerificationState, MatrixKeyBackupState, String) {
    if config.recovery_key.as_deref().is_some_and(|key| !key.trim().is_empty()) {
        (
            MatrixVerificationState::Verified,
            MatrixKeyBackupState::Enabled,
            "recovery key configured; live-device restore should run before sync".to_string(),
        )
    } else {
        (
            MatrixVerificationState::Disabled,
            MatrixKeyBackupState::Disabled,
            "no recovery key configured; verification stays disabled until configured".to_string(),
        )
    }
}
