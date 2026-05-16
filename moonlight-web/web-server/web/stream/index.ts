import { Api } from "../api.js"
import { App, ConnectionStatus, RtcIceCandidate, StreamCapabilities, StreamClientMessage, StreamServerGeneralMessage, StreamServerMessage } from "../api_bindings.js"
import { StreamSettings } from "../component/settings_menu.js"
import { defaultStreamInputConfig, StreamInput } from "./input.js"
import { createSupportedVideoFormatsBits, VideoCodecSupport } from "./video.js"
// @ts-ignore
import Module from "./opus-stream-decoder.mjs"

type AudioDecodeWorkerInMessage =
    | { type: "init" }
    | { type: "decode"; packet: ArrayBuffer }
    | { type: "free" }

type AudioDecodeWorkerOutMessage =
    | { type: "ready" }
    | { type: "decoded"; left: ArrayBuffer; right: ArrayBuffer }
    | { type: "error"; message: string }

export type InfoEvent = CustomEvent<
    { type: "app", app: App } |
    { type: "error", message: string } |
    { type: "stageStarting" | "stageComplete", stage: string } |
    { type: "stageFailed", stage: string, errorCode: number } |
    { type: "connectionComplete", capabilities: StreamCapabilities } |
    { type: "connectionStatus", status: ConnectionStatus } |
    { type: "connectionTerminated", errorCode: number } |
    { type: "connectionRecovered" } |
    { type: "addDebugLine", line: string } |
    { type: "videoTrack", track: MediaStreamTrack}
>
export type InfoEventListener = (event: InfoEvent) => void

export type StreamAudioDiagnostics = {
    decoderReady: boolean
    audioContextState: string
    receivedPackets: number
    decodedPackets: number
    receivedBytes: number
    decodeErrors: number
    underruns: number
    resyncs: number
    droppedBufferedSources: number
    droppedLatencyFlushes: number
    droppedCleanupSources: number
    queuedSources: number
    bufferLeadMs: number
    lastPacketGapMs: number
    avgPacketGapMs: number
    maxPacketGapMs: number
    latePacketGaps: number
    currentTime: number
    nextAudioTime: number
}

export type StreamWorkerDiagnostics = {
    workersAllowedBySettings: boolean
    audioWorkerAttempted: boolean
    audioWorkerActive: boolean
    audioWorkerError: string | null
    audioDecoderMode: "worker" | "main-thread" | "not-ready"
}

export function getStreamerSize(settings: StreamSettings, viewerScreenSize: [number, number]): [number, number] {
    let width, height
    if (settings.videoSize == "720p") {
        width = 1280
        height = 720
    } else if (settings.videoSize == "1080p") {
        width = 1920
        height = 1080
    } else if (settings.videoSize == "1440p") {
        width = 2560
        height = 1440
    } else if (settings.videoSize == "4k") {
        width = 3840
        height = 2160
    } else if (settings.videoSize == "custom") {
        width = settings.videoSizeCustom.width
        height = settings.videoSizeCustom.height
    } else { // native
        width = viewerScreenSize[0]
        height = viewerScreenSize[1]
    }
    return [width, height]
}

export class Stream {
    private api: Api
    private hostId: number
    private appId: number

    private settings: StreamSettings

    private eventTarget = new EventTarget()

    private mediaStream: MediaStream = new MediaStream()

    private ws: WebSocket

    private peer: RTCPeerConnection | null = null
    private input: StreamInput

    private streamerSize: [number, number]

