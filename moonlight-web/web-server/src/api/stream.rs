use std::{collections::HashMap, process::Stdio, sync::Arc, time::Duration};

use actix_web::{
    Either, Error, HttpRequest, HttpResponse, get, post, rt as actix_rt,
    web::{Data, Json, Payload},
};
use actix_ws::{Closed, Message, MessageStream, Session};
use common::{
    StreamSettings,
    api_bindings::{
        PostCancelRequest, PostCancelResponse, StreamClientMessage, StreamServerMessage,
    },
    config::Config,
    ipc::{IpcSender, ServerIpcMessage, StreamerIpcMessage, create_child_ipc},
    serialize_json,
};
use log::{debug, error, info, warn};
use moonlight_common::{
    PairStatus,
    stream::bindings::{Colorspace, SupportedVideoFormats},
};
use tokio::{
    process::{Child, Command},
    spawn,
    sync::{Mutex, watch},
    time::sleep,
};

use crate::{
    api::auth::ApiCredentials,
    data::{ActiveStream, RuntimeApiData},
};

/// The stream handler WILL authenticate the client because it is a websocket
/// The Authenticator will let this route through
#[get("/host/stream")]
pub async fn start_host(
    data: Data<RuntimeApiData>,
    config: Data<Config>,
    credentials: Data<ApiCredentials>,
    request: HttpRequest,
    payload: Payload,
) -> Result<HttpResponse, Error> {
    let (response, session, mut stream) = actix_ws::handle(&request, payload)?;

    actix_rt::spawn(async move {
        info!("[Stream]: new WebSocket connection established, awaiting auth message");
        let message;
        loop {
            message = match stream.recv().await {
                Some(Ok(Message::Text(text))) => text,
                Some(Ok(Message::Binary(_))) => {
                    warn!("[Stream]: unexpected binary message during auth phase");
                    return;
                }
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) | Some(Ok(Message::Nop)) => continue,
                Some(Ok(other)) => {
                    warn!("[Stream]: unexpected message during auth phase: {other:?}");
                    continue;
                }
                Some(Err(err)) => {
                    warn!("[Stream]: WebSocket error during auth phase: {err}");
                    return;
                }
                None => {
                    info!("[Stream]: WebSocket closed before auth message received");
                    return;
                }
            };
            break;
        }

        let message = match serde_json::from_str::<StreamClientMessage>(&message) {
            Ok(value) => value,
            Err(_) => {
                return;
            }
        };

        match message {
            StreamClientMessage::AuthenticateAndInit {
                credentials: request_credentials,
                host_id,
                app_id,
                bitrate,
                packet_size,
                fps,
                width,
                height,
                video_sample_queue_size,
                play_audio_local,
                audio_sample_queue_size,
                video_supported_formats,
                video_colorspace,
                video_color_range_full,
            } => {
                info!(
                    "[Stream]: received auth request for host={host_id} app={app_id} ({width}x{height}@{fps}fps)"
                );

                let stream_settings = StreamSettings {
                    bitrate,
                    packet_size,
                    fps,
                    width,
                    height,
                    video_sample_queue_size,
                    audio_sample_queue_size,
                    play_audio_local,
                    video_supported_formats: SupportedVideoFormats::from_bits(
                        video_supported_formats,
                    )
                    .unwrap_or_else(|| {
                        warn!("[Stream]: Received invalid supported video formats");
                        SupportedVideoFormats::H264
                    }),
                    video_colorspace: video_colorspace.into(),
                    video_color_range_full,
                };

                run_primary_stream(
                    data,
                    config,
                    credentials,
                    session,
                    stream,
                    request_credentials,
                    host_id,
                    app_id,
                    stream_settings,
                )
                .await;
            }
            StreamClientMessage::AuthenticateAndAttachInput {
                credentials: request_credentials,
                host_id,
            } => {
                info!("[Stream]: received attach-input request for host={host_id}");

                run_attach_input(
                    data,
                    config,
                    credentials,
                    session,
                    stream,
                    request_credentials,
                    host_id,
                )
                .await;
            }
            _ => {
                warn!("[Stream]: first WS message was not AuthenticateAndInit or AuthenticateAndAttachInput");
                let _ = session.close(None).await;
            }
        }
    });

    Ok(response)
}

