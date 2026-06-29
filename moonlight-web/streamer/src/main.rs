use std::{collections::HashMap, panic, process::exit, str::FromStr, sync::Arc};

use common::{
    StreamSettings,
    api_bindings::StreamServerGeneralMessage,
    config::PortRange,
    ipc::{IpcReceiver, IpcSender, ServerIpcMessage, StreamerIpcMessage, create_process_ipc},
    serialize_json,
};
use log::{LevelFilter, debug, info, warn};
use moonlight_common::{
    MoonlightError,
    high::HostError,
    network::reqwest::ReqwestMoonlightHost,
    pair::ClientAuth,
    stream::{
        MoonlightInstance, MoonlightStream,
        bindings::{ColorRange, EncryptionFlags, HostFeatures},
    },
};
use pem::Pem;
use simplelog::{ColorChoice, TermLogger, TerminalMode};
use tokio::{
    io::{stdin, stdout},
    runtime::Handle,
    spawn,
    sync::{Mutex, Notify, RwLock},
    task::spawn_blocking,
};
use webrtc::{
    api::{
        API, APIBuilder, interceptor_registry::register_default_interceptors,
        media_engine::MediaEngine, setting_engine::SettingEngine,
    },
    data_channel::RTCDataChannel,
    ice::udp_network::{EphemeralUDP, UDPNetwork},
    ice_transport::{
        ice_candidate::{RTCIceCandidate, RTCIceCandidateInit},
        ice_connection_state::RTCIceConnectionState,
    },
    interceptor::registry::Registry,
    peer_connection::{
        RTCPeerConnection,
        configuration::RTCConfiguration,
        offer_answer_options::RTCOfferOptions,
        peer_connection_state::RTCPeerConnectionState,
        sdp::{sdp_type::RTCSdpType, session_description::RTCSessionDescription},
    },
    rtp_transceiver::{
        rtp_codec::RTPCodecType,
        rtp_sender::RTCRtpSender,
    },
    data_channel::data_channel_init::RTCDataChannelInit,
};

use common::api_bindings::{
    RtcIceCandidate, RtcSdpType, RtcSessionDescription, StreamCapabilities, StreamClientMessage,
    StreamServerMessage, StreamSignalingMessage,
};

use crate::{
    audio::{OpusTrackSampleAudioDecoder, register_audio_codecs},
    connection::StreamConnectionListener,
    convert::{
        from_webrtc_ice, from_webrtc_sdp, into_webrtc_ice, into_webrtc_ice_candidate,
        into_webrtc_network_type,
    },
    input::StreamInput,
    video::{TrackSampleVideoDecoder, register_video_codecs},
};

mod audio;
mod buffer;
mod connection;
mod convert;
mod input;
mod sender;
mod video;