    private audioContext: AudioContext | null = null
    private mainGainNode: GainNode | null = null
    private audioDecoder: any = null
    private audioDecodeWorker: Worker | null = null
    private useAudioDecodeWorker: boolean = false
    private audioDecodeWorkerAllowed: boolean
    private audioDecodeWorkerInitAttempted: boolean = false
    private audioDecodeWorkerInitError: string | null = null
    private audioDecodeWorkerInitTimeoutId: ReturnType<typeof setTimeout> | null = null
    private decoderInitInFlight: boolean = false
    private audioDecoderReady: boolean = false
    private nextAudioTime: number = 0
    private sourceNodes: Set<AudioBufferSourceNode> = new Set()
    private isFirstAudioPacket: boolean = true
    private audioPacketsReceived: number = 0
    private audioPacketsDecoded: number = 0
    private audioBytesReceived: number = 0
    private audioDecodeErrors: number = 0
    private audioUnderruns: number = 0
    private audioResyncs: number = 0
    private audioDroppedBufferedSources: number = 0
    private audioDroppedLatencyFlushes: number = 0
    private audioDroppedCleanupSources: number = 0
    private lastAudioPacketAt: number = 0
    private audioLastPacketGapMs: number = 0
    private audioAvgPacketGapMs: number = 0
    private audioMaxPacketGapMs: number = 0
    private audioLatePacketGaps: number = 0

    constructor(api: Api, hostId: number, appId: number, settings: StreamSettings, supportedVideoFormats: VideoCodecSupport, viewerScreenSize: [number, number]) {
        this.api = api
        this.hostId = hostId
        this.appId = appId

        this.settings = settings
        this.audioDecodeWorkerAllowed = settings.useWorkers

        this.streamerSize = getStreamerSize(settings, viewerScreenSize)

        // Configure web socket
        this.ws = new WebSocket(`${api.host_url}/host/stream`)
        this.ws.addEventListener("error", this.onError.bind(this))
        this.ws.addEventListener("open", this.onWsOpen.bind(this))
        this.ws.addEventListener("close", this.onWsClose.bind(this))
        this.ws.addEventListener("message", this.onRawWsMessage.bind(this))

        const fps = this.settings.fps

        this.sendWsMessage({
            AuthenticateAndInit: {
                credentials: this.api.credentials,
                host_id: this.hostId,
                app_id: this.appId,
                bitrate: this.settings.bitrate,
                packet_size: this.settings.packetSize,
                fps,
                width: this.streamerSize[0],
                height: this.streamerSize[1],
                video_sample_queue_size: this.settings.videoSampleQueueSize,
                play_audio_local: this.settings.playAudioLocal,
                audio_sample_queue_size: this.settings.audioSampleQueueSize,
                video_supported_formats: createSupportedVideoFormatsBits(supportedVideoFormats),
                video_colorspace: "Rec709", // TODO <---
                video_color_range_full: true, // TODO <---
            }
        })

        // Stream Input
        const streamInputConfig = defaultStreamInputConfig()
        Object.assign(streamInputConfig, {
            mouseScrollMode: this.settings.mouseScrollMode,
            controllerConfig: this.settings.controllerConfig
        })
        this.input = new StreamInput(streamInputConfig)

        // Dispatch info for next frame so that listeners can be registers
        setTimeout(() => {
            this.debugLog("Requesting Stream with attributes: {")
            // Width, Height, Fps
            this.debugLog(`  Width ${this.streamerSize[0]}`)
            this.debugLog(`  Height ${this.streamerSize[1]}`)
            this.debugLog(`  Fps: ${fps}`)

            // Supported Video Formats
            const supportedVideoFormatsText = []
            for (const item in supportedVideoFormats) {
                if (supportedVideoFormats[item]) {
                    supportedVideoFormatsText.push(item)
                }
            }
            this.debugLog(`  Supported Video Formats: ${createPrettyList(supportedVideoFormatsText)}`)

            this.debugLog("}")
        })

        void this.setupDecoder()
        this.setupAudioContext()
    }

    private async setupDecoder() {
        if (this.audioDecoderReady || this.decoderInitInFlight) {
            return
        }

        this.decoderInitInFlight = true
        if (this.trySetupAudioDecodeWorker()) {
            // decoderInitInFlight stays true — cleared when worker sends "ready" or fallback completes
            return
        }

        await this.setupDecoderFallback()
        this.decoderInitInFlight = false
    }

    private clearAudioWorkerInitTimeout() {
        if (this.audioDecodeWorkerInitTimeoutId) {
            clearTimeout(this.audioDecodeWorkerInitTimeoutId)
            this.audioDecodeWorkerInitTimeoutId = null
        }
    }

