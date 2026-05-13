import { Stream, StreamAudioDiagnostics } from "../stream/index.js"
import { Component } from "./index.js"

export class StreamStatsOverlay implements Component {
    private root = document.createElement("div")
    private intervalId: ReturnType<typeof setInterval> | null = null
    private peerGetter: (() => RTCPeerConnection | null) | null = null
    private streamGetter: (() => Stream | null) | null = null

    // Cached DOM elements for fast updates (avoid querySelector each tick)
    private elVideoRes = document.createElement("span")
    private elCodec = document.createElement("span")
    private elFps = document.createElement("span")
    private elBitrate = document.createElement("span")
    private elRtt = document.createElement("span")
    private elPacketLoss = document.createElement("span")
    private elJitter = document.createElement("span")
    private elDecodeTime = document.createElement("span")
    private elFramesDropped = document.createElement("span")
    private elAudioBitrate = document.createElement("span")
    private elAudioPackets = document.createElement("span")
    private elAudioGap = document.createElement("span")
    private elAudioDropReason = document.createElement("span")
    private elAudioBuffer = document.createElement("span")
    private elAudioPipeline = document.createElement("span")

    // Previous snapshot for delta calculations
    private prevTimestamp = 0
    private prevBytesReceived = 0
    private prevFramesReceived = 0
    private prevFramesDropped = 0
    private prevAudioBytesReceived = 0
    private prevPacketsReceived = 0
    private prevPacketsLost = 0
    private prevAudioMessagesReceived = 0

    constructor() {
        this.root.classList.add("stream-stats-overlay")

        const rows: Array<[string, HTMLSpanElement]> = [
            ["Resolution", this.elVideoRes],
            ["Codec", this.elCodec],
            ["FPS", this.elFps],
            ["Video Bitrate", this.elBitrate],
            ["Network RTT", this.elRtt],
            ["Packet Loss", this.elPacketLoss],
            ["Network Jitter", this.elJitter],
            ["Decode Time", this.elDecodeTime],
            ["Frames Dropped", this.elFramesDropped],
            ["Audio Bitrate", this.elAudioBitrate],
            ["Audio Messages", this.elAudioPackets],
            ["Audio Gap", this.elAudioGap],
            ["Audio Drops", this.elAudioDropReason],
            ["Audio Buffer", this.elAudioBuffer],
            ["Audio Pipeline", this.elAudioPipeline],
        ]

        for (const [label, valueEl] of rows) {
            const row = document.createElement("div")
            row.classList.add("stream-stats-row")

            const labelEl = document.createElement("span")
            labelEl.classList.add("stream-stats-label")
            labelEl.textContent = label

            valueEl.classList.add("stream-stats-value")
            valueEl.textContent = "—"

            row.appendChild(labelEl)
            row.appendChild(valueEl)
            this.root.appendChild(row)
        }
    }

    setPeerGetter(getter: () => RTCPeerConnection | null) {
        this.peerGetter = getter
    }

    setStreamGetter(getter: () => Stream | null) {
        this.streamGetter = getter
    }

    show() {
        this.root.style.display = ""
        if (!this.intervalId) {
            this.intervalId = setInterval(() => this.update(), 1000)
        }
    }