async fn authenticate(
    credentials: &ApiCredentials,
    request_credentials: Option<&str>,
) -> bool {
    credentials.authenticate_with_credentials(request_credentials)
        || match request_credentials {
            Some(token) => credentials.validate_session(token).await,
            None => false,
        }
}

/// Relays browser -> streamer messages for a single client_id until the
/// WebSocket closes or errors. Shared between the primary (AV) connection and
/// any attached input-only connections — both just forward `StreamClientMessage`s
/// tagged with their own `client_id` over the same IPC pipe.
async fn relay_ws_to_ipc(
    client_id: u32,
    stream: &mut MessageStream,
    ping_session: &mut Session,
    ipc_sender: &mut IpcSender<ServerIpcMessage>,
) {
    loop {
        match stream.recv().await {
            Some(Ok(Message::Text(text))) => {
                let Ok(message) = serde_json::from_str::<StreamClientMessage>(&text) else {
                    warn!("[Stream]: failed to deserialize from json: {text}");
                    continue;
                };
                // Log client debug logs locally instead of forwarding to streamer
                if let StreamClientMessage::ClientLog { ref log } = message {
                    info!("[Client Log]:\n{log}");
                    continue;
                }
                debug!("[Stream]: relaying WS→IPC (client {client_id}): {text}");
                ipc_sender
                    .send(ServerIpcMessage::WebSocket { client_id, message })
                    .await;
            }
            // Respond to keep-alive pings so the browser doesn't close the connection.
            Some(Ok(Message::Ping(data))) => {
                debug!("[Stream]: received WS Ping, sending Pong");
                let _ = ping_session.pong(&data).await;
            }
            // Ignore pong/nop frames — not an error.
            Some(Ok(Message::Pong(_))) | Some(Ok(Message::Nop)) => {}
            Some(Ok(Message::Close(reason))) => {
                info!("[Stream]: WS closed by client {client_id}: {reason:?}");
                break;
            }
            // Binary frames and continuation frames are unexpected; ignore them.
            Some(Ok(other)) => {
                debug!("[Stream]: ignoring unexpected WS frame: {other:?}");
            }
            // WebSocket closed or error — exit relay.
            Some(Err(err)) => {
                warn!("[Stream]: WS relay error (client {client_id}): {err:?}");
                break;
            }
            None => {
                info!("[Stream]: WS stream ended (None) for client {client_id}");
                break;
            }
        }
    }
}

struct HostConnectionInfo {
    host_address: String,
    host_http_port: u16,
    client_private_key_pem: String,
    client_certificate_pem: String,
    server_certificate_pem: String,
}

/// Fetches pairing/connection info for `host_id`. The `Ok(None)` case mirrors
/// a pre-existing quirk: a paired host with inexplicably-missing cert data
/// closes silently rather than reporting a specific error.
async fn host_connection_info(
    data: &Data<RuntimeApiData>,
    host_id: u32,
) -> Result<HostConnectionInfo, Option<StreamServerMessage>> {
    let hosts = data.hosts.read().await;
    let Some(host) = hosts.get(host_id as usize) else {
        return Err(Some(StreamServerMessage::HostNotFound));
    };
    let mut host = host.lock().await;
    let host_inner = &mut host.moonlight;

    if host_inner.is_paired() == PairStatus::NotPaired {
        warn!("[Stream]: tried to connect to a not paired host");
        return Err(Some(StreamServerMessage::HostNotPaired));
    }

    let (Some(client_private_key), Some(client_certificate), Some(server_certificate)) = (
        host_inner.client_private_key(),
        host_inner.client_certificate(),
        host_inner.server_certificate(),
    ) else {
        return Err(None);
    };

    Ok(HostConnectionInfo {
        host_address: host_inner.address().to_string(),
        host_http_port: host_inner.http_port(),
        client_private_key_pem: client_private_key.to_string(),
        client_certificate_pem: client_certificate.to_string(),
        server_certificate_pem: server_certificate.to_string(),
    })
}

struct SpawnedStream {
    active_stream: Arc<Mutex<ActiveStream>>,
    ipc_sender: IpcSender<ServerIpcMessage>,
    child: Child,
}