    private async fallbackFromAudioWorker(reason: string) {
        this.clearAudioWorkerInitTimeout()
        this.audioDecodeWorkerInitError = reason
        this.audioDecodeWorker?.terminate()
        this.audioDecodeWorker = null
        this.useAudioDecodeWorker = false
        this.audioDecoderReady = false
        // decoderInitInFlight stays true to prevent resumeAudio from triggering another setupDecoder
        await this.setupDecoderFallback()
        this.decoderInitInFlight = false
    }

    private trySetupAudioDecodeWorker(): boolean {
        this.audioDecodeWorkerInitAttempted = true
        if (!this.audioDecodeWorkerAllowed) {
            this.audioDecodeWorkerInitError = "Disabled by settings"
            return false
        }

        if (typeof Worker === "undefined") {
            this.audioDecodeWorkerInitError = "Worker API unsupported"
            return false
        }

        try {
            this.audioDecodeWorker = new Worker(new URL("./audio_decode_worker.js", import.meta.url), { type: "module" })
            this.audioDecodeWorker.onmessage = (event: MessageEvent<AudioDecodeWorkerOutMessage>) => {
                const data = event.data
                if (!data) return

                if (data.type === "ready") {
                    this.clearAudioWorkerInitTimeout()
                    this.audioDecoderReady = true
                    this.useAudioDecodeWorker = true
                    this.decoderInitInFlight = false
                    this.audioDecodeWorkerInitError = null
                    this.debugLog("Audio decode worker ready")
                    return
                }

                if (data.type === "decoded") {
                    const left = new Float32Array(data.left)
                    const right = new Float32Array(data.right)
                    this.playPcm(left, right)
                    return
                }

                if (data.type === "error") {
                    this.audioDecodeErrors++
                    console.error("Audio decode worker error", data.message)
                    this.debugLog(`Audio decode worker error: ${data.message}`)
                    if (!this.audioDecoderReady) {
                        this.fallbackFromAudioWorker(`Worker init error: ${data.message}`)
                    }
                }
            }

            this.audioDecodeWorker.onerror = (event) => {
                this.audioDecodeErrors++
                console.error("Audio decode worker failed", event)
                this.debugLog("Audio decode worker failed, falling back to main-thread decode")
                this.fallbackFromAudioWorker("Worker runtime error")
            }

            const initMessage: AudioDecodeWorkerInMessage = { type: "init" }
            this.audioDecodeWorker.postMessage(initMessage)

            // Some browsers may never deliver a worker error event on module init failure.
            // Fall back automatically if worker does not become ready in time.
            this.clearAudioWorkerInitTimeout()
            this.audioDecodeWorkerInitTimeoutId = setTimeout(() => {
                if (!this.audioDecoderReady) {
                    this.debugLog("Audio decode worker init timeout, falling back to main-thread decode")
                    this.fallbackFromAudioWorker("Worker init timeout")
                }
            }, 4000)
            return true
        } catch (e) {
            this.clearAudioWorkerInitTimeout()
            this.debugLog(`Audio decode worker unavailable, fallback to main-thread decode: ${e}`)
            this.audioDecodeWorker = null
            this.useAudioDecodeWorker = false
            this.audioDecodeWorkerInitError = String(e)
            return false
        }
    }

    private async setupDecoderFallback() {
        try {
            this.clearAudioWorkerInitTimeout()
            const decoderModule = Module()
            const OpusStreamDecoder = decoderModule.OpusStreamDecoder

            this.audioDecoder = new OpusStreamDecoder({
                onDecode: (decoded: any) => {
                    this.playPcm(decoded.left, decoded.right)
                },
            })

            await this.audioDecoder.ready;
            this.audioDecoderReady = true;
            this.useAudioDecodeWorker = false
            this.debugLog("Opus decoder ready (main thread)");
        } catch (e) {
            console.error("Failed to setup opus decoder", e);
            this.debugLog(`Failed to setup opus decoder: ${e}`);
        }
    }