#[tokio::main]
async fn main() {
    #[cfg(debug_assertions)]
    let log_level = LevelFilter::Debug;
    #[cfg(not(debug_assertions))]
    let log_level = LevelFilter::Info;

    TermLogger::init(
        log_level,
        simplelog::Config::default(),
        TerminalMode::Stderr,
        ColorChoice::Auto,
    )
    .expect("failed to init logger");

    let default_panic = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        default_panic(info);
        exit(0);
    }));

    // At this point we're authenticated
    let (mut ipc_sender, mut ipc_receiver) =
        create_process_ipc::<ServerIpcMessage, StreamerIpcMessage>(stdin(), stdout()).await;

    // Send stage
    ipc_sender
        .send(StreamerIpcMessage::WebSocket {
            client_id: 0,
            message: StreamServerMessage::StageComplete {
                stage: "Launch Streamer".to_string(),
            },
        })
        .await;

    let (
        server_config,
        stream_settings,
        host_address,
        host_http_port,
        host_unique_id,
        client_private_key_pem,
        client_certificate_pem,
        server_certificate_pem,
        app_id,
    ) = loop {
        match ipc_receiver.recv().await {
            Some(ServerIpcMessage::Init {
                server_config,
                stream_settings,
                host_address,
                host_http_port,
                host_unique_id,
                client_private_key_pem,
                client_certificate_pem,
                server_certificate_pem,
                app_id,
            }) => {
                debug!(
                    "Client supported codecs: {:?}",
                    stream_settings
                        .video_supported_formats
                        .iter_names()
                        .collect::<Vec<_>>()
                );

                break (
                    server_config,
                    stream_settings,
                    host_address,
                    host_http_port,
                    host_unique_id,
                    client_private_key_pem,
                    client_certificate_pem,
                    server_certificate_pem,
                    app_id,
                );
            }
            _ => continue,
        }
    };

    // Send stage
    ipc_sender
        .send(StreamerIpcMessage::WebSocket {
            client_id: 0,
            message: StreamServerMessage::StageStarting {
                stage: "Setup WebRTC Peer".to_string(),
            },
        })
        .await;

    // Try to use localhost if Sunshine is reachable locally (avoids DNS + NAT hairpin)
    let host_address = match try_localhost(host_http_port).await {
        Some(local) => {
            info!("[Stream] Using local address {local} instead of {host_address}");
            local
        }
        None => host_address,
    };

    // -- Create the host and pair it
    let mut host = ReqwestMoonlightHost::new(host_address, host_http_port, host_unique_id)
        .expect("failed to create host");

    host.set_pairing_info(
        &ClientAuth {
            private_key: Pem::from_str(&client_private_key_pem)
                .expect("failed to parse client private key"),
            certificate: Pem::from_str(&client_certificate_pem)
                .expect("failed to parse client certificate"),
        },
        &Pem::from_str(&server_certificate_pem).expect("failed to parse server certificate"),
    )
    .expect("failed to set pairing info");

    // -- Configure moonlight
    let moonlight = MoonlightInstance::global().expect("failed to find moonlight");

    // -- Configure WebRTC
    let rtc_config = RTCConfiguration {
        ice_servers: server_config
            .webrtc_ice_servers
            .clone()
            .into_iter()
            .map(into_webrtc_ice)
            .collect(),
        ..Default::default()
    };
    let mut api_settings = SettingEngine::default();

    if let Some(PortRange { min, max }) = server_config.webrtc_port_range {
        match EphemeralUDP::new(min, max) {
            Ok(udp) => {
                api_settings.set_udp_network(UDPNetwork::Ephemeral(udp));
            }
            Err(err) => {
                warn!("[Stream]: Invalid port range in config: {err:?}");
            }
        }
    }

    // Filter out addresses that should never be used for ICE:
    // - Link-local (APIPA, 169.254.x.x): OS can't bind with explicit port range
    // - Hyper-V/WSL virtual adapters (172.16-31.x.x): unreachable from outside,
    //   waste candidate pairs and confuse remote peers
    api_settings.set_ip_filter(Box::new(|ip: std::net::IpAddr| {
        match ip {
            std::net::IpAddr::V4(v4) => {
                if v4.is_link_local() {
                    return false;
                }
                // Filter 172.16.0.0/12 — these are almost always Hyper-V/WSL/Docker
                // virtual adapters on Windows that are unreachable externally.
                let octets = v4.octets();
                if octets[0] == 172 && (octets[1] & 0xF0) == 16 {
                    return false;
                }
                true
            }
            std::net::IpAddr::V6(_) => true,
        }
    }));
    if let Some(mapping) = server_config.webrtc_nat_1to1 {
        let valid_ips: Vec<String> = mapping.ips.iter()
            .filter(|ip| {
                let is_placeholder = ip.contains('<') || ip.contains('>');
                if is_placeholder {
                    warn!(
                        "[Stream]: Skipping placeholder NAT IP '{}' — replace it with your real public IP in server/config.json. \
                         WebRTC may not work over the Internet without a valid NAT IP.",
                        ip
                    );
                }
                !is_placeholder
            })
            .cloned()
            .collect();
        if !valid_ips.is_empty() {
            api_settings.set_nat_1to1_ips(
                valid_ips,
                into_webrtc_ice_candidate(mapping.ice_candidate_type),
            );
        }
    }
    api_settings.set_network_types(
        server_config
            .webrtc_network_types
            .iter()
            .copied()
            .map(into_webrtc_network_type)
            .collect(),
    );

    // -- Register media codecs
    let mut api_media = MediaEngine::default();
    register_audio_codecs(&mut api_media).expect("failed to register audio codecs");
    register_video_codecs(&mut api_media, stream_settings.video_supported_formats)
        .expect("failed to register video codecs");

    // -- Build Api
    let mut api_registry = Registry::new();

    // Use the default set of Interceptors
    api_registry = register_default_interceptors(api_registry, &mut api_media)
        .expect("failed to register webrtc default interceptors");

    let api = APIBuilder::new()
        .with_setting_engine(api_settings)
        .with_media_engine(api_media)
        .with_interceptor_registry(api_registry)
        .build();

    // -- Create and Configure Peer
    let connection = StreamConnection::new(
        moonlight,
        StreamInfo {
            host: Mutex::new(host),
            app_id,
        },
        stream_settings,
        ipc_sender.clone(),
        ipc_receiver,
        api,
        rtc_config,
    )
    .await
    .expect("failed to create connection");

    // Send stage
    ipc_sender
        .send(StreamerIpcMessage::WebSocket {
            client_id: 0,
            message: StreamServerMessage::StageComplete {
                stage: "Setup WebRTC Peer".to_string(),
            },
        })
        .await;

    // Send stage
    ipc_sender
        .send(StreamerIpcMessage::WebSocket {
            client_id: 0,
            message: StreamServerMessage::StageStarting {
                stage: "WebRTC Peer Negotiation".to_string(),
            },
        })
        .await;

    // Start Moonlight/Sunshine stream pre-emptively (in parallel with ICE negotiation).
    // This saves 1-2s by doing the Moonlight protocol handshake while ICE candidates
    // are being exchanged, so frames are ready the moment the WebRTC link connects.
    spawn({
        let connection = connection.clone();
        async move {
            if let Err(err) = connection.start_stream().await {
                warn!("[Stream]: failed to start stream: {err:?}");
                connection.stop().await;
            }
        }
    });

    // Wait for termination
    connection.terminate.notified().await;

    // Exit streamer
    exit(0);
}