/// Spawns the streamer subprocess, registers it as the active stream for
/// `host_id` (so input-only clients waiting on it get attached), spawns the
/// IPC router task, and sends `Init`.
///
/// If `primary_session` is `Some`, it's registered as client_id 0 (a real AV
/// browser) and errors are reported to it. If `None`, there is no client_id 0
/// — this is a placeholder stream started by an input-only client with no
/// AV settings of its own (see `maybe_start_placeholder_stream`) — and
/// errors are only logged.
#[allow(clippy::too_many_arguments)]
async fn spawn_streamer_process(
    data: Data<RuntimeApiData>,
    config: Data<Config>,
    host_id: u32,
    app_id: u32,
    stream_settings: StreamSettings,
    connection_info: HostConnectionInfo,
    mut primary_session: Option<Session>,
) -> Option<SpawnedStream> {
    if let Some(session) = primary_session.as_mut() {
        let _ = send_ws_message(
            session,
            StreamServerMessage::StageStarting {
                stage: "Launch Streamer".to_string(),
            },
        )
        .await;
    }

    // Spawn child
    let (mut child, stdin, stdout) = match Command::new(&config.streamer_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(mut child) => {
            if let Some(stdin) = child.stdin.take()
                && let Some(stdout) = child.stdout.take()
            {
                (child, stdin, stdout)
            } else {
                error!("[Stream]: streamer process didn't include a stdin or stdout");

                if let Some(mut session) = primary_session.take() {
                    let _ = send_ws_message(&mut session, StreamServerMessage::InternalServerError)
                        .await;
                    let _ = session.close(None).await;
                }

                if let Err(err) = child.kill().await {
                    warn!("[Stream]: failed to kill child: {err:?}");
                }

                return None;
            }
        }
        Err(err) => {
            error!("[Stream]: failed to spawn streamer process: {err:?}");

            if let Some(mut session) = primary_session.take() {
                let _ = send_ws_message(&mut session, StreamServerMessage::InternalServerError).await;
                let _ = session.close(None).await;
            }
            return None;
        }
    };

    // Create ipc
    let (mut ipc_sender, mut ipc_receiver) =
        create_child_ipc::<ServerIpcMessage, StreamerIpcMessage>(
            "Streamer".to_string(),
            stdin,
            stdout,
            child.stderr.take(),
        )
        .await;

    // Register this stream so browser connections (the primary, and/or any
    // input-only attachments) can attach to it instead of starting a new one.
    let mut clients = HashMap::new();
    if let Some(session) = &primary_session {
        clients.insert(0u32, session.clone());
    }
    let active_stream = Arc::new(Mutex::new(ActiveStream {
        ipc_sender: ipc_sender.clone(),
        next_client_id: 1, // 0 is reserved for a primary AV client, if any
        clients,
    }));
    {
        let hosts = data.hosts.read().await;
        if let Some(host) = hosts.get(host_id as usize) {
            let host = host.lock().await;
            host.active_stream.send_replace(Some(active_stream.clone()));
        }
    }

    // Router: owns the IPC receiver for the lifetime of the stream and demuxes
    // replies to whichever browser connection (primary or attached input-only)
    // they're tagged for.
    spawn({
        let data = data.clone();
        let active_stream = active_stream.clone();

        async move {
            while let Some(message) = ipc_receiver.recv().await {
                match message {
                    StreamerIpcMessage::WebSocket { client_id, message } => {
                        let target = {
                            let active = active_stream.lock().await;
                            active.clients.get(&client_id).cloned()
                        };
                        if let Some(mut target_session) = target {
                            if let Err(Closed) = send_ws_message(&mut target_session, message).await {
                                warn!(
                                    "[Ipc]: tried to send a ws message to client {client_id} but the socket is already closed"
                                );
                            }
                        }
                    }
                    StreamerIpcMessage::Stop => {
                        debug!("[Ipc]: ipc receiver stopped by streamer");
                        break;
                    }
                }
            }
            info!("[Ipc]: ipc receiver is closed");

            // Mark the stream inactive first: any input-only clients currently
            // attached (or waiting to attach) own their own WebSocket session and
            // are watching this via `run_attach_input`'s loop — they'll detach
            // themselves and go back to waiting for the next primary stream
            // rather than being disconnected.
            {
                let hosts = data.hosts.read().await;
                if let Some(host) = hosts.get(host_id as usize) {
                    let host = host.lock().await;
                    host.active_stream.send_replace(None);
                }
            }

            // Only the primary (AV) session, if any, actually needs tearing down here.
            let mut active = active_stream.lock().await;
            if let Some(primary_session) = active.clients.remove(&0) {
                let _ = primary_session.close(None).await;
            }
        }
    });

    // Send init into ipc
    ipc_sender
        .send(ServerIpcMessage::Init {
            server_config: Config::clone(&config),
            stream_settings,
            host_address: connection_info.host_address,
            host_http_port: connection_info.host_http_port,
            host_unique_id: None,
            client_private_key_pem: connection_info.client_private_key_pem,
            client_certificate_pem: connection_info.client_certificate_pem,
            server_certificate_pem: connection_info.server_certificate_pem,
            app_id,
        })
        .await;

    Some(SpawnedStream {
        active_stream,
        ipc_sender,
        child,
    })
}