    private setupAudioContext() {
        try {
            // @ts-ignore
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            // Force 48kHz to match Opus native rate and avoid resampling artifacts
            this.audioContext = new AudioContext({ sampleRate: 48000 });
            
            // Gain node to boost volume to match car audio levels
            this.mainGainNode = this.audioContext.createGain();
            this.mainGainNode.gain.value = 3.5;

            // Compressor acting as a limiter to prevent clipping distortion
            // This allows high gain without the harsh noise/humming from signal clipping
            const compressor = this.audioContext.createDynamicsCompressor();
            compressor.threshold.value = -3;   // Start limiting 3dB below max
            compressor.knee.value = 3;          // Gentle knee for smoother limiting
            compressor.ratio.value = 20;        // High ratio = hard limiter
            compressor.attack.value = 0.001;    // Fast attack to catch transients
            compressor.release.value = 0.05;    // Quick release to avoid pumping

            // Low-pass filter to cut high-frequency noise/aliasing artifacts
            const lpFilter = this.audioContext.createBiquadFilter();
            lpFilter.type = "lowpass";
            lpFilter.frequency.value = 20000;
            lpFilter.Q.value = 0.7;

            // Chain: source -> gain -> compressor/limiter -> lowpass -> destination
            this.mainGainNode.connect(compressor);
            compressor.connect(lpFilter);
            lpFilter.connect(this.audioContext.destination);

            this.monitorAudioContext();
        } catch (e) {
            console.error("Failed to create AudioContext", e);
        }
    }
    
    private monitorAudioContext() {
        if (this.audioContext) {
             this.audioContext.onstatechange = () => {
                 const state = this.audioContext?.state;
                 console.log(`[AudioContext] state change: ${state}`);
                 this.debugLog(`AudioContext state: ${state}`);
             };
        }
    }

    private playPcm(left: Float32Array, right: Float32Array) {
        if (!this.audioContext) return;

        // Resume context if suspended (autoplay policy)
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }

        const currentTime = this.audioContext.currentTime;
        this.audioPacketsDecoded++;
        
        if (this.isFirstAudioPacket) {
            // Larger initial buffer to allow smooth scheduling and avoid early underruns
            this.nextAudioTime = currentTime + 0.08;
            this.isFirstAudioPacket = false;
        }

        let ahead = this.nextAudioTime - currentTime;

        // Latency control with two thresholds:
        // 1) Soft overrun: keep audio continuous and gently catch up by slightly
        //    increasing playback rate for this chunk.
        // 2) Hard overrun: drop only this newly decoded chunk as last resort.
        const SOFT_OVERRUN = 0.15; // 150ms
        const HARD_OVERRUN = 0.30; // 300ms
        if (ahead > HARD_OVERRUN) {
            this.audioDroppedBufferedSources++;
            this.audioDroppedLatencyFlushes++;
            return;
        }

        if (ahead < -0.02) {
             // We are behind (underrun), resync with a small buffer
             this.audioUnderruns++;
             this.audioResyncs++;
             this.nextAudioTime = currentTime + 0.04;
        }

        const channels = 2;
        const frameCount = left.length;
        const audioBuffer = this.audioContext.createBuffer(channels, frameCount, 48000);

        audioBuffer.copyToChannel(left, 0);
        audioBuffer.copyToChannel(right, 1);

        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;

        // Soft catch-up: slightly faster playback drains buffered lead without
        // abrupt flushes that can produce static/pops.
        if (ahead > SOFT_OVERRUN) {
            // Scale 1.0 -> 1.06 between SOFT_OVERRUN and HARD_OVERRUN
            const t = Math.min(1, (ahead - SOFT_OVERRUN) / (HARD_OVERRUN - SOFT_OVERRUN));
            source.playbackRate.value = 1.0 + (0.06 * t);
        }

        if (this.mainGainNode) {
            source.connect(this.mainGainNode);
        } else {
            source.connect(this.audioContext.destination);
        }
        
        source.start(this.nextAudioTime);
        this.nextAudioTime += audioBuffer.duration / source.playbackRate.value;
        