    hide() {
        this.root.style.display = "none"
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }
    }

    isVisible(): boolean {
        return this.root.style.display !== "none"
    }

    private async update() {
        const peer = this.peerGetter?.()
        if (!peer) return

        const stats = await peer.getStats()
        const now = performance.now()
        const elapsed = (now - this.prevTimestamp) / 1000 // seconds
        this.prevTimestamp = now

        let videoWidth = 0
        let videoHeight = 0
        let codecId = ""
        let bytesReceived = 0
        let framesReceived = 0
        let framesDropped = 0
        let framesPerSecond = 0
        let totalDecodeTime = 0
        let framesDecoded = 0
        let jitter = 0
        let rtt = 0
        let packetsReceived = 0
        let packetsLost = 0
        let audioBytesReceived = 0
        let audioMessagesReceived = 0

        // Collect all reports into a map for two-pass lookups
        const reports: Map<string, any> = new Map()
        stats.forEach((report: any) => {
            reports.set(report.id, report)
        })

        for (const report of reports.values()) {
            if (report.type === "inbound-rtp" && report.kind === "video") {
                bytesReceived = report.bytesReceived ?? 0
                framesReceived = report.framesReceived ?? 0
                framesDropped = report.framesDropped ?? 0
                framesPerSecond = report.framesPerSecond ?? 0
                totalDecodeTime = report.totalDecodeTime ?? 0
                framesDecoded = report.framesDecoded ?? 0
                jitter = report.jitter ?? 0
                codecId = report.codecId ?? ""
                packetsReceived = report.packetsReceived ?? 0
                packetsLost = report.packetsLost ?? 0

                if (report.frameWidth && report.frameHeight) {
                    videoWidth = report.frameWidth
                    videoHeight = report.frameHeight
                }
            }

            if (report.type === "data-channel" && report.label === "audio") {
                audioBytesReceived = report.bytesReceived ?? 0
                audioMessagesReceived = report.messagesReceived ?? 0
            }

            if (report.type === "candidate-pair" && (report.state === "succeeded" || report.nominated)) {
                rtt = report.currentRoundTripTime ?? rtt
            }
        }

        // Resolve codec in second pass (codecId may reference another report)
        let codec = ""
        if (codecId) {
            const codecReport = reports.get(codecId)
            if (codecReport) {
                codec = codecReport.mimeType ?? ""
            }
        }

        // Calculate deltas
        if (elapsed > 0) {
            const videoBitrateMbps = ((bytesReceived - this.prevBytesReceived) * 8) / elapsed / 1_000_000
            this.elBitrate.textContent = `${videoBitrateMbps.toFixed(2)} Mbps`

            const audioBitrate = ((audioBytesReceived - this.prevAudioBytesReceived) * 8) / elapsed / 1_000
            this.elAudioBitrate.textContent = `${audioBitrate.toFixed(0)} kbps`

            const audioMessageDelta = audioMessagesReceived - this.prevAudioMessagesReceived
            const audioBytesDelta = audioBytesReceived - this.prevAudioBytesReceived
            const avgBytesPerMessage = audioMessageDelta > 0 ? (audioBytesDelta / audioMessageDelta) : 0
            this.elAudioPackets.textContent = audioMessageDelta >= 0
                ? `${audioMessageDelta}/s (${avgBytesPerMessage.toFixed(1)} B/msg, ${audioMessagesReceived} total)`
                : `${audioMessagesReceived} total`

            const droppedDelta = framesDropped - this.prevFramesDropped
            this.elFramesDropped.textContent = `${framesDropped} (+${droppedDelta})`

            const totalPacketsDelta = (packetsReceived - this.prevPacketsReceived) + (packetsLost - this.prevPacketsLost)
            const lostDelta = packetsLost - this.prevPacketsLost
            const lossPercent = totalPacketsDelta > 0 ? (lostDelta / totalPacketsDelta * 100) : 0
            this.elPacketLoss.textContent = `${lossPercent.toFixed(1)}% (${packetsLost} total)`
        }

        // Decode time: average ms per frame
        let decodeTime = 0
        if (framesDecoded > 0) {
            decodeTime = (totalDecodeTime / framesDecoded) * 1000
        }

        this.elVideoRes.textContent = videoWidth > 0 ? `${videoWidth}×${videoHeight}` : "—"
        this.elCodec.textContent = codec || "—"
        this.elFps.textContent = framesPerSecond > 0 ? `${framesPerSecond}` : "—"
        this.elRtt.textContent = rtt > 0 ? `${(rtt * 1000).toFixed(1)} ms` : "—"
        this.elJitter.textContent = jitter > 0 ? `${(jitter * 1000).toFixed(1)} ms` : "—"
        this.elDecodeTime.textContent = decodeTime > 0 ? `${decodeTime.toFixed(1)} ms` : "—"

        const stream = this.streamGetter?.()
        const audioDiag: StreamAudioDiagnostics | null = stream ? stream.getAudioDiagnostics() : null
        if (audioDiag) {
            this.elAudioBuffer.textContent = `${audioDiag.bufferLeadMs.toFixed(1)} ms lead, ${audioDiag.queuedSources} queued, ctx=${audioDiag.audioContextState}`
            this.elAudioGap.textContent = `last ${audioDiag.lastPacketGapMs.toFixed(1)} ms, avg ${audioDiag.avgPacketGapMs.toFixed(1)} ms, max ${audioDiag.maxPacketGapMs.toFixed(1)} ms, late ${audioDiag.latePacketGaps}`
            this.elAudioDropReason.textContent = `latency flush ${audioDiag.droppedLatencyFlushes}, cleanup ${audioDiag.droppedCleanupSources}, total ${audioDiag.droppedBufferedSources}`
            this.elAudioPipeline.textContent = `rx ${audioDiag.receivedPackets}, dec ${audioDiag.decodedPackets}, err ${audioDiag.decodeErrors}, underrun ${audioDiag.underruns}, resync ${audioDiag.resyncs}`
        } else {
            this.elAudioGap.textContent = "—"
            this.elAudioDropReason.textContent = "—"
            this.elAudioBuffer.textContent = "—"
            this.elAudioPipeline.textContent = "—"
        }

        // Save for next delta
        this.prevBytesReceived = bytesReceived
        this.prevFramesReceived = framesReceived
        this.prevFramesDropped = framesDropped
        this.prevAudioBytesReceived = audioBytesReceived
        this.prevPacketsReceived = packetsReceived
        this.prevPacketsLost = packetsLost
        this.prevAudioMessagesReceived = audioMessagesReceived
    }

    destroy() {
        this.hide()
        this.peerGetter = null
        this.streamGetter = null
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.root)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.root)
    }
}