/// If a stream (placeholder or real) is already active for `host_id`, signals
/// it to stop and waits (best-effort, up to 10s) for it to actually finish
/// tearing down before returning, so a fresh `LiStartConnection` doesn't race
/// the old one's teardown.
async fn stop_existing_stream_and_wait(data: &Data<RuntimeApiData>, host_id: u32) {
    let (existing, mut active_stream_rx) = {
        let hosts = data.hosts.read().await;
        let Some(host) = hosts.get(host_id as usize) else {
            return;
        };
        let host = host.lock().await;
        (
            host.active_stream.borrow().clone(),
            host.active_stream.subscribe(),
        )
    };

    let Some(existing) = existing else {
        return;
    };

    info!(
        "[Stream]: host={host_id} already has an active stream — stopping it before starting a new one"
    );

    {
        let mut ipc_sender = existing.lock().await.ipc_sender.clone();
        ipc_sender.send(ServerIpcMessage::Stop).await;
    }

    let wait = async {
        while active_stream_rx.borrow().is_some() {
            if active_stream_rx.changed().await.is_err() {
                break;
            }
        }
    };

    if tokio::time::timeout(Duration::from_secs(10), wait).await.is_err() {
        warn!("[Stream]: timed out waiting for the previous stream on host={host_id} to stop");
    }
}

/// Conservative defaults used when an input-only client starts a stream
/// before any real AV browser is around to supply its own settings. Kept
/// modest since this video/audio output goes nowhere — nobody has a WebRTC
/// peer connected to receive it — until a real viewer attaches. Replaced
/// wholesale (via `stop_existing_stream_and_wait`) the moment a real
/// `AuthenticateAndInit` arrives.
fn default_placeholder_stream_settings() -> StreamSettings {
    StreamSettings {
        bitrate: 4000,
        packet_size: 1024,
        fps: 30,
        width: 1280,
        height: 720,
        video_sample_queue_size: 1,
        audio_sample_queue_size: 1,
        play_audio_local: false,
        video_supported_formats: SupportedVideoFormats::H264,
        video_colorspace: Colorspace::Rec709,
        video_color_range_full: false,
    }
}

/// Watches a placeholder-started stream (one with no primary/AV session of
/// its own to hang a "disconnect -> kill" lifecycle off of) and stops it once
/// every attached client has been gone for a grace period, so a phone that
/// briefly connects then leaves doesn't leave an orphaned streamer process
/// (and Sunshine session) running forever.
fn supervise_placeholder_stream(
    active_stream: Arc<Mutex<ActiveStream>>,
    mut ipc_sender: IpcSender<ServerIpcMessage>,
    mut child: Child,
    host_id: u32,
) {
    spawn(async move {
        const POLL_INTERVAL: Duration = Duration::from_secs(10);
        const EMPTY_POLLS_BEFORE_STOP: u32 = 3; // ~30s grace period

        let mut empty_polls = 0u32;
        loop {
            sleep(POLL_INTERVAL).await;

            // The streamer may have already exited on its own (e.g. the
            // Sunshine session ended externally) — checking the child's exit
            // status directly is the authoritative signal that we're done.
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {}
                Err(err) => {
                    warn!(
                        "[Stream]: failed to check placeholder streamer status for host={host_id}: {err:?}"
                    );
                }
            }

            let is_empty = active_stream.lock().await.clients.is_empty();
            if !is_empty {
                empty_polls = 0;
                continue;
            }

            empty_polls += 1;
            if empty_polls < EMPTY_POLLS_BEFORE_STOP {
                continue;
            }

            info!(
                "[Stream]: placeholder stream for host={host_id} has had no clients for a while, stopping it"
            );
            ipc_sender.send(ServerIpcMessage::Stop).await;
            drop(ipc_sender);

            sleep(Duration::from_secs(4)).await;
            if let Err(err) = child.kill().await {
                warn!("[Stream]: failed to kill placeholder streamer for host={host_id}: {err:?}");
            }
            break;
        }
    });
}