        this.sourceNodes.add(source);
        source.onended = () => {
            this.sourceNodes.delete(source);
        };

        // Guard against sourceNodes leak if onended doesn't fire (constrained browsers)
        if (this.sourceNodes.size > 100) {
            for (const staleNode of this.sourceNodes) {
                if (staleNode !== source) {
                    try { staleNode.stop(); } catch(e) {}
                    this.sourceNodes.delete(staleNode);
                    this.audioDroppedBufferedSources++;
                    this.audioDroppedCleanupSources++;
                }
            }
        }
    }

    private debugLog(message: string) {
        for (const line of message.split("\n")) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "addDebugLine", line }
            })

            this.eventTarget.dispatchEvent(event)
        }
    }

    private async createPeer(configuration: RTCConfiguration) {
        this.debugLog(`Creating Client Peer`)

        if (this.peer) {
            this.debugLog(`Cannot create Peer because a Peer already exists`)
            return
        }

        // Configure web rtc
        this.peer = new RTCPeerConnection(configuration)
        this.peer.addEventListener("error", this.onError.bind(this))

        this.peer.addEventListener("negotiationneeded", this.onNegotiationNeeded.bind(this))
        this.peer.addEventListener("icecandidate", this.onIceCandidate.bind(this))

        this.peer.addEventListener("track", this.onTrack.bind(this))
        this.peer.addEventListener("datachannel", this.onDataChannel.bind(this))

        this.peer.addEventListener("connectionstatechange", this.onConnectionStateChange.bind(this))
        this.peer.addEventListener("iceconnectionstatechange", this.onIceConnectionStateChange.bind(this))

        this.input.setPeer(this.peer)

        // Maybe we already received data
        if (this.remoteDescription) {
            await this.handleRemoteDescription(this.remoteDescription)
        } else {
            await this.onNegotiationNeeded()
        }
        await this.tryDequeueIceCandidates()
    }

    private async onMessage(message: StreamServerMessage | StreamServerGeneralMessage) {
        if (typeof message == "string") {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "error", message }
            })

            this.eventTarget.dispatchEvent(event)
        } else if ("StageStarting" in message) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "stageStarting", stage: message.StageStarting.stage }
            })

            this.eventTarget.dispatchEvent(event)
        } else if ("StageComplete" in message) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "stageComplete", stage: message.StageComplete.stage }
            })

            this.eventTarget.dispatchEvent(event)
        } else if ("StageFailed" in message) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "stageFailed", stage: message.StageFailed.stage, errorCode: message.StageFailed.error_code }
            })

            this.eventTarget.dispatchEvent(event)
        } else if ("ConnectionTerminated" in message) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "connectionTerminated", errorCode: message.ConnectionTerminated.error_code }
            })

            this.eventTarget.dispatchEvent(event)
        } else if ("ConnectionStatusUpdate" in message) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "connectionStatus", status: message.ConnectionStatusUpdate.status }
            })

            this.eventTarget.dispatchEvent(event)
        } else if ("UpdateApp" in message) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "app", app: message.UpdateApp.app }
            })

            this.eventTarget.dispatchEvent(event)
        } else if ("ConnectionComplete" in message) {
            const capabilities = message.ConnectionComplete.capabilities
            const width = message.ConnectionComplete.width
            const height = message.ConnectionComplete.height

            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "connectionComplete", capabilities }
            })

            this.eventTarget.dispatchEvent(event)

            this.input.onStreamStart(capabilities, [width, height])
        }
        // -- WebRTC Config
        else if ("WebRtcConfig" in message) {
            const iceServers = message.WebRtcConfig.ice_servers

            this.createPeer({
                iceServers: iceServers
            })

            this.debugLog(`Using WebRTC Ice Servers: ${createPrettyList(
                iceServers.map(server => server.urls).reduce((list, url) => list.concat(url), [])
            )}`)
        }
        // -- Signaling
        else if ("Signaling" in message) {
            if ("Description" in message.Signaling) {
                const descriptionRaw = message.Signaling.Description
                const description = {
                    type: descriptionRaw.ty as RTCSdpType,
                    sdp: descriptionRaw.sdp,
                }

                await this.handleRemoteDescription(description)
            } else if ("AddIceCandidate" in message.Signaling) {
                const candidateRaw = message.Signaling.AddIceCandidate;
                const candidate: RTCIceCandidateInit = {
                    candidate: candidateRaw.candidate,
                    sdpMid: candidateRaw.sdp_mid,
                    sdpMLineIndex: candidateRaw.sdp_mline_index,
                    usernameFragment: candidateRaw.username_fragment
                }

                await this.handleIceCandidate(candidate)
            }
        }
    }

    // -- Signaling
    private async onNegotiationNeeded() {
        if (!this.peer) {
            this.debugLog("OnNegotiationNeeded without a peer")
            return
        }

        await this.peer.setLocalDescription()

        await this.sendLocalDescription()
    }


    private remoteDescription: RTCSessionDescriptionInit | null = null
    private async handleRemoteDescription(description: RTCSessionDescriptionInit) {
        this.debugLog(`Received Remote Description of type ${description.type}`)

        this.remoteDescription = description
        if (!this.peer) {
            this.debugLog(`Saving Remote Description for Peer creation`)
            return
        }

        await this.peer.setRemoteDescription(description)

        if (description.type === "offer") {
            await this.peer.setLocalDescription()

            await this.sendLocalDescription()
        }

        await this.tryDequeueIceCandidates()
    }

    private iceCandidateQueue: Array<RTCIceCandidateInit> = []
    private async tryDequeueIceCandidates() {
        for (const candidate of this.iceCandidateQueue.splice(0)) {
            await this.handleIceCandidate(candidate)
        }
    }
    private async handleIceCandidate(candidate: RTCIceCandidateInit) {
        if (!this.peer || !this.remoteDescription) {
            this.debugLog(`Received Ice Candidate and queuing it: ${candidate.candidate}`)
            this.iceCandidateQueue.push(candidate)
            return
        }

        this.debugLog(`Adding Ice Candidate: ${candidate.candidate}`)

        this.peer.addIceCandidate(candidate)
    }

    private sendLocalDescription() {
        if (!this.peer) {
            this.debugLog("Send Local Description without a peer")
            return
        }

        const description = this.peer.localDescription as RTCSessionDescription;
        this.debugLog(`Sending Local Description of type ${description.type}`)

        this.sendWsMessage({
            Signaling: {
                Description: {
                    ty: description.type,
                    sdp: description.sdp
                }
            }
        })
    }
    private onIceCandidate(event: RTCPeerConnectionIceEvent) {
        const candidateJson = event.candidate?.toJSON()
        if (!candidateJson || !candidateJson?.candidate) {
            return;
        }
        this.debugLog(`Sending Ice Candidate: ${candidateJson.candidate}`)

        const candidate: RtcIceCandidate = {
            candidate: candidateJson?.candidate,
            sdp_mid: candidateJson?.sdpMid ?? null,
            sdp_mline_index: candidateJson?.sdpMLineIndex ?? null,
            username_fragment: candidateJson?.usernameFragment ?? null
        }

        this.sendWsMessage({
            Signaling: {
                AddIceCandidate: candidate
            }
        })
    }

    // -- Track and Data Channels
    private onTrack(event: RTCTrackEvent) {
        // Optimize jitter buffer for Tesla (cellular)
        // 0ms is ideal for LAN, but ~20-30ms helps smooth out cellular jitter without killing feel
        const targetDelay = 0;
        
        event.receiver.jitterBufferTarget = targetDelay;

        if ("playoutDelayHint" in event.receiver) {
            event.receiver.playoutDelayHint = targetDelay / 1000;
        } else {
            this.debugLog(`playoutDelayHint not supported in receiver: ${event.receiver.track.label}`)
        }

        if(!this.settings?.canvasRenderer) {
            const stream = event.streams[0]
            if (stream) {
                stream.getTracks().forEach(track => {
                    this.debugLog(`Adding Media Track ${track.label}`)

                    if (track.kind == "video" && "contentHint" in track) {
                        track.contentHint = "motion"
                    }

                    this.mediaStream.addTrack(track)
                })
            }
        }
        else {
            const track = event.track
            this.debugLog(`Received Media Track ${track.label} (${track.kind})`)

            if (track.kind === "video") {
                if ("contentHint" in track) {
                    track.contentHint = "motion"
                }
                const customEvent = new CustomEvent("stream-info", {
                    detail: {
                        type: "videoTrack",
                        track: track
                    }
                })
                this.eventTarget.dispatchEvent(customEvent)
            } else {
                this.mediaStream.addTrack(track)
            }
        }
    }
    private onConnectionStateChange() {
        if (!this.peer) {
            this.debugLog("OnConnectionStateChange without a peer")
            return
        }
        this.debugLog(`Changing Peer State to ${this.peer.connectionState}`)

        if (this.peer.connectionState == "failed" || this.peer.connectionState == "closed") {
            const customEvent: InfoEvent = new CustomEvent("stream-info", {
                detail: {
                    type: "error",
                    message: `Connection state is ${this.peer.connectionState}`
                }
            })

            this.eventTarget.dispatchEvent(customEvent)
        } else if (this.peer.connectionState == "disconnected") {
            // Transient state on mobile — log but don't show error modal
            this.debugLog("Connection temporarily disconnected, waiting for recovery...")
        } else if (this.peer.connectionState == "connected") {
            // Connection recovered — dismiss any error modal
            const customEvent: InfoEvent = new CustomEvent("stream-info", {
                detail: {
                    type: "connectionRecovered"
                }
            }) as any

            this.eventTarget.dispatchEvent(customEvent)
        }
    }
    private onIceConnectionStateChange() {
        if (!this.peer) {
            this.debugLog("OnIceConnectionStateChange without a peer")
            return
        }
        this.debugLog(`Changing Peer Ice State to ${this.peer.iceConnectionState}`)
    }

    private onDataChannel(event: RTCDataChannelEvent) {
        this.debugLog(`Received Data Channel ${event.channel.label}`)

        if (event.channel.label == "general") {
            event.channel.addEventListener("message", this.onGeneralDataChannelMessage.bind(this))
        } else if (event.channel.label == "audio") {
            event.channel.binaryType = "arraybuffer";
            event.channel.addEventListener("message", this.onAudioDataChannelMessage.bind(this))
        }
    }

    private onAudioDataChannelMessage(event: MessageEvent) {
        if (!this.audioDecoderReady) return;
        this.audioPacketsReceived++;
        if (event.data && event.data.byteLength) {
            this.audioBytesReceived += event.data.byteLength;
        }

        const now = performance.now();
        if (this.lastAudioPacketAt > 0) {
            const gapMs = now - this.lastAudioPacketAt;
            this.audioLastPacketGapMs = gapMs;
            this.audioMaxPacketGapMs = Math.max(this.audioMaxPacketGapMs, gapMs);
            if (this.audioAvgPacketGapMs === 0) {
                this.audioAvgPacketGapMs = gapMs;
            } else {
                this.audioAvgPacketGapMs = (this.audioAvgPacketGapMs * 0.9) + (gapMs * 0.1);
            }
            if (gapMs > 35) {
                this.audioLatePacketGaps++;
            }
        }
        this.lastAudioPacketAt = now;
        
        try {
            if (this.useAudioDecodeWorker && this.audioDecodeWorker) {
                const packet = event.data as ArrayBuffer
                const msg: AudioDecodeWorkerInMessage = { type: "decode", packet }
                this.audioDecodeWorker.postMessage(msg, [packet])
            } else if (this.audioDecoder) {
                this.audioDecoder.decode(new Uint8Array(event.data))
            }
        } catch (e) {
            this.audioDecodeErrors++;
            console.error("Error decoding audio", e);
        }
    }
    private async onGeneralDataChannelMessage(event: MessageEvent) {
        const data = event.data

        if (typeof data != "string") {
            return
        }

        let message = JSON.parse(data)
        await this.onMessage(message)
    }

    // -- Raw Web Socket stuff
    private wsSendBuffer: Array<string> = []

    private onWsOpen() {
        this.debugLog(`Web Socket Open`)

        for (const raw of this.wsSendBuffer.splice(0)) {
            this.ws.send(raw)
        }
    }
    private onWsClose() {
        this.debugLog(`Web Socket Closed`)
    }

    private sendWsMessage(message: StreamClientMessage) {
        const raw = JSON.stringify(message)
        if (this.ws.readyState == WebSocket.OPEN) {
            this.ws.send(raw)
        } else {
            this.wsSendBuffer.push(raw)
        }
    }

    private async onRawWsMessage(event: MessageEvent) {
        const data = event.data
        if (typeof data != "string") {
            return
        }

        let message = JSON.parse(data)
        await this.onMessage(message)
    }

    private onError(event: Event) {
        this.debugLog(`Web Socket or WebRtcPeer Error`)

        console.error("Stream Error", event)
    }

    // -- Class Api
    addInfoListener(listener: InfoEventListener) {
        this.eventTarget.addEventListener("stream-info", listener as EventListenerOrEventListenerObject)
    }
    removeInfoListener(listener: InfoEventListener) {
        this.eventTarget.removeEventListener("stream-info", listener as EventListenerOrEventListenerObject)
    }

    getMediaStream(): MediaStream {
        return this.mediaStream
    }

    getInput(): StreamInput {
        return this.input
    }

    getPeer(): RTCPeerConnection | null {
        return this.peer
    }

    getAudioDiagnostics(): StreamAudioDiagnostics {
        const currentTime = this.audioContext?.currentTime ?? 0
        return {
            decoderReady: this.audioDecoderReady,
            audioContextState: this.audioContext?.state ?? "missing",
            receivedPackets: this.audioPacketsReceived,
            decodedPackets: this.audioPacketsDecoded,
            receivedBytes: this.audioBytesReceived,
            decodeErrors: this.audioDecodeErrors,
            underruns: this.audioUnderruns,
            resyncs: this.audioResyncs,
            droppedBufferedSources: this.audioDroppedBufferedSources,
            droppedLatencyFlushes: this.audioDroppedLatencyFlushes,
            droppedCleanupSources: this.audioDroppedCleanupSources,
            queuedSources: this.sourceNodes.size,
            bufferLeadMs: Math.max(0, (this.nextAudioTime - currentTime) * 1000),
            lastPacketGapMs: this.audioLastPacketGapMs,
            avgPacketGapMs: this.audioAvgPacketGapMs,
            maxPacketGapMs: this.audioMaxPacketGapMs,
            latePacketGaps: this.audioLatePacketGaps,
            currentTime,
            nextAudioTime: this.nextAudioTime,
        }
    }

    getWorkerDiagnostics(): StreamWorkerDiagnostics {
        return {
            workersAllowedBySettings: this.audioDecodeWorkerAllowed,
            audioWorkerAttempted: this.audioDecodeWorkerInitAttempted,
            audioWorkerActive: this.useAudioDecodeWorker,
            audioWorkerError: this.audioDecodeWorkerInitError,
            audioDecoderMode: this.audioDecoderReady ? (this.useAudioDecodeWorker ? "worker" : "main-thread") : "not-ready",
        }
    }

    getStreamerSize(): [number, number] {
        return this.streamerSize
    }

    resumeAudio() {
        if (!this.audioDecoderReady && !this.decoderInitInFlight) {
            void this.setupDecoder()
        }

        if (!this.audioContext) {
            this.setupAudioContext()
        }

        if (this.audioContext && this.audioContext.state === "suspended") {
            this.audioContext.resume();
        }
    }
}

function createPrettyList(list: Array<string>): string {
    let isFirst = true
    let text = "["
    for (const item of list) {
        if (!isFirst) {
            text += ", "
        }
        isFirst = false

        text += item
    }
    text += "]"

    return text
}