struct StreamInfo {
    host: Mutex<ReqwestMoonlightHost>,
    app_id: u32,
}

struct StreamConnection {
    pub runtime: Handle,
    pub moonlight: MoonlightInstance,
    pub info: StreamInfo,
    pub settings: StreamSettings,
    pub peer: Arc<RTCPeerConnection>,
    pub ipc_sender: IpcSender<StreamerIpcMessage>,
    pub general_channel: Arc<RTCDataChannel>,
    pub audio_channel: Arc<RTCDataChannel>,
    // Input
    pub input: StreamInput,
    // Video
    pub video_size: Mutex<(u32, u32)>,
    // Pre-registered video sender (transceiver added before first offer/answer so
    // all codecs are in the SDP; the actual track is attached via replace_track in setup())
    pub pre_video_sender: Mutex<Option<Arc<RTCRtpSender>>>,
    // Stream
    pub stream: RwLock<Option<MoonlightStream>>,
    pub terminate: Notify,
    // Signalled when the audio DataChannel is open and ready for sends
    pub audio_channel_open: Arc<Notify>,
    // ICE restart tracking
    pub ice_restart_attempted: std::sync::atomic::AtomicBool,
    // Prevents start_stream from being called more than once
    stream_start_initiated: std::sync::atomic::AtomicBool,
    // Kept around (rather than just consumed in new()) so additional, input-only
    // peer connections can be created later for clients attaching to this stream.
    api: API,
    rtc_config: RTCConfiguration,
    // client_id (always != 0; 0 is the primary AV peer above) -> its video/audio-free
    // WebRTC peer, driving the same shared `stream` as the primary connection.
    secondary_peers: RwLock<HashMap<u32, Arc<RTCPeerConnection>>>,
}