/// If no stream is active for `host_id` and Sunshine already reports a game
/// running (started by any client — this app, or even a different Moonlight
/// client connecting directly to Sunshine and then disconnecting without
/// stopping it), spawns a placeholder stream attached to that game so an
/// input-only client doesn't have to wait idle for a real AV browser to show
/// up. No-ops if nothing is running, or if a stream is already active or
/// being started by another concurrent caller.
async fn maybe_start_placeholder_stream(data: &Data<RuntimeApiData>, config: &Data<Config>, host_id: u32) {
    let lifecycle_lock = {
        let hosts = data.hosts.read().await;
        let Some(host) = hosts.get(host_id as usize) else {
            return;
        };
        let host = host.lock().await;
        if host.active_stream.borrow().is_some() {
            return;
        }
        host.stream_lifecycle.clone()
    };

    let _lifecycle_guard = lifecycle_lock.lock().await;

    let app_id = {
        let hosts = data.hosts.read().await;
        let Some(host) = hosts.get(host_id as usize) else {
            return;
        };
        let mut host = host.lock().await;

        // Another input-only client may have started one while we were
        // waiting for the lifecycle lock above.
        if host.active_stream.borrow().is_some() {
            return;
        }

        host.moonlight.clear_cache();
        // Bounded well below the client's normal HTTP timeout (90s): this call
        // holds `host.lock()` the whole time, and that same lock is needed by
        // *any other* connection attempt for this host (including a real AV
        // browser reconnecting) — so a slow/unreachable host here must not be
        // allowed to stall everyone else's connect attempts too.
        match tokio::time::timeout(Duration::from_secs(5), host.moonlight.current_game()).await {
            Ok(Ok(0)) => {
                debug!(
                    "[Stream]: host={host_id} has no game running — nothing for an input-only client to attach to yet"
                );
                return;
            }
            Ok(Ok(app_id)) => app_id,
            Ok(Err(err)) => {
                warn!("[Stream]: failed to check current game for host={host_id}: {err:?}");
                return;
            }
            Err(_) => {
                warn!(
                    "[Stream]: timed out checking current game for host={host_id}, giving up on placeholder start"
                );
                return;
            }
        }
    };

    let connection_info = match host_connection_info(data, host_id).await {
        Ok(value) => value,
        Err(_) => return,
    };

    info!(
        "[Stream]: host={host_id} already has app={app_id} running — starting a placeholder stream so an input-only client can attach to it"
    );

    let Some(spawned) = spawn_streamer_process(
        data.clone(),
        config.clone(),
        host_id,
        app_id,
        default_placeholder_stream_settings(),
        connection_info,
        None,
    )
    .await
    else {
        return;
    };

    supervise_placeholder_stream(spawned.active_stream, spawned.ipc_sender, spawned.child, host_id);
}

