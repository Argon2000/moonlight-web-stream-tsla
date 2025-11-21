use std::{panic, process::exit, str::FromStr, sync::Arc};

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
        peer_connection_state::RTCPeerConnectionState,
        sdp::{sdp_type::RTCSdpType, session_description::RTCSessionDescription},
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
        .send(StreamerIpcMessage::WebSocket(
            StreamServerMessage::StageComplete {
                stage: "Launch Streamer".to_string(),
            },
        ))
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
        .send(StreamerIpcMessage::WebSocket(
            StreamServerMessage::StageStarting {
                stage: "Setup WebRTC Peer".to_string(),
            },
        ))
        .await;

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
    if let Some(mapping) = server_config.webrtc_nat_1to1 {
        api_settings.set_nat_1to1_ips(
            mapping.ips.clone(),
            into_webrtc_ice_candidate(mapping.ice_candidate_type),
        );
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
        &api,
        rtc_config,
    )
    .await
    .expect("failed to create connection");

    // Send stage
    ipc_sender
        .send(StreamerIpcMessage::WebSocket(
            StreamServerMessage::StageComplete {
                stage: "Setup WebRTC Peer".to_string(),
            },
        ))
        .await;

    // Send stage
    ipc_sender
        .send(StreamerIpcMessage::WebSocket(
            StreamServerMessage::StageStarting {
                stage: "WebRTC Peer Negotiation".to_string(),
            },
        ))
        .await;

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
    // Stream
    pub stream: RwLock<Option<MoonlightStream>>,
    pub terminate: Notify,
}