impl StreamConnection {
    pub async fn new(
        moonlight: MoonlightInstance,
        info: StreamInfo,
        settings: StreamSettings,
        mut ipc_sender: IpcSender<StreamerIpcMessage>,
        mut ipc_receiver: IpcReceiver<ServerIpcMessage>,
        api: API,
        config: RTCConfiguration,
    ) -> Result<Arc<Self>, anyhow::Error> {
        // Send WebRTC Info
        ipc_sender
            .send(StreamerIpcMessage::WebSocket {
                client_id: 0,
                message: StreamServerMessage::WebRtcConfig {
                    ice_servers: config
                        .ice_servers
                        .iter()
                        .cloned()
                        .map(from_webrtc_ice)
                        .collect(),
                },
            })
            .await;

        let peer = Arc::new(api.new_peer_connection(config.clone()).await?);

        // -- Input
        let input = StreamInput::new();

        let general_channel = peer.create_data_channel("general", None).await?;
        let audio_channel = peer
            .create_data_channel(
                "audio",
                Some(RTCDataChannelInit {
                    ordered: Some(false),
                    max_packet_life_time: None,
                    max_retransmits: Some(0),
                    ..Default::default()
                }),
            )
            .await?;

        let audio_channel_open = Arc::new(Notify::new());
        audio_channel.on_open({
            let notify = audio_channel_open.clone();
            Box::new(move || {
                notify.notify_one();
                Box::pin(async {})
            })
        });

        let this = Arc::new(Self {
            runtime: Handle::current(),
            moonlight,
            info,
            settings,
            peer: peer.clone(),
            ipc_sender,
            general_channel,
            audio_channel,
            audio_channel_open,
            video_size: Mutex::new((0, 0)),
            input,
            pre_video_sender: Mutex::new(None),
            stream: Default::default(),
            terminate: Notify::new(),
            ice_restart_attempted: std::sync::atomic::AtomicBool::new(false),
            stream_start_initiated: std::sync::atomic::AtomicBool::new(false),
            api,
            rtc_config: config,
            secondary_peers: RwLock::new(HashMap::new()),
        });

        // Pre-register a bare video transceiver so the initial SDP includes ALL supported
        // video codecs. The correct-codec track is attached via replace_track() in setup(),
        // avoiding any renegotiation (and its ICE-disrupting effects) regardless of which
        // codec Moonlight ultimately selects (H264, H265, AV1, etc.).
        match peer.add_transceiver_from_kind(
            RTPCodecType::Video,
            None,
        ).await {
            Ok(transceiver) => {
                let sender = transceiver.sender().await;
                *this.pre_video_sender.lock().await = Some(sender);
                info!("[Stream] Pre-registered video transceiver (codec-agnostic)");
            }
            Err(err) => {
                warn!("[Stream] Failed to pre-register video transceiver: {err:?}");
            }
        }

        // -- Connection state
        peer.on_ice_connection_state_change({
            let this = this.clone();
            Box::new(move |state| {
                let this = this.clone();
                Box::pin(async move {
                    this.on_ice_connection_state_change(state).await;
                })
            })
        });
        peer.on_peer_connection_state_change({
            let this = this.clone();
            Box::new(move |state| {
                let this = this.clone();
                Box::pin(async move {
                    this.on_peer_connection_state_change(state).await;
                })
            })
        });

        // -- Signaling
        peer.on_negotiation_needed({
            let this = this.clone();
            Box::new(move || {
                let this = this.clone();
                Box::pin(async move {
                    this.on_negotiation_needed().await;
                })
            })
        });
        peer.on_ice_candidate({
            let this = this.clone();
            Box::new(move |candidate| {
                let this = this.clone();
                Box::pin(async move {
                    this.on_ice_candidate(0, candidate).await;
                })
            })
        });

        spawn({
            let this = this.clone();

            async move {
                while let Some(message) = ipc_receiver.recv().await {
                    if let ServerIpcMessage::Stop = &message {
                        this.on_ipc_message(ServerIpcMessage::Stop).await;
                        return;
                    }

                    this.on_ipc_message(message).await;
                }
            }
        });

        // -- Data Channels
        peer.on_data_channel({
            let this = this.clone();
            Box::new(move |channel| {
                let this = this.clone();
                Box::pin(async move {
                    this.on_data_channel(0, channel).await;
                })
            })
        });

        Ok(this)
    }