#[allow(clippy::too_many_arguments)]
async fn run_primary_stream(
    data: Data<RuntimeApiData>,
    config: Data<Config>,
    credentials: Data<ApiCredentials>,
    mut session: Session,
    mut stream: MessageStream,
    request_credentials: Option<String>,
    host_id: u32,
    app_id: u32,
    stream_settings: StreamSettings,
) {
    let authenticated = authenticate(&credentials, request_credentials.as_deref()).await;

    if !authenticated {
        warn!("[Stream]: authentication failed for stream request");
        let _ = send_ws_message(
            &mut session,
            StreamServerMessage::StageFailed {
                stage: "Authentication".to_string(),
                error_code: -1,
            },
        )
        .await;

        let _ = session.close(None).await;
        return;
    }

    let connection_info = match host_connection_info(&data, host_id).await {
        Ok(value) => value,
        Err(Some(message)) => {
            let _ = send_ws_message(&mut session, message).await;
            let _ = session.close(None).await;
            return;
        }
        Err(None) => return,
    };

    // Fetch + validate the requested app separately — only the primary path
    // needs this, to send `UpdateApp` and confirm `app_id` against the host's
    // actual app list (a placeholder stream trusts `current_game()` directly).
    let app = {
        let hosts = data.hosts.read().await;
        let Some(host) = hosts.get(host_id as usize) else {
            let _ = send_ws_message(&mut session, StreamServerMessage::HostNotFound).await;
            let _ = session.close(None).await;
            return;
        };
        let mut host = host.lock().await;

        // Bounded for the same reason as the placeholder-stream's current_game()
        // check: this holds `host.lock()`, which a reconnecting client for this
        // same host also needs, so a slow/unreachable host can't be allowed to
        // stall reconnect attempts indefinitely (well below the default 90s
        // HTTP client timeout).
        let apps = match tokio::time::timeout(Duration::from_secs(10), host.moonlight.app_list()).await {
            Ok(Ok(value)) => value,
            Ok(Err(err)) => {
                error!("[Stream]: failed to get app list from host: {err:?}");

                let _ = send_ws_message(&mut session, StreamServerMessage::InternalServerError)
                    .await;
                let _ = session.close(None).await;
                return;
            }
            Err(_) => {
                error!("[Stream]: timed out fetching app list from host={host_id}");

                let _ = send_ws_message(&mut session, StreamServerMessage::InternalServerError)
                    .await;
                let _ = session.close(None).await;
                return;
            }
        };
        let Some(app) = apps.iter().find(|app| app.id == app_id).cloned() else {
            warn!("[Stream]: failed to get request app from user");

            let _ = send_ws_message(&mut session, StreamServerMessage::AppNotFound).await;
            let _ = session.close(None).await;
            return;
        };
        app
    };

    // Send App info
    let _ = send_ws_message(
        &mut session,
        StreamServerMessage::UpdateApp { app: app.into() },
    )
    .await;

    // If a stream (placeholder or otherwise) is already active for this host,
    // stop it first — Sunshine only allows one active session at a time, and
    // this browser's settings should take over. Held under the same
    // per-host lifecycle lock `maybe_start_placeholder_stream` uses, so an
    // in-flight placeholder spawn can't race with (and clobber) this one —
    // released as soon as the new stream is registered, not for this
    // connection's whole lifetime, so a *later* real connection can still
    // pre-empt this one the same way.
    let spawned = {
        let lifecycle_lock = {
            let hosts = data.hosts.read().await;
            let Some(host) = hosts.get(host_id as usize) else {
                let _ = send_ws_message(&mut session, StreamServerMessage::HostNotFound).await;
                let _ = session.close(None).await;
                return;
            };
            let host = host.lock().await;
            host.stream_lifecycle.clone()
        };
        let _lifecycle_guard = lifecycle_lock.lock().await;

        stop_existing_stream_and_wait(&data, host_id).await;

        spawn_streamer_process(
            data.clone(),
            config.clone(),
            host_id,
            app_id,
            stream_settings,
            connection_info,
            Some(session.clone()),
        )
        .await
    };
    let Some(spawned) = spawned else {
        return;
    };

    let mut ipc_sender = spawned.ipc_sender;
    let mut ping_session = session.clone();
    relay_ws_to_ipc(0, &mut stream, &mut ping_session, &mut ipc_sender).await;

    // -- After the websocket disconnects we kill the stream:
    ipc_sender.send(ServerIpcMessage::Stop).await;
    drop(ipc_sender);

    sleep(Duration::from_secs(4)).await;

    info!("[Stream]: killing streamer");
    let mut child = spawned.child;
    match child.kill().await {
        Ok(_) => {
            info!("[Stream]: killed streamer");
        }
        Err(err) => {
            warn!("[Stream]: failed to kill child: {err:?}");
        }
    }
}

/// Whether an input-only client's attached relay loop ended because the
/// primary stream went away (in which case we should go back to waiting for
/// the next one) or because the client's own WebSocket closed/errored (in
/// which case we should tear everything down).
enum InputRelayExit {
    StreamEnded,
    WsClosed,
}

