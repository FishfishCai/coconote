pub mod auth;
pub mod collab;
pub mod config;
pub mod fs;
pub mod health;
pub mod history;
pub mod resolve;
pub mod ssr;

use crate::error::Error;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

/// Map crate::Error -> HTTP (server.md "Errors").
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        match self {
            Error::NotFound => (StatusCode::NOT_FOUND, "not found").into_response(),
            Error::NotAllowed => (StatusCode::METHOD_NOT_ALLOWED, "read-only").into_response(),
            Error::PathOutsideRoot => {
                (StatusCode::BAD_REQUEST, "path not in space").into_response()
            }
            Error::Io(e) => {
                tracing::warn!("io error: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
            }
            Error::BadRequest(s) => (StatusCode::BAD_REQUEST, s).into_response(),
            Error::Other(s) => (StatusCode::INTERNAL_SERVER_ERROR, s).into_response(),
        }
    }
}
