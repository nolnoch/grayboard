//! Where a request's bearer token comes from (#929 D3).

use crate::error::AuthError;
use futures_util::future::BoxFuture;

/// A source of bearer tokens. The transport calls `token` before every request and every retry, so a credential that re-mints is picked up on the next request.
///
/// The methods return boxed `Send` futures so a `Client` can hold an `Arc<dyn Credential>` and its tasks can be spawned; the shape matches hosted-core's `AuthProvider`.
pub trait Credential: Send + Sync + 'static {
    /// The token for the next request.
    fn token(&self) -> BoxFuture<'_, Result<String, AuthError>>;
    /// The server answered 401 to `rejected`. Return `Ok` once a fresh token is ready (the request is retried once), or an error to fail it as `Unauthorized`.
    fn unauthorized<'a>(&'a self, rejected: &'a str) -> BoxFuture<'a, Result<(), AuthError>>;
}

/// A fixed token: a CI token or a run token a launcher minted (#270's service credential stays with the launcher). A 401 is terminal.
#[derive(Clone)]
pub struct StaticBearer(String);

impl StaticBearer {
    pub fn new(token: impl Into<String>) -> Self {
        Self(token.into())
    }
}

impl std::fmt::Debug for StaticBearer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StaticBearer(..)")
    }
}

impl Credential for StaticBearer {
    fn token(&self) -> BoxFuture<'_, Result<String, AuthError>> {
        let token = self.0.clone();
        Box::pin(async move { Ok(token) })
    }
    fn unauthorized<'a>(&'a self, _rejected: &'a str) -> BoxFuture<'a, Result<(), AuthError>> {
        Box::pin(async {
            Err(AuthError(
                "the server rejected the static bearer token".into(),
            ))
        })
    }
}
