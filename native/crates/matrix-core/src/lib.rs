mod api;
mod auth;
mod client;
mod crypto;
mod emoji;
mod events;
mod media;
mod previews;
mod reactions;
mod state;
mod sync;

use std::sync::Mutex;

use napi_derive::napi;
use thiserror::Error;

use crate::{
    api::{
        MatrixClientConfig, MatrixCustomEmojiUsageRequest, MatrixListEmojiRequest,
        MatrixListReactionsRequest, MatrixReactRequest, MatrixSendRequest,
    },
    client::MatrixCoreService,
};

type MatrixResult<T> = std::result::Result<T, MatrixError>;

#[derive(Debug, Error)]
enum MatrixError {
    #[error("{0}")]
    State(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Serde(#[from] serde_json::Error),
}

fn to_napi_error(err: MatrixError) -> napi::Error {
    napi::Error::from_reason(err.to_string())
}

#[napi]
pub struct MatrixCoreClient {
    inner: Mutex<MatrixCoreService>,
}

#[napi]
impl MatrixCoreClient {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(MatrixCoreService::new()),
        }
    }

    #[napi]
    pub fn start(&self, config_json: String) -> napi::Result<String> {
        let config: MatrixClientConfig =
            serde_json::from_str(&config_json).map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let mut inner = self.inner.lock().map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let diagnostics = inner.start(config).map_err(to_napi_error)?;
        serde_json::to_string(&diagnostics).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi]
    pub fn stop(&self) -> napi::Result<()> {
        let mut inner = self.inner.lock().map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        inner.stop();
        Ok(())
    }

    #[napi(js_name = "pollEvents")]
    pub fn poll_events(&self) -> napi::Result<String> {
        let mut inner = self.inner.lock().map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let events = inner.poll_events();
        serde_json::to_string(&events).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi]
    pub fn diagnostics(&self) -> napi::Result<String> {
        let inner = self.inner.lock().map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        serde_json::to_string(&inner.diagnostics())
            .map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "sendMessage")]
    pub fn send_message(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixSendRequest =
            serde_json::from_str(&request_json).map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let mut inner = self.inner.lock().map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.send_message(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "reactMessage")]
    pub fn react_message(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixReactRequest =
            serde_json::from_str(&request_json).map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let mut inner = self.inner.lock().map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.react_message(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "listReactions")]
    pub fn list_reactions(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixListReactionsRequest =
            serde_json::from_str(&request_json).map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let inner = self.inner.lock().map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.list_reactions(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }

    #[napi(js_name = "recordCustomEmojiUsage")]
    pub fn record_custom_emoji_usage(&self, request_json: String) -> napi::Result<()> {
        let request: MatrixCustomEmojiUsageRequest =
            serde_json::from_str(&request_json).map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let inner = self.inner.lock().map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        inner.record_custom_emoji_usage(request).map_err(to_napi_error)
    }

    #[napi(js_name = "listKnownShortcodes")]
    pub fn list_known_shortcodes(&self, request_json: String) -> napi::Result<String> {
        let request: MatrixListEmojiRequest =
            serde_json::from_str(&request_json).map_err(|err| napi::Error::from_reason(err.to_string()))?;
        let inner = self.inner.lock().map_err(|_| napi::Error::from_reason("matrix client mutex poisoned"))?;
        let result = inner.list_known_shortcodes(request).map_err(to_napi_error)?;
        serde_json::to_string(&result).map_err(|err| napi::Error::from_reason(err.to_string()))
    }
}