/// Waits until `host_id` has an active primary stream, returning it once one
/// exists. While waiting, keeps servicing the WebSocket (pings, close
/// detection) so the connection doesn't time out or leak. Returns `None` if
/// the client disconnected or the host disappeared while waiting.
async fn wait_for_active_stream(
    active_stream_rx: &mut watch::Receiver<Option<Arc<Mutex<ActiveStream>>>>,
    stream: &mut MessageStream,
    ping_session: &mut Session,
    info_session: &mut Session,
) -> Option<Arc<Mutex<ActiveStream>>> {
    let mut announced = false;

    loop {
        if let Some(active) = active_stream_rx.borrow().clone() {
            info!("[Stream]: active stream found, attaching");
            return Some(active);
        }

        if !announced {
            info!("[Stream]: no active stream yet, sending WaitingForStream message");
            let send_result = send_ws_message(info_session, StreamServerMessage::WaitingForStream).await;
            if send_result.is_err() {
                warn!("[Stream]: failed to send WaitingForStream message to client");
                return None;
            }
            announced = true;
        }

        tokio::select! {
            changed = active_stream_rx.changed() => {
                if changed.is_err() {
                    info!("[Stream]: host removed while an input-only client was waiting to attach");
                    return None;
                }
                info!("[Stream]: stream status changed while waiting, looping back to check");
            }
            message = stream.recv() => {
                match message {
                    Some(Ok(Message::Ping(data))) => {
                        let _ = ping_session.pong(&data).await;
                    }
                    Some(Ok(Message::Pong(_))) | Some(Ok(Message::Nop)) => {}
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(StreamClientMessage::ClientLog { log }) = serde_json::from_str(&text) {
                            info!("[Client Log]:\n{log}");
                        }
                    }
                    Some(Ok(Message::Close(reason))) => {
                        info!("[Stream]: WS closed by input-only client while waiting to attach: {reason:?}");
                        return None;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(err)) => {
                        warn!("[Stream]: WS error from input-only client while waiting to attach: {err:?}");
                        return None;
                    }
                    None => {
                        info!("[Stream]: WS ended for input-only client while waiting to attach");
                        return None;
                    }
                }
            }
        }
    }
}

/// Like `relay_ws_to_ipc`, but also watches `active_stream_rx` so it can
/// return early when the primary stream ends, without closing the WebSocket.
async fn relay_ws_to_ipc_while_attached(
    client_id: u32,
    stream: &mut MessageStream,
    ping_session: &mut Session,
    ipc_sender: &mut IpcSender<ServerIpcMessage>,
    active_stream_rx: &mut watch::Receiver<Option<Arc<Mutex<ActiveStream>>>>,
) -> InputRelayExit {
    loop {
        tokio::select! {
            changed = active_stream_rx.changed() => {
                if changed.is_err() || active_stream_rx.borrow().is_none() {
                    return InputRelayExit::StreamEnded;
                }
            }
            message = stream.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(message) = serde_json::from_str::<StreamClientMessage>(&text) else {
                            warn!("[Stream]: failed to deserialize from json: {text}");
                            continue;
                        };
                        if let StreamClientMessage::ClientLog { ref log } = message {
                            info!("[Client Log]:\n{log}");
                            continue;
                        }
                        debug!("[Stream]: relaying WS→IPC (client {client_id}): {text}");
                        ipc_sender
                            .send(ServerIpcMessage::WebSocket { client_id, message })
                            .await;
                    }
                    Some(Ok(Message::Ping(data))) => {
                        let _ = ping_session.pong(&data).await;
                    }
                    Some(Ok(Message::Pong(_))) | Some(Ok(Message::Nop)) => {}
                    Some(Ok(Message::Close(reason))) => {
                        info!("[Stream]: WS closed by client {client_id}: {reason:?}");
                        return InputRelayExit::WsClosed;
                    }
                    Some(Ok(other)) => {
                        debug!("[Stream]: ignoring unexpected WS frame: {other:?}");
                    }
                    Some(Err(err)) => {
                        warn!("[Stream]: WS relay error (client {client_id}): {err:?}");
                        return InputRelayExit::WsClosed;
                    }
                    None => {
                        info!("[Stream]: WS stream ended (None) for client {client_id}");
                        return InputRelayExit::WsClosed;
                    }
                }
            }
        }
    }
}

