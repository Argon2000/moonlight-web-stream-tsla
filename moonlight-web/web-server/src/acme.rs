use actix_web::{
    HttpResponse, Responder,
    dev::HttpServiceFactory,
    get, put, delete,
    web::{self, Data, Path},
};
use log::info;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Directory where Win-ACME (or other tools) write challenge files.
/// Win-ACME creates .well-known/acme-challenge/{token} under the site root.
const ACME_CHALLENGE_DIR: &str = "./.well-known/acme-challenge";

/// Maximum allowed key authorization length (token.thumbprint is ~87 chars)
const MAX_KEY_AUTH_LEN: usize = 256;
/// Maximum number of pending challenges stored in memory at once
const MAX_CHALLENGES: usize = 10;

/// Key: token (the filename in .well-known/acme-challenge/{token})
/// Value: key authorization (token.thumbprint)
pub type AcmeChallengeStore = Arc<RwLock<HashMap<String, String>>>;

pub fn new_challenge_store() -> AcmeChallengeStore {
    Arc::new(RwLock::new(HashMap::new()))
}

/// Serves the ACME HTTP-01 challenge response.
/// Let's Encrypt will request: GET http://domain/.well-known/acme-challenge/{token}
/// Checks in-memory store first, then falls back to reading from disk.
#[get("/{token}")]
async fn get_challenge(
    token: Path<String>,
    store: Data<AcmeChallengeStore>,
) -> impl Responder {
    // Reject path traversal attempts
    if token.contains("..") || token.contains('/') || token.contains('\\') {
        return HttpResponse::BadRequest().body("Invalid token");
    }

    // Check in-memory store first (API-based flow)
    let store = store.read().await;
    if let Some(key_auth) = store.get(token.as_str()) {
        info!("[ACME] Served challenge from memory for token: {}", token.as_str());
        return HttpResponse::Ok()
            .content_type("text/plain")
            .body(key_auth.clone());
    }
    drop(store);

    // Fallback: check filesystem (Win-ACME "save to path" flow)
    let file_path = std::path::Path::new(ACME_CHALLENGE_DIR).join(token.as_str());
    match tokio::fs::read_to_string(&file_path).await {
        Ok(content) => {
            info!("[ACME] Served challenge from file for token: {}", token.as_str());
            HttpResponse::Ok()
                .content_type("text/plain")
                .body(content.trim().to_string())
        }
        Err(_) => {
            info!("[ACME] Challenge not found for token: {}", token.as_str());
            HttpResponse::NotFound().body("Challenge not found")
        }
    }
}

/// API endpoint to set a challenge token.
/// PUT /api/acme/challenge/{token} with the key authorization as plain text body.
#[put("/{token}")]
async fn put_challenge(
    token: Path<String>,
    body: web::Bytes,
    store: Data<AcmeChallengeStore>,
) -> impl Responder {
    if body.len() > MAX_KEY_AUTH_LEN {
        return HttpResponse::BadRequest().body("Key authorization too long");
    }
    let key_auth = String::from_utf8_lossy(&body).to_string();
    let mut store = store.write().await;
    if store.len() >= MAX_CHALLENGES && !store.contains_key(token.as_str()) {
        return HttpResponse::TooManyRequests().body("Challenge store full");
    }
    info!("[ACME] Set challenge: {} -> {}...", token.as_str(), &key_auth[..key_auth.len().min(30)]);
    store.insert(token.to_string(), key_auth);
    HttpResponse::Ok().body("Challenge set")
}

/// API endpoint to clear a challenge token after validation.
/// DELETE /api/acme/challenge/{token}
#[delete("/{token}")]
async fn delete_challenge(
    token: Path<String>,
    store: Data<AcmeChallengeStore>,
) -> impl Responder {
    let removed = store.write().await.remove(token.as_str()).is_some();
    if removed {
        info!("[ACME] Removed challenge: {}", token.as_str());
        HttpResponse::Ok().body("Challenge removed")
    } else {
        HttpResponse::NotFound().body("Challenge not found")
    }
}

/// The /.well-known/acme-challenge scope — serves challenge responses to the CA.
/// This must be unauthenticated (Let's Encrypt needs open access).
pub fn acme_challenge_service() -> impl HttpServiceFactory {
    web::scope("/.well-known/acme-challenge")
        .service(get_challenge)
}

/// The /api/acme/challenge scope — management endpoints to set/clear tokens.
/// Registered at app level (no auth required — tokens are harmless short-lived strings).
pub fn acme_api_service() -> impl HttpServiceFactory {
    web::scope("/api/acme/challenge")
        .service(put_challenge)
        .service(delete_challenge)
}