    // -- Handle Connection State
    async fn on_ice_connection_state_change(self: &Arc<Self>, state: RTCIceConnectionState) {
        if matches!(state, RTCIceConnectionState::Connected) {
            info!("[Stream]: ICE connected");
        }
    }
    async fn on_peer_connection_state_change(&self, state: RTCPeerConnectionState) {
        match state {
            RTCPeerConnectionState::Failed => {
                // Attempt ICE restart once before giving up
                if !self.ice_restart_attempted.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    warn!("[Stream]: Peer connection failed, attempting ICE restart...");
                    self.send_offer_with_ice_restart().await;
                } else {
                    warn!("[Stream]: Peer connection failed after ICE restart, stopping.");
                    self.stop().await;
                }
            }
            RTCPeerConnectionState::Connected => {
                // Reset ICE restart flag on successful reconnection
                self.ice_restart_attempted.store(false, std::sync::atomic::Ordering::SeqCst);
            }
            RTCPeerConnectionState::Closed => {
                self.stop().await;
            }
            _ => {}
        }
    }

    // -- Handle Signaling
    async fn on_negotiation_needed(&self) {
        // Do nothing
    }

    async fn send_answer(&self, peer: &Arc<RTCPeerConnection>, client_id: u32) -> bool {
        let local_description = match peer.create_answer(None).await {
            Err(err) => {
                warn!("[Signaling]: failed to create answer: {err:?}");
                return false;
            }
            Ok(value) => value,
        };

        if let Err(err) = peer.set_local_description(local_description.clone()).await {
            warn!("[Signaling]: failed to set local description: {err:?}");
            return false;
        }

        debug!(
            "[Signaling] Sending Local Description as Answer (client {client_id}): {:?}",
            local_description.sdp
        );

        self.ipc_sender
            .clone()
            .send(StreamerIpcMessage::WebSocket {
                client_id,
                message: StreamServerMessage::Signaling(StreamSignalingMessage::Description(
                    RtcSessionDescription {
                        ty: from_webrtc_sdp(local_description.sdp_type),
                        sdp: local_description.sdp,
                    },
                )),
            })
            .await;

        true
    }

    async fn send_offer_with_ice_restart(&self) -> bool {
        let options = RTCOfferOptions {
            ice_restart: true,
            ..Default::default()
        };
        let local_description = match self.peer.create_offer(Some(options)).await {
            Err(err) => {
                warn!("[Signaling]: failed to create ICE restart offer: {err:?}");
                return false;
            }
            Ok(value) => value,
        };

        if let Err(err) = self
            .peer
            .set_local_description(local_description.clone())
            .await
        {
            warn!("[Signaling]: failed to set local description for ICE restart: {err:?}");
            return false;
        }

        info!(
            "[Signaling] Sending ICE Restart Offer"
        );

        self.ipc_sender
            .clone()
            .send(StreamerIpcMessage::WebSocket {
                client_id: 0,
                message: StreamServerMessage::Signaling(StreamSignalingMessage::Description(
                    RtcSessionDescription {
                        ty: from_webrtc_sdp(local_description.sdp_type),
                        sdp: local_description.sdp,
                    },
                )),
            })
            .await;

        true
    }

    /// Returns the WebRTC peer for `client_id` (0 = primary AV peer, anything
    /// else = an attached input-only peer), or `None` if it doesn't exist
    /// (e.g. it was detached, or the client_id is unknown).
    async fn peer_for(&self, client_id: u32) -> Option<Arc<RTCPeerConnection>> {
        if client_id == 0 {
            Some(self.peer.clone())
        } else {
            self.secondary_peers.read().await.get(&client_id).cloned()
        }
    }

    async fn on_ipc_message(self: &Arc<Self>, message: ServerIpcMessage) {
        match message {
            ServerIpcMessage::Init { .. } => {}
            ServerIpcMessage::WebSocket { client_id, message } => {
                self.on_ws_message(client_id, message).await;
            }
            ServerIpcMessage::AttachInputClient { client_id } => {
                self.attach_input_peer(client_id).await;
            }
            ServerIpcMessage::DetachInputClient { client_id } => {
                self.detach_input_peer(client_id).await;
            }
            ServerIpcMessage::Stop => {
                self.stop().await;
            }
        }
    }
    async fn on_ws_message(&self, client_id: u32, message: StreamClientMessage) {
        match message {
            StreamClientMessage::Signaling(StreamSignalingMessage::Description(description)) => {
                let Some(peer) = self.peer_for(client_id).await else {
                    warn!("[Signaling]: received description for unknown client {client_id}");
                    return;
                };

                debug!(
                    "[Signaling] Received Remote Description (client {client_id}): {:?}",
                    description
                );

                // Keep the raw SDP before converting (we'll need it to extract candidates)
                let raw_sdp = description.sdp.clone();

                let description = match &description.ty {
                    RtcSdpType::Offer => RTCSessionDescription::offer(description.sdp),
                    RtcSdpType::Answer => RTCSessionDescription::answer(description.sdp),
                    RtcSdpType::Pranswer => RTCSessionDescription::pranswer(description.sdp),
                    _ => {
                        warn!(
                            "[Signaling]: failed to handle RTCSdpType {:?}",
                            description.ty
                        );
                        return;
                    }
                };

                let Ok(description) = description else {
                    warn!("[Signaling]: Received invalid RTCSessionDescription");
                    return;
                };

                let remote_ty = description.sdp_type;
                if let Err(err) = peer.set_remote_description(description).await {
                    warn!("[Signaling]: failed to set remote description: {err:?}");
                    return;
                }

                // Workaround for webrtc-rs mDNS resolution stalling candidate pair formation:
                // Explicitly add non-mDNS candidates from the SDP so that srflx/host IP
                // candidates always form pairs, even if mDNS resolution is blocked/slow.
                self.inject_non_mdns_candidates(&peer, &raw_sdp).await;

                // Send an answer (local description) if we got an offer
                if remote_ty == RTCSdpType::Offer {
                    self.send_answer(&peer, client_id).await;
                }
            }
            StreamClientMessage::Signaling(StreamSignalingMessage::AddIceCandidate(
                description,
            )) => {
                let Some(peer) = self.peer_for(client_id).await else {
                    warn!("[Signaling]: received ice candidate for unknown client {client_id}");
                    return;
                };

                debug!("[Signaling] Received Ice Candidate (client {client_id})");

                if let Err(err) = peer
                    .add_ice_candidate(RTCIceCandidateInit {
                        candidate: description.candidate,
                        sdp_mid: description.sdp_mid,
                        sdp_mline_index: description.sdp_mline_index,
                        username_fragment: description.username_fragment,
                    })
                    .await
                {
                    warn!("[Signaling]: failed to add ice candidate: {err:?}");
                }
            }
            // This should already be done
            StreamClientMessage::AuthenticateAndInit { .. } => {}
            StreamClientMessage::AuthenticateAndAttachInput { .. } => {}
            StreamClientMessage::ClientLog { log } => {
                info!("[Client Log]:\n{log}");
            }
        }
    }

    async fn on_ice_candidate(&self, client_id: u32, candidate: Option<RTCIceCandidate>) {
        let Some(candidate) = candidate else {
            return;
        };

        let Ok(candidate_json) = candidate.to_json() else {
            return;
        };

        debug!(
            "[Signaling] Sending Ice Candidate (client {client_id}): {}",
            candidate_json.candidate
        );

        let message = StreamServerMessage::Signaling(StreamSignalingMessage::AddIceCandidate(
            RtcIceCandidate {
                candidate: candidate_json.candidate,
                sdp_mid: candidate_json.sdp_mid,
                sdp_mline_index: candidate_json.sdp_mline_index,
                username_fragment: candidate_json.username_fragment,
            },
        ));

        self.ipc_sender
            .clone()
            .send(StreamerIpcMessage::WebSocket { client_id, message })
            .await;
    }

    // -- Data Channels
    async fn on_data_channel(self: &Arc<Self>, client_id: u32, channel: Arc<RTCDataChannel>) {
        self.input.on_data_channel(client_id, self, channel).await;
    }

    // -- Input-only peers
    /// Creates a second, video/audio-free WebRTC peer for `client_id`, driving
    /// the same shared `stream` (MoonlightStream) as the primary AV peer. Used
    /// when a second browser connection attaches keyboard/mouse/touch input
    /// to an already-running stream.
    async fn attach_input_peer(self: &Arc<Self>, client_id: u32) {
        info!("[Stream]: attaching input-only peer for client {client_id}");

        let peer = match self.api.new_peer_connection(self.rtc_config.clone()).await {
            Ok(value) => Arc::new(value),
            Err(err) => {
                warn!("[Stream]: failed to create input-only peer for client {client_id}: {err:?}");
                return;
            }
        };

        peer.on_ice_candidate({
            let this = self.clone();
            Box::new(move |candidate| {
                let this = this.clone();
                Box::pin(async move {
                    this.on_ice_candidate(client_id, candidate).await;
                })
            })
        });

        peer.on_data_channel({
            let this = self.clone();
            Box::new(move |channel| {
                let this = this.clone();
                Box::pin(async move {
                    this.on_data_channel(client_id, channel).await;
                })
            })
        });

        peer.on_peer_connection_state_change({
            let this = self.clone();
            Box::new(move |state| {
                let this = this.clone();
                Box::pin(async move {
                    // No ICE-restart handling for input-only peers: just drop them.
                    // The primary AV connection's lifecycle is unaffected either way.
                    if matches!(
                        state,
                        RTCPeerConnectionState::Closed | RTCPeerConnectionState::Failed
                    ) {
                        this.detach_input_peer(client_id).await;
                    }
                })
            })
        });

        let ice_servers = self
            .rtc_config
            .ice_servers
            .iter()
            .cloned()
            .map(from_webrtc_ice)
            .collect();

        let count = {
            let mut secondary_peers = self.secondary_peers.write().await;
            secondary_peers.insert(client_id, peer);
            secondary_peers.len() as u32
        };

        self.ipc_sender
            .clone()
            .send(StreamerIpcMessage::WebSocket {
                client_id,
                message: StreamServerMessage::WebRtcConfig { ice_servers },
            })
            .await;

        self.broadcast_input_client_count(count).await;
    }

    /// Tears down the input-only peer for `client_id`, if any. Does not touch
    /// the primary AV connection or the shared MoonlightStream.
    async fn detach_input_peer(&self, client_id: u32) {
        // Remove from the map and release the lock *before* closing the peer:
        // `close()` tears down ICE/SRTP and can take a while, and holding the
        // write lock across it would block every other call that needs this
        // lock — including a concurrent `attach_input_peer` for a different
        // client, which goes through the same serial IPC-message loop and
        // would then be stuck waiting on this lock for as long as `close()`
        // takes (or worse, if it never returns).
        let peer = {
            let mut secondary_peers = self.secondary_peers.write().await;
            secondary_peers.remove(&client_id)
        };

        let count = if let Some(peer) = peer {
            let _ = peer.close().await;
            info!("[Stream]: detached input-only peer for client {client_id}");
            Some(self.secondary_peers.read().await.len() as u32)
        } else {
            None
        };

        // Release any gamepad slots this client held, in case it never sent
        // an explicit controller-removal message (e.g. an abrupt drop).
        self.input.release_client_gamepads(client_id, self).await;

        if let Some(count) = count {
            self.broadcast_input_client_count(count).await;
        }
    }

    /// Lets the primary (AV) client know how many input-only devices are
    /// currently attached, so its UI can show an indicator.
    async fn broadcast_input_client_count(&self, count: u32) {
        if let Some(message) =
            serialize_json(&StreamServerGeneralMessage::InputClientsChanged { count })
        {
            let _ = self.general_channel.send_text(message).await;
        }
    }

    /// Parse non-mDNS `a=candidate:` lines from an SDP and explicitly add them
    /// via `add_ice_candidate()`. This works around a webrtc-rs issue where mDNS
    /// resolution can stall the entire candidate-pair formation pipeline, preventing
    /// srflx and real-IP host candidates from ever being paired.
    async fn inject_non_mdns_candidates(&self, peer: &Arc<RTCPeerConnection>, sdp: &str) {
        // Determine media-line indices (m= lines) to set sdp_mline_index correctly.
        let mut mline_index: u16 = 0;
        let mut mid: Option<String> = None;
        let mut injected = 0u32;

        for line in sdp.lines() {
            let line = line.trim();
            if line.starts_with("m=") {
                if mline_index > 0 || mid.is_some() {
                    // New m= section: increment index
                    mline_index += 1;
                    mid = None;
                } else {
                    // First m= line
                }
            } else if line.starts_with("a=mid:") {
                mid = Some(line[6..].to_string());
            } else if let Some(candidate_attr) = line.strip_prefix("a=candidate:") {
                // Full candidate string as browsers send it (without "a=" prefix but with "candidate:")
                let candidate_str = format!("candidate:{candidate_attr}");

                // Skip mDNS candidates (contain .local hostnames)
                if candidate_str.contains(".local") {
                    continue;
                }

                // Skip empty/malformed
                if candidate_attr.split_whitespace().count() < 8 {
                    continue;
                }

                debug!("[Signaling] Injecting non-mDNS candidate: {}", candidate_str);
                if let Err(err) = peer
                    .add_ice_candidate(RTCIceCandidateInit {
                        candidate: candidate_str,
                        sdp_mid: mid.clone(),
                        sdp_mline_index: Some(mline_index),
                        username_fragment: None,
                    })
                    .await
                {
                    warn!("[Signaling]: failed to inject candidate: {err:?}");
                } else {
                    injected += 1;
                }
            }
        }

        if injected > 0 {
            info!("[Signaling] Injected {injected} non-mDNS candidate(s) from remote SDP");
        }
    }

    // Start Moonlight Stream
    async fn start_stream(self: &Arc<Self>) -> Result<(), anyhow::Error> {
        // Guard: only start once (prevents double-start on ICE reconnection)
        if self.stream_start_initiated.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }

        // Send stage
        let mut ipc_sender = self.ipc_sender.clone();
        ipc_sender
            .send(StreamerIpcMessage::WebSocket {
                client_id: 0,
                message: StreamServerMessage::StageStarting {
                    stage: "Moonlight Stream".to_string(),
                },
            })
            .await;

        let mut host = self.info.host.lock().await;

        let gamepads = self.input.active_gamepads.read().await;

        let video_decoder = TrackSampleVideoDecoder::new(
            self.clone(),
            self.settings.video_supported_formats,
            self.settings.video_sample_queue_size as usize,
        );

        let audio_decoder = OpusTrackSampleAudioDecoder::new(
            self.audio_channel.clone(),
            self.audio_channel_open.clone(),
        );

        let connection_listener = StreamConnectionListener::new(self.clone());

        let stream = match host
            .start_stream(
                &self.moonlight,
                self.info.app_id,
                self.settings.width,
                self.settings.height,
                self.settings.fps,
                false,
                true,
                self.settings.play_audio_local,
                *gamepads,
                false,
                self.settings.video_colorspace,
                if self.settings.video_color_range_full {
                    ColorRange::Full
                } else {
                    ColorRange::Limited
                },
                self.settings.bitrate,
                self.settings.packet_size,
                EncryptionFlags::all(),
                connection_listener,
                video_decoder,
                audio_decoder,
            )
            .await
        {
            Ok(value) => value,
            Err(err) => {
                warn!("[Stream]: failed to start moonlight stream: {err:?}");

                #[allow(clippy::single_match)]
                match err {
                    HostError::Moonlight(MoonlightError::ConnectionAlreadyExists) => {
                        ipc_sender
                            .send(StreamerIpcMessage::WebSocket {
                                client_id: 0,
                                message: StreamServerMessage::AlreadyStreaming,
                            })
                            .await;
                    }
                    _ => {}
                }

                return Err(err.into());
            }
        };

        let host_features = stream.host_features().unwrap_or_else(|err| {
            warn!("[Stream]: failed to get host features: {err:?}");
            HostFeatures::empty()
        });

        let capabilities = StreamCapabilities {
            touch: host_features.contains(HostFeatures::PEN_TOUCH_EVENTS),
        };

        let (width, height) = {
            let video_size = self.video_size.lock().await;
            if *video_size == (0, 0) {
                (self.settings.width, self.settings.height)
            } else {
                *video_size
            }
        };

        spawn(async move {
            ipc_sender
                .send(StreamerIpcMessage::WebSocket {
                    client_id: 0,
                    message: StreamServerMessage::ConnectionComplete {
                        capabilities,
                        width,
                        height,
                    },
                })
                .await;
        });

        drop(gamepads);

        let mut stream_guard = self.stream.write().await;
        stream_guard.replace(stream);

        Ok(())
    }

    async fn stop(&self) {
        debug!("[Stream]: Stopping...");

        let mut ipc_sender = self.ipc_sender.clone();
        spawn(async move {
            ipc_sender
                .send(StreamerIpcMessage::WebSocket {
                    client_id: 0,
                    message: StreamServerMessage::PeerDisconnect,
                })
                .await;
        });

        let general_channel = self.general_channel.clone();
        spawn(async move {
            if let Some(message) = serialize_json(&StreamServerGeneralMessage::ConnectionTerminated)
            {
                let _ = general_channel.send_text(message).await;
            }
        });

        let stream = {
            let mut stream = self.stream.write().await;
            stream.take()
        };
        if let Err(err) = spawn_blocking(move || {
            drop(stream);
        })
        .await
        {
            warn!("[Stream]: failed to stop stream: {err}");
        };

        // Close any attached input-only peers too — the process is exiting.
        for (_, peer) in self.secondary_peers.write().await.drain() {
            let _ = peer.close().await;
        }

        let mut ipc_sender = self.ipc_sender.clone();
        ipc_sender.send(StreamerIpcMessage::Stop).await;

        info!("Terminating Self");
        self.terminate.notify_waiters();
    }
}

/// Probe whether Sunshine is reachable on localhost (same machine) or LAN address.
/// Returns the working local address if found, or None to fall back to the configured address.
/// Uses a very short timeout so this adds negligible delay when Sunshine is remote.
async fn try_localhost(http_port: u16) -> Option<String> {
    use std::time::Duration;
    use tokio::net::TcpStream;
    use tokio::time::timeout;

    let probe_timeout = Duration::from_millis(100);

    // Try 127.0.0.1 first (same machine)
    let addr = format!("127.0.0.1:{http_port}");
    if timeout(probe_timeout, TcpStream::connect(&addr)).await.ok()?.is_ok() {
        return Some("127.0.0.1".to_string());
    }

    None
}