async fn run_attach_input(
    data: Data<RuntimeApiData>,
    config: Data<Config>,
    credentials: Data<ApiCredentials>,
    mut session: Session,
    mut stream: MessageStream,
    request_credentials: Option<String>,
    host_id: u32,
) {
    let authenticated = authenticate(&credentials, request_credentials.as_deref()).await;

    if !authenticated {
        warn!("[Stream]: authentication failed for attach-input request");
        let _ = send_ws_message(
            &mut session,
            StreamServerMessage::StageFailed {
                stage: "Authentication".to_string(),
                error_code: -1,
            },
        )
        .await;

        let _ = session.close(None).await;
        return;
    }

    let mut active_stream_rx = {
        let hosts = data.hosts.read().await;
        let Some(host) = hosts.get(host_id as usize) else {
            let _ = send_ws_message(&mut session, StreamServerMessage::HostNotFound).await;
            let _ = session.close(None).await;
            return;
        };
        let host = host.lock().await;
        host.active_stream.subscribe()
    };

    let mut ping_session = session.clone();

    // Doesn't matter whether a primary (AV) stream is already running or not:
    // wait here until one is, attach, and if it later ends, go back to
    // waiting for the next one rather than disconnecting this client.
    loop {
        // If nothing is streaming yet but Sunshine already has a game running
        // (e.g. started directly through a different Moonlight client and left
        // running, or our own placeholder from an earlier loop iteration was
        // torn down for lack of clients), start a placeholder stream so this
        // client doesn't have to wait for a real AV browser. No-ops if a
        // stream is already active. Re-checked on every iteration — not just
        // the first — since a placeholder can come and go for as long as
        // this client stays connected and waiting.
        maybe_start_placeholder_stream(&data, &config, host_id).await;

        let active_stream = {
            let mut info_session = session.clone();
            match wait_for_active_stream(
                &mut active_stream_rx,
                &mut stream,
                &mut ping_session,
                &mut info_session,
            )
            .await
            {
                Some(value) => value,
                None => {
                    let _ = session.close(None).await;
                    return;
                }
            }
        };

        let (client_id, mut ipc_sender) = {
            let mut active = active_stream.lock().await;
            let client_id = active.next_client_id;

            // Prevent ID overflow: if we're about to wrap around to 0 (which is reserved
            // for the primary AV client), reset the counter to 1 to reuse freed IDs.
            // In practice this shouldn't happen unless there are millions of reconnects,
            // but gamepads are only freed when clients disconnect, so accumulated connections
            // could theoretically hit this.
            if client_id >= u32::MAX {
                active.next_client_id = 1;
            } else {
                active.next_client_id += 1;
            }

            active.clients.insert(client_id, session.clone());
            (client_id, active.ipc_sender.clone())
        };

        info!("[Stream]: attaching input-only client {client_id} to host={host_id}");
        ipc_sender
            .send(ServerIpcMessage::AttachInputClient { client_id })
            .await;

        let exit = relay_ws_to_ipc_while_attached(
            client_id,
            &mut stream,
            &mut ping_session,
            &mut ipc_sender,
            &mut active_stream_rx,
        )
        .await;

        info!("[Stream]: detaching input-only client {client_id} from host={host_id}");

        {
            let mut active = active_stream.lock().await;
            active.clients.remove(&client_id);
            info!("[Stream]: removed client {client_id} from active.clients; remaining: {}", active.clients.len());
        }

        // Detach via IPC so the streamer can clean up gamepad slots and other resources
        ipc_sender
            .send(ServerIpcMessage::DetachInputClient { client_id })
            .await;

        match exit {
            InputRelayExit::StreamEnded => continue,
            InputRelayExit::WsClosed => {
                let _ = session.close(None).await;
                return;
            }
        }
    }
}

async fn send_ws_message(sender: &mut Session, message: StreamServerMessage) -> Result<(), Closed> {
    let Some(json) = serialize_json(&message) else {
        return Ok(());
    };

    sender.text(json).await
}

#[post("/host/cancel")]
pub async fn cancel_host(
    data: Data<RuntimeApiData>,
    request: Json<PostCancelRequest>,
) -> Either<Json<PostCancelResponse>, HttpResponse> {
    let hosts = data.hosts.read().await;

    let host_id = request.host_id;
    let Some(host) = hosts.get(host_id as usize) else {
        return Either::Right(HttpResponse::NotFound().finish());
    };

    let mut host = host.lock().await;

    let success = match host.moonlight.cancel().await {
        Ok(value) => value,
        Err(err) => {
            warn!("[Api]: failed to cancel stream for {host_id}:{err:?}");

            return Either::Right(HttpResponse::InternalServerError().finish());
        }
    };

    Either::Left(Json(PostCancelResponse { success }))
}
