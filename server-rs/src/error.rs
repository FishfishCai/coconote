// HTTP error model. Spec server.md "Errors":
//   400 path not in space — traversal or absolute path
//   409 stale write       — X-If-Unmodified-Since mismatch
//   403                   — auth failure
//   404                   — not found
//   405                   — read-only vault rejects write

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("not found")]
    NotFound,
    #[error("not allowed")]
    NotAllowed,
    #[error("path not in space")]
    PathOutsideRoot,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Other(String),
}

impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        Error::Other(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
