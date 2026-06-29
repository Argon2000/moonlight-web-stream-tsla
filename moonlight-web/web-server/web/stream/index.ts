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
    | { type: "decodeBatch"; packets: ArrayBuffer[] }
    | { type: "free" }
    | { type: "use-main-thread" }

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
    { type: "inputClientsChanged", count: number } |
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

    private ws!: WebSocket

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
    private audioContextInterrupted: boolean = false
    // AudioWorkletNode for stutter-free playback: its process() runs on the
    // real-time audio rendering thread, immune to main-thread congestion.
    private audioWorkletNode: AudioWorkletNode | null = null
    private audioWorkletReady: boolean = false
    private audioFallbackReady: boolean = false
    private isFirstAudioPacket: boolean = true
    private workletBufferMs: number = 0
    // PCM buffer recycling: collect used ArrayBuffers and return to worker in batches
    private pcmRecycleQueue: ArrayBuffer[] = []
    private pcmRecycleScheduled: boolean = false
    private readonly PCM_RECYCLE_BATCH = 8
    // Ring buffer for main-thread audio decode path (avoids push/shift GC churn).
    // Worker path bypasses this entirely — packets go directly via postMessage transfer.
    private audioRingBuffer: (ArrayBuffer | null)[] = new Array(128).fill(null)
    private audioRingHead: number = 0   // next write index
    private audioRingTail: number = 0   // next read index
    private audioRingMask: number = 127 // capacity - 1 (power of 2)
    private audioDrainScheduled: boolean = false
    private readonly AUDIO_DRAIN_BATCH_SIZE = 4 // max packets per drain tick
    private audioPacketsReceived: number = 0
    private audioPacketsDecoded: number = 0
    private audioBytesReceived: number = 0
    private audioDecodeErrors: number = 0
    private audioUnderruns: number = 0
    private audioResyncs: number = 0
    private audioDroppedBufferedSources: number = 0
    private audioDroppedLatencyFlushes: number = 0
    private audioDroppedCleanupSources: number = 0
    private workletFramesWritten: number = 0
    private workletDrops: number = 0
    private lastAudioPacketAt: number = 0
    private audioLastPacketGapMs: number = 0
    private audioAvgPacketGapMs: number = 0
    private audioMaxPacketGapMs: number = 0
    private audioLatePacketGaps: number = 0
    private audioGapSampleCounter: number = 0
    private readonly AUDIO_GAP_SAMPLE_EVERY = 8

    // When false all stats collection is skipped (stats overlay is hidden)
    private statsEnabled: boolean = false

    constructor(api: Api, hostId: number, appId: number, settings: StreamSettings, supportedVideoFormats: VideoCodecSupport, viewerScreenSize: [number, number]) {
        this.api = api
        this.hostId = hostId
        this.appId = appId

        this.settings = settings
        this.audioDecodeWorkerAllowed = settings.useAudioWorker

        this.streamerSize = getStreamerSize(settings, viewerScreenSize)

        // Prepare the auth message to buffer-send on each WS attempt
        const fps = this.settings.fps
        this.pendingAuthMessage = {
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
        }

        // Connect WebSocket (with auto-retry)
        this.connectWebSocket()

        // Ensure the WS is cleanly closed on page reload/navigation so the browser
        // doesn't leave a lingering connection that blocks the next attempt.
        this.beforeUnloadHandler = () => { this.ws.close() }
        window.addEventListener("beforeunload", this.beforeUnloadHandler)

        // Stream Input
        const streamInputConfig = defaultStreamInputConfig()
        Object.assign(streamInputConfig, {
            mouseScrollMode: this.settings.mouseScrollMode,
            controllerConfig: this.settings.controllerConfig,
            controllerDeviceMode: this.settings.controllerDeviceMode
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
                    // If worklet is already ready, wire direct channel now.
                    // If we are in fallback mode (no worklet), tell the worker to
                    // send decoded frames back to the main thread instead.
                    if (this.audioWorkletReady) {
                        this.wireDirectAudioChannel();
                    } else if (this.audioFallbackReady) {
                        this.audioDecodeWorker?.postMessage({ type: "use-main-thread" } as AudioDecodeWorkerInMessage);
                    }
                    return
                }

                if (data.type === "decoded") {
                    // This path only fires during startup before direct channel is wired.
                    // Once wireDirectAudioChannel() is called, worker sends directly to worklet.
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
            
            // Gain node to boost volume so Tesla system volume can stay low
            // (prevents radio/Spotify from blowing speakers if it auto-resumes)
            this.mainGainNode = this.audioContext.createGain();
            this.mainGainNode.gain.value = 5.0;

            // Compressor acting as a limiter to prevent clipping distortion
            const compressor = this.audioContext.createDynamicsCompressor();
            compressor.threshold.value = -3;
            compressor.knee.value = 3;
            compressor.ratio.value = 20;
            compressor.attack.value = 0.001;
            compressor.release.value = 0.05;

            // Low-pass filter to cut high-frequency noise/aliasing artifacts
            const lpFilter = this.audioContext.createBiquadFilter();
            lpFilter.type = "lowpass";
            lpFilter.frequency.value = 20000;
            lpFilter.Q.value = 0.7;

            // Chain: workletNode -> gain -> compressor -> lowpass -> destination
            this.mainGainNode.connect(compressor);
            compressor.connect(lpFilter);
            lpFilter.connect(this.audioContext.destination);

            // Register AudioWorklet for real-time-thread audio rendering.
            // This is the key to stutter-free playback: process() runs on the
            // audio rendering thread, not the main thread.
            // AudioWorklet is only available in secure contexts (HTTPS/localhost).
            // Fall back to scheduled AudioBufferSourceNode playback over plain HTTP.
            if (!this.audioContext.audioWorklet) {
                this.audioFallbackReady = true;
                this.debugLog("AudioWorklet unavailable (non-secure context), using scheduled buffer fallback");
                // Tell the decode worker (if already ready) to send decoded frames
                // back to the main thread rather than buffering for a worklet port.
                if (this.audioDecodeWorker) {
                    this.audioDecodeWorker.postMessage({ type: "use-main-thread" } as AudioDecodeWorkerInMessage);
                }
            } else { this.audioContext.audioWorklet.addModule(
                new URL("./audio_playback_worklet.js", import.meta.url).href
            ).then(() => {
                if (!this.audioContext) return;
                this.audioWorkletNode = new AudioWorkletNode(this.audioContext, 'pcm-playback-processor', {
                    numberOfInputs: 0,
                    numberOfOutputs: 1,
                    outputChannelCount: [2],
                });
                this.audioWorkletNode.connect(this.mainGainNode!);
                this.audioWorkletReady = true;

                // Listen for stats from worklet
                this.audioWorkletNode.port.onmessage = (event: MessageEvent) => {
                    if (event.data?.type === 'stats') {
                        this.workletBufferMs = event.data.bufferMs;
                        this.audioUnderruns = event.data.underruns;
                        this.workletFramesWritten = event.data.framesWritten ?? 0;
                        this.workletDrops = event.data.drops ?? 0;
                    }
                };

                // Wire direct MessageChannel: decode worker → worklet
                // This removes the main thread from the decoded PCM hot path entirely.
                this.wireDirectAudioChannel();

                this.debugLog("AudioWorklet playback processor ready");
            }).catch((e) => {
                console.error("AudioWorklet registration failed:", e);
                this.debugLog(`AudioWorklet failed: ${e}`);
            }); }

            if (this.settings.keepAudioAlive) {
                const keepaliveOsc = this.audioContext.createOscillator();
                const keepaliveGain = this.audioContext.createGain();
                keepaliveOsc.frequency.value = 0.5;
                keepaliveGain.gain.value = 0.00001;
                keepaliveOsc.connect(keepaliveGain);
                keepaliveGain.connect(this.audioContext.destination);
                keepaliveOsc.start();
            }

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
                 if (state !== 'running') {
                     // Mark interrupted so the next packet resyncs nextAudioTime.
                     // Without this, packets arriving during suspension advance
                     // nextAudioTime while currentTime is frozen, causing a 300ms+
                     // latency burst and a flood of HARD_OVERRUN drops on resume.
                     this.audioContextInterrupted = true;
                     // Aggressively try to resume — browsers (especially Tesla/Chromium)
                     // can move to 'interrupted' state when the tab loses audio focus.
                     // A single resume() call may not be enough; retry periodically.
                     this.startAudioResumeRetry();
                 }
             };
        }
    }

    private audioResumeRetryId: ReturnType<typeof setInterval> | null = null;

    private startAudioResumeRetry() {
        if (this.audioResumeRetryId) return; // already retrying
        this.audioResumeRetryId = setInterval(() => {
            if (!this.audioContext || this.audioContext.state === 'closed') {
                this.stopAudioResumeRetry();
                return;
            }
            if (this.audioContext.state === 'running') {
                this.stopAudioResumeRetry();
                return;
            }
            this.audioContext.resume().catch(() => {});
        }, 1000);
    }

    private stopAudioResumeRetry() {
        if (this.audioResumeRetryId) {
            clearInterval(this.audioResumeRetryId);
            this.audioResumeRetryId = null;
        }
    }

    private onAudioSourceEnded = (_event: Event) => {
        // No-op: ScriptProcessorNode handles playback continuously.
        // Kept for interface compatibility.
    }

    private playPcm(left: Float32Array, right: Float32Array) {
        if (!this.audioContext) return;
        if (!this.audioWorkletReady && !this.audioFallbackReady) return;

        if (this.audioContext.state !== 'running') {
            this.audioContext.resume();
        }

        this.audioPacketsDecoded++;

        if (this.audioWorkletReady && this.audioWorkletNode) {
            // Worklet path (secure context): runs on the real-time audio thread —
            // immune to main-thread GC, DataChannel bursts, rAF, etc.
            // Transfer the underlying ArrayBuffers for zero-copy.
            this.audioWorkletNode.port.postMessage(
                { type: 'pcm', left: left.buffer, right: right.buffer },
                [left.buffer, right.buffer]
            );
        } else if (this.audioFallbackReady) {
            this.playPcmFallback(left, right);
        }
    }

    private playPcmFallback(left: Float32Array, right: Float32Array) {
        if (!this.audioContext || !this.mainGainNode) return;
        const numFrames = left.length;
        const buffer = this.audioContext.createBuffer(2, numFrames, 48000);
        buffer.copyToChannel(left, 0);
        buffer.copyToChannel(right, 1);
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(this.mainGainNode);
        const now = this.audioContext.currentTime;
        if (this.nextAudioTime < now || this.audioContextInterrupted) {
            this.nextAudioTime = now + 0.05; // 50 ms ahead to absorb jitter
            this.audioContextInterrupted = false;
        }
        source.start(this.nextAudioTime);
        this.nextAudioTime += numFrames / 48000;
    }

    private wireDirectAudioChannel() {
        if (!this.audioDecodeWorker || !this.audioWorkletNode) return;

        // Create a MessageChannel: port1 goes to the decode worker,
        // port2 goes to the AudioWorklet. Decoded PCM flows directly
        // worker→worklet without touching the main thread.
        const channel = new MessageChannel();

        // Send port2 to worklet
        this.audioWorkletNode.port.postMessage(
            { type: 'pcm-port', port: channel.port2 },
            [channel.port2]
        );

        // Send port1 to decode worker (it will flush buffered frames and
        // switch to direct delivery)
        this.audioDecodeWorker.postMessage(
            { type: 'pcm-port', port: channel.port1 },
            [channel.port1]
        );

        this.debugLog("Direct worker→worklet audio channel established");
    }

    private recyclePcmBuffer(buf: ArrayBuffer) {
        this.pcmRecycleQueue.push(buf)
        if (!this.pcmRecycleScheduled && this.pcmRecycleQueue.length >= this.PCM_RECYCLE_BATCH) {
            this.pcmRecycleScheduled = true
            // Use queueMicrotask to batch without a full event loop turn
            queueMicrotask(() => this.flushPcmRecycle())
        }
    }

    private flushPcmRecycle() {
        this.pcmRecycleScheduled = false
        if (!this.audioDecodeWorker || this.pcmRecycleQueue.length === 0) return
        const buffers = this.pcmRecycleQueue.splice(0)
        this.audioDecodeWorker.postMessage({ type: "recycle", buffers }, buffers)
    }

    private debugLogBuffer: string[] = []

    private debugLog(message: string) {
        for (const line of message.split("\n")) {
            this.debugLogBuffer.push(line)
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "addDebugLine", line }
            })

            this.eventTarget.dispatchEvent(event)
        }
    }

    /** Send accumulated debug log to server for remote diagnostics. */
    private sendDebugLogToServer() {
        if (this.debugLogBuffer.length === 0) return
        const log = this.debugLogBuffer.join("\n")
        this.sendWsMessage({ ClientLog: { log } })
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

        // Pre-declare a recvonly video transceiver so the initial offer includes
        // the video m-line. The streamer has a sendonly track pre-registered
        // for the same m-line, so no renegotiation is needed after stream start.
        this.peer.addTransceiver("video", { direction: "recvonly" })

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
        } else if ("InputClientsChanged" in message) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "inputClientsChanged", count: message.InputClientsChanged.count }
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

            this.debugLog(`Using WebRTC Ice Servers: ${createPrettyList(
                iceServers.map(server => server.urls).reduce((list, url) => list.concat(url), [])
            )}`)

            await this.createPeer({
                iceServers: iceServers
            })
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
    private makingOffer = false
    private async onNegotiationNeeded() {
        if (!this.peer) {
            this.debugLog("OnNegotiationNeeded without a peer")
            return
        }

        // Suppress re-entrant negotiation: if we are already making an offer, or if the
        // signaling state is not stable (a negotiation round-trip is in progress), do nothing.
        // This prevents a duplicate offer from the async negotiationneeded event that fires
        // after addTransceiver(), which would race with and invalidate the first offer/answer.
        if (this.makingOffer || this.peer.signalingState !== "stable") {
            this.debugLog(`Suppressing negotiation (makingOffer=${this.makingOffer}, state=${this.peer.signalingState})`)
            return
        }

        this.makingOffer = true
        try {
            await this.peer.setLocalDescription()
            await this.waitForIceGathering()
            await this.sendLocalDescription()
        } finally {
            this.makingOffer = false
        }
    }

    /**
     * Wait for ICE gathering to complete so all candidates are embedded in the
     * local SDP. This avoids relying on trickle ICE (separate candidate messages)
     * which fails on Tesla browsers that kill the WS send path after the initial offer.
     */
    private iceGatheringResolve: (() => void) | null = null
    private iceCandidateDebounceResolve: (() => void) | null = null
    private waitForIceGathering(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.peer) { resolve(); return }
            if (this.peer.iceGatheringState === "complete") { resolve(); return }

            // Hard safety timeout — absolute maximum wait.
            const maxTimeout = setTimeout(() => {
                this.debugLog("ICE gathering timed out after 3s, sending what we have")
                this.iceGatheringResolve = null
                this.iceCandidateDebounceResolve = null
                resolve()
            }, 3000)

            // Candidate debounce: once we receive at least one candidate, start a short
            // timer. If no more candidates arrive within 300ms, resolve early — host
            // candidates (sufficient for localhost/LAN) arrive in <50ms, so this avoids
            // waiting for slow STUN servers while still bundling all fast candidates.
            let debounceTimer: ReturnType<typeof setTimeout> | null = null
            this.iceCandidateDebounceResolve = () => {
                if (debounceTimer) clearTimeout(debounceTimer)
                debounceTimer = setTimeout(() => {
                    clearTimeout(maxTimeout)
                    this.iceGatheringResolve = null
                    this.iceCandidateDebounceResolve = null
                    this.debugLog("ICE gathering resolved (candidate debounce 300ms)")
                    resolve()
                }, 300)
            }

            // The null-candidate event (end-of-candidates) is the most reliable
            // cross-browser signal that gathering finished. onIceCandidate will call this.
            this.iceGatheringResolve = () => {
                clearTimeout(maxTimeout)
                if (debounceTimer) clearTimeout(debounceTimer)
                this.iceGatheringResolve = null
                this.iceCandidateDebounceResolve = null
                this.debugLog("ICE gathering complete (null candidate)")
                resolve()
            }
        })
    }


    private remoteDescription: RTCSessionDescriptionInit | null = null
    private async handleRemoteDescription(description: RTCSessionDescriptionInit) {
        this.debugLog(`Received Remote Description of type ${description.type}`)

        this.remoteDescription = description
        if (!this.peer) {
            this.debugLog(`Saving Remote Description for Peer creation`)
            return
        }

        // "Polite peer" pattern: if we receive an offer while we have a pending
        // local offer, rollback ours and accept the remote (streamer is impolite/authoritative).
        const offerCollision = description.type === "offer" &&
            (this.makingOffer || this.peer.signalingState !== "stable")

        if (offerCollision) {
            this.debugLog("Offer collision detected — rolling back local offer (polite peer)")
            await this.peer.setLocalDescription({ type: "rollback" })
        }

        await this.peer.setRemoteDescription(description)

        if (description.type === "offer") {
            await this.peer.setLocalDescription()
            await this.waitForIceGathering()
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

        try {
            await this.peer.addIceCandidate(candidate)
        } catch (err) {
            this.debugLog(`Failed to add ICE candidate: ${err}`)
        }
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
        if (!event.candidate) {
            // Null candidate = gathering complete. Resolve the waitForIceGathering promise.
            if (this.iceGatheringResolve) {
                this.iceGatheringResolve()
            }
            return
        }
        const candidateJson = event.candidate.toJSON()
        if (!candidateJson?.candidate) {
            return;
        }
        this.debugLog(`Local Ice Candidate gathered: ${candidateJson.candidate}`)

        // Trigger debounce: once candidates stop arriving for 300ms, send the offer
        // with whatever we have (host candidates are sufficient for LAN/localhost).
        if (this.iceCandidateDebounceResolve) {
            this.iceCandidateDebounceResolve()
        }

        // We use non-trickle ICE: candidates are bundled into the SDP (via
        // waitForIceGathering) before the offer/answer is sent. Individual
        // candidate messages are NOT sent because Tesla's browser drops the
        // WS send path after the initial offer, so they never arrive.
    }

    // -- Track and Data Channels
    private onTrack(event: RTCTrackEvent) {

        if (event.receiver && "playoutDelayHint" in event.receiver) {
            // @ts-ignore
            event.receiver.playoutDelayHint = 0;
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
            this.sendDebugLogToServer()
            const customEvent: InfoEvent = new CustomEvent("stream-info", {
                detail: {
                    type: "error",
                    message: `Connection state is ${this.peer.connectionState}`
                }
            })
            this.eventTarget.dispatchEvent(customEvent)
        } else if (this.peer.connectionState == "disconnected") {
            // Transient state — log but don't show error modal; ICE restart is handled by streamer
            this.debugLog("Connection temporarily disconnected, waiting for recovery...")
        } else if (this.peer.connectionState == "connected") {
            // Clear the connection timeout — we're fully connected.
            if (this.wsConnectTimeout !== null) {
                clearTimeout(this.wsConnectTimeout)
                this.wsConnectTimeout = null
            }
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

        // Ensure AudioContext is running (autoplay policy / browser interruption)
        if (this.audioContext && this.audioContext.state !== 'running') {
            this.audioContext.resume();
        }

        const packet = event.data as ArrayBuffer;
        this.audioBytesReceived += packet.byteLength;

        // Sample inter-packet timing every N packets (cheap: integer modulo + branch).
        if (this.statsEnabled && (++this.audioGapSampleCounter & (this.AUDIO_GAP_SAMPLE_EVERY - 1)) === 0) {
            const now = event.timeStamp || 0;
            if (now > 0 && this.lastAudioPacketAt > 0) {
                const sampledGapMs = (now - this.lastAudioPacketAt) / this.AUDIO_GAP_SAMPLE_EVERY;
                this.audioLastPacketGapMs = sampledGapMs;
                if (sampledGapMs > this.audioMaxPacketGapMs) this.audioMaxPacketGapMs = sampledGapMs;
                this.audioAvgPacketGapMs = this.audioAvgPacketGapMs === 0
                    ? sampledGapMs
                    : this.audioAvgPacketGapMs * 0.9 + sampledGapMs * 0.1;
                if (sampledGapMs > 35) this.audioLatePacketGaps++;
            }
            if (now > 0) this.lastAudioPacketAt = now;
        }

        // Worker path: zero-copy transfer directly from the event callback.
        // No queue, no intermediate arrays, no setTimeout — just hand the buffer
        // to the worker thread instantly. This keeps the callback allocation-free.
        if (this.useAudioDecodeWorker && this.audioDecodeWorker) {
            this.audioDecodeWorker.postMessage(packet, [packet]);
            return;
        }

        // Main-thread fallback: ring buffer + batched drain to avoid blocking rAF.
        this.audioRingBuffer[this.audioRingHead] = packet;
        this.audioRingHead = (this.audioRingHead + 1) & this.audioRingMask;
        if (!this.audioDrainScheduled) {
            this.audioDrainScheduled = true;
            this.drainAudioQueue();
        }
    }

    private drainAudioQueue() {
        let count = 0;
        while (this.audioRingTail !== this.audioRingHead && count < this.AUDIO_DRAIN_BATCH_SIZE) {
            const packet = this.audioRingBuffer[this.audioRingTail]!;
            this.audioRingBuffer[this.audioRingTail] = null; // release ref
            this.audioRingTail = (this.audioRingTail + 1) & this.audioRingMask;
            try {
                this.audioDecoder.decode(new Uint8Array(packet));
            } catch (e) {
                this.audioDecodeErrors++;
            }
            count++;
        }
        if (this.audioRingTail !== this.audioRingHead) {
            // Yield to the event loop — lets rAF fire between batches
            setTimeout(() => this.drainAudioQueue(), 0);
        } else {
            this.audioDrainScheduled = false;
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
    private wsConnectTimeout: ReturnType<typeof setTimeout> | null = null
    private beforeUnloadHandler: (() => void) | null = null
    private wsAttempt: number = 0
    private readonly WS_MAX_ATTEMPTS = 10
    private readonly WS_CONNECT_TIMEOUT_MS = 5000
    private readonly WS_RETRY_DELAY_MS = 0
    private pendingAuthMessage: any = null
    // Serializes WebSocket message processing so messages are handled one-at-a-time
    // in arrival order. Without this, an ICE candidate message can race with the
    // remote-description (answer) message and call addIceCandidate before
    // setRemoteDescription resolves, silently dropping the candidate.
    private messageProcessingQueue: Promise<void> = Promise.resolve()

    private connectWebSocket() {
        this.wsAttempt++
        const attempt = this.wsAttempt
        this.debugLog(`WebSocket connect attempt ${attempt}/${this.WS_MAX_ATTEMPTS}`)

        // Unique cache-buster prevents browser from reusing a stale connection
        const wsUrl = `${this.api.host_url}/host/stream?_t=${Date.now()}`
        this.ws = new WebSocket(wsUrl)
        this.ws.addEventListener("error", this.onError.bind(this))
        this.ws.addEventListener("open", this.onWsOpen.bind(this))
        this.ws.addEventListener("close", this.onWsClose.bind(this))
        this.ws.addEventListener("message", this.onRawWsMessage.bind(this))

        // Buffer the auth message so it's sent on open
        this.wsSendBuffer = []
        if (this.pendingAuthMessage) {
            this.sendWsMessage(this.pendingAuthMessage)
        }

        // Timeout: if WS doesn't open, retry or give up
        this.wsConnectTimeout = setTimeout(() => {
            this.wsConnectTimeout = null
            this.debugLog(`WebSocket attempt ${attempt} timed out after ${this.WS_CONNECT_TIMEOUT_MS}ms`)
            this.ws.close()

            if (this.wsAttempt < this.WS_MAX_ATTEMPTS) {
                // Retry after a delay to let browser clean up the dead connection
                setTimeout(() => this.connectWebSocket(), this.WS_RETRY_DELAY_MS)
            } else {
                this.debugLog(`All ${this.WS_MAX_ATTEMPTS} WebSocket attempts failed`)
                const event: InfoEvent = new CustomEvent("stream-info", {
                    detail: { type: "error", message: "WebSocket connection timed out (all retries exhausted)" }
                })
                this.eventTarget.dispatchEvent(event)
            }
        }, this.WS_CONNECT_TIMEOUT_MS)
    }

    private onWsOpen() {
        this.debugLog(`Web Socket Open (attempt ${this.wsAttempt}/${this.WS_MAX_ATTEMPTS})`)

        if (this.wsConnectTimeout !== null) {
            clearTimeout(this.wsConnectTimeout)
            this.wsConnectTimeout = null
        }

        // If we don't reach "connected" state within 30s after WS opens,
        // something is stuck (server not responding, ICE failing silently, etc.)
        this.wsConnectTimeout = setTimeout(() => {
            if (!this.peer || this.peer.connectionState !== "connected") {
                this.debugLog("Stream connection timed out after 30s")
                this.sendDebugLogToServer()
                const event: InfoEvent = new CustomEvent("stream-info", {
                    detail: { type: "error", message: "Stream connection timed out" }
                })
                this.eventTarget.dispatchEvent(event)
            }
        }, 30000)

        for (const raw of this.wsSendBuffer.splice(0)) {
            this.ws.send(raw)
        }
    }
    private onWsClose() {
        this.debugLog(`Web Socket Closed`)

        // If we're still in the retry loop, don't dispatch an error — connectWebSocket
        // will handle the retry or final failure.
        if (this.wsAttempt < this.WS_MAX_ATTEMPTS && this.wsConnectTimeout === null) {
            // Closed by our timeout handler, retry is pending — suppress error
            return
        }

        // If the WebSocket closes before we have a peer connection, it means
        // the connection failed entirely (e.g. Tesla browser dropping the WS).
        // Dispatch an error so the UI can show it instead of hanging on "Connecting".
        if (!this.peer || this.peer.connectionState !== "connected") {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "error", message: "WebSocket closed before stream connected" }
            })
            this.eventTarget.dispatchEvent(event)
        }
    }

    private sendWsMessage(message: StreamClientMessage) {
        const raw = JSON.stringify(message)
        if (this.ws.readyState == WebSocket.OPEN) {
            this.ws.send(raw)
        } else {
            this.wsSendBuffer.push(raw)
        }
    }

    private onRawWsMessage(event: MessageEvent) {
        // Chain onto the serialization queue — each message waits for the previous to finish.
        this.messageProcessingQueue = this.messageProcessingQueue.then(async () => {
            try {
                const data = event.data
                if (typeof data !== "string") {
                    return
                }
                const message = JSON.parse(data)
                await this.onMessage(message)
            } catch (err) {
                console.error("Error processing WebSocket message", err)
            }
        })
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

    setStatsEnabled(enabled: boolean) {
        this.statsEnabled = enabled
        // Propagate to audio worklet so it stops/starts its periodic postMessage
        if (this.audioWorkletNode) {
            this.audioWorkletNode.port.postMessage({ type: enabled ? 'enable-stats' : 'disable-stats' })
        }
    }

    getAudioDiagnostics(): StreamAudioDiagnostics {
        const currentTime = this.audioContext?.currentTime ?? 0
        // In worker mode, audioPacketsDecoded stays 0 since playPcm() is bypassed.
        // Use workletFramesWritten as the actual decoded count.
        const decodedPackets = this.useAudioDecodeWorker
            ? this.workletFramesWritten
            : this.audioPacketsDecoded
        return {
            decoderReady: this.audioDecoderReady,
            audioContextState: this.audioContext?.state ?? "missing",
            receivedPackets: this.audioPacketsReceived,
            decodedPackets,
            receivedBytes: this.audioBytesReceived,
            decodeErrors: this.audioDecodeErrors,
            underruns: this.audioUnderruns,
            resyncs: this.workletDrops,
            droppedBufferedSources: this.audioDroppedBufferedSources,
            droppedLatencyFlushes: this.audioDroppedLatencyFlushes,
            droppedCleanupSources: this.audioDroppedCleanupSources,
            queuedSources: 0,
            bufferLeadMs: this.workletBufferMs,
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

        if (this.audioContext && this.audioContext.state !== "running") {
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