impl StreamConnection {
    pub async fn new(
        moonlight: MoonlightInstance,
        info: StreamInfo,
        settings: StreamSettings,
        mut ipc_sender: IpcSender<StreamerIpcMessage>,
        mut ipc_receiver: IpcReceiver<ServerIpcMessage>,
        api: &API,
        config: RTCConfiguration,
    ) -> Result<Arc<Self>, anyhow::Error> {
        // Send WebRTC Info
        ipc_sender
            .send(StreamerIpcMessage::WebSocket(
                StreamServerMessage::WebRtcConfig {
                    ice_servers: config
                        .ice_servers
                        .iter()
                        .cloned()
                        .map(from_webrtc_ice)
                        .collect(),
                },
            ))
            .await;

        let peer = Arc::new(api.new_peer_connection(config).await?);

        // -- Input
        let input = StreamInput::new();

        let general_channel = peer.create_data_channel("general", None).await?;
        let audio_channel = peer
            .create_data_channel(
                "audio",
                Some(RTCDataChannelInit {
                    ordered: Some(true),
                    max_packet_life_time: Some(100),
                    ..Default::default()
                }),
            )
            .await?;

        let this = Arc::new(Self {
            runtime: Handle::current(),
            moonlight,
            info,
            settings,
            peer: peer.clone(),
            ipc_sender,
            general_channel,
            audio_channel,
            video_size: Mutex::new((0, 0)),
            input,
            stream: Default::default(),
            terminate: Notify::new(),
        });

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
                    this.on_ice_candidate(candidate).await;
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
                    this.on_data_channel(channel).await;
                })
            })
        });

        Ok(this)
    }

    // -- Handle Connection State
    async fn on_ice_connection_state_change(self: &Arc<Self>, state: RTCIceConnectionState) {
        #[allow(clippy::collapsible_if)]
        if matches!(state, RTCIceConnectionState::Connected) {
            if let Err(err) = self.start_stream().await {
                warn!("[Stream]: failed to start stream: {err:?}");

                self.stop().await;
            }
        }
    }
    async fn on_peer_connection_state_change(&self, state: RTCPeerConnectionState) {
        if matches!(
            state,
            RTCPeerConnectionState::Failed
                | RTCPeerConnectionState::Disconnected
                | RTCPeerConnectionState::Closed
        ) {
            self.stop().await;
        }
    }

    // -- Handle Signaling
    async fn on_negotiation_needed(&self) {
        // Do nothing
    }

    async fn send_answer(&self) -> bool {
        let local_description = match self.peer.create_answer(None).await {
            Err(err) => {
                warn!("[Signaling]: failed to create answer: {err:?}");
                return false;
            }
            Ok(value) => value,
        };

        if let Err(err) = self
            .peer
            .set_local_description(local_description.clone())
            .await
        {
            warn!("[Signaling]: failed to set local description: {err:?}");
            return false;
        }

        debug!(
            "[Signaling] Sending Local Description as Answer: {:?}",
            local_description.sdp
        );

        self.ipc_sender
            .clone()
            .send(StreamerIpcMessage::WebSocket(
                StreamServerMessage::Signaling(StreamSignalingMessage::Description(
                    RtcSessionDescription {
                        ty: from_webrtc_sdp(local_description.sdp_type),
                        sdp: local_description.sdp,
                    },
                )),
            ))
            .await;

        true
    }
    async fn send_offer(&self) -> bool {
        let local_description = match self.peer.create_offer(None).await {
            Err(err) => {
                warn!("[Signaling]: failed to create offer: {err:?}");
                return false;
            }
            Ok(value) => value,
        };

        if let Err(err) = self
            .peer
            .set_local_description(local_description.clone())
            .await
        {
            warn!("[Signaling]: failed to set local description: {err:?}");
            return false;
        }

        debug!(
            "[Signaling] Sending Local Description as Offer: {:?}",
            local_description.sdp
        );

        self.ipc_sender
            .clone()
            .send(StreamerIpcMessage::WebSocket(
                StreamServerMessage::Signaling(StreamSignalingMessage::Description(
                    RtcSessionDescription {
                        ty: from_webrtc_sdp(local_description.sdp_type),
                        sdp: local_description.sdp,
                    },
                )),
            ))
            .await;

        true
    }

    async fn on_ipc_message(&self, message: ServerIpcMessage) {
        match message {
            ServerIpcMessage::Init { .. } => {}
            ServerIpcMessage::WebSocket(message) => {
                self.on_ws_message(message).await;
            }
            ServerIpcMessage::Stop => {
                self.stop().await;
            }
        }
    }
    async fn on_ws_message(&self, message: StreamClientMessage) {
        match message {
            StreamClientMessage::Signaling(StreamSignalingMessage::Description(description)) => {
                debug!("[Signaling] Received Remote Description: {:?}", description);

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
                if let Err(err) = self.peer.set_remote_description(description).await {
                    warn!("[Signaling]: failed to set remote description: {err:?}");
                    return;
                }

                // Send an answer (local description) if we got an offer
                if remote_ty == RTCSdpType::Offer {
                    self.send_answer().await;
                }
            }
            StreamClientMessage::Signaling(StreamSignalingMessage::AddIceCandidate(
                description,
            )) => {
                debug!("[Signaling] Received Ice Candidate");

                if let Err(err) = self
                    .peer
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
        }
    }

    async fn on_ice_candidate(&self, candidate: Option<RTCIceCandidate>) {
        let Some(candidate) = candidate else {
            return;
        };

        let Ok(candidate_json) = candidate.to_json() else {
            return;
        };

        debug!(
            "[Signaling] Sending Ice Candidate: {}",
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
            .send(StreamerIpcMessage::WebSocket(message))
            .await;
    }

    // -- Data Channels
    async fn on_data_channel(self: &Arc<Self>, channel: Arc<RTCDataChannel>) {
        self.input.on_data_channel(self, channel).await;
    }

    // Start Moonlight Stream
    async fn start_stream(self: &Arc<Self>) -> Result<(), anyhow::Error> {
        // Send stage
        let mut ipc_sender = self.ipc_sender.clone();
        ipc_sender
            .send(StreamerIpcMessage::WebSocket(
                StreamServerMessage::StageStarting {
                    stage: "Moonlight Stream".to_string(),
                },
            ))
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
                            .send(StreamerIpcMessage::WebSocket(
                                StreamServerMessage::AlreadyStreaming,
                            ))
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
                .send(StreamerIpcMessage::WebSocket(
                    StreamServerMessage::ConnectionComplete {
                        capabilities,
                        width,
                        height,
                    },
                ))
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
                .send(StreamerIpcMessage::WebSocket(
                    StreamServerMessage::PeerDisconnect,
                ))
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

        let mut ipc_sender = self.ipc_sender.clone();
        ipc_sender.send(StreamerIpcMessage::Stop).await;

        info!("Terminating Self");
        self.terminate.notify_waiters();
    }
}
