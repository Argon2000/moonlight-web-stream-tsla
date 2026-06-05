declare class MediaStreamTrackProcessor {
    constructor(options: { track: MediaStreamTrack })
    readonly readable: ReadableStream<VideoFrame>
}

export class CanvasRenderer {
    canvas: HTMLCanvasElement | null
    ctx: CanvasRenderingContext2D | null
    videoTrack: MediaStreamTrack | null
    trackProcessor: MediaStreamTrackProcessor | null
    readableStream: ReadableStream | null
    frameReader: ReadableStreamDefaultReader | null
    latestFrame: VideoFrame | null
    isRunning: boolean = false
    private renderWorker: Worker | null = null
    private workerRenderingEnabled: boolean = false
    private workerAccelerationAllowed: boolean
    private workerInitAttempted: boolean = false
    private workerInitError: string | null = null
    private stretchToFit: boolean
    private handleResize: () => void

    // Hidden video element renderer: uses browser's native frame timing
    private hiddenVideo: HTMLVideoElement | null = null
    private useVideoElementSource: boolean
    private rafId: number = 0
    private drawRafPending: boolean = false
    private lastVideoTime: number = -1  // detect new frames via video.currentTime
    private videoDrawnCount: number = 0
    private videoNewFrameCount: number = 0  // times we detected a genuinely new frame

    constructor(canvasElement: HTMLCanvasElement, stretchToFit: boolean, enableWorkerAcceleration: boolean = true) {
        this.canvas = canvasElement
        this.ctx = null
        this.videoTrack = null
        this.trackProcessor = null
        this.readableStream = null
        this.frameReader = null
        this.latestFrame = null
        this.stretchToFit = stretchToFit
        this.workerAccelerationAllowed = enableWorkerAcceleration
        // Use hidden video element source by default — it leverages the browser's
        // native frame timing/smoothing instead of the batchy MediaStreamTrackProcessor pipeline.
        // Falls back to MSTP if the video element doesn't produce frames.
        // DISABLED: Tesla kills <video> playback in drive mode, causing black screen.
        // The MSTP/worker path is the only one that works in drive mode.
        this.useVideoElementSource = false
        this.workerAccelerationAllowed = enableWorkerAcceleration
        this.drawLoop = this.drawLoop.bind(this)
        this.handleResize = () => {
            if (!this.canvas) return
            if (this.workerRenderingEnabled && this.renderWorker) {
                this.renderWorker.postMessage({
                    type: "resize",
                    width: Math.max(1, this.canvas.clientWidth),
                    height: Math.max(1, this.canvas.clientHeight),
                })
                return
            }

            if (this.useVideoElementSource) {
                // Reset layout so it recalculates on next draw
                this.drawWidth = 0
                this.drawHeight = 0
                return
            }

            if (this.stretchToFit) {
                this.canvas.width = this.canvas.clientWidth
                this.canvas.height = this.canvas.clientHeight
                this.drawWidth = this.canvas.width
                this.drawHeight = this.canvas.height
                this.offsetX = 0
                this.offsetY = 0
            } else {
                // For non-stretch mode we need the next video frame to recalc sizes
                this.drawWidth = 0
                this.drawHeight = 0
            }
        }
        window.addEventListener("resize", this.handleResize)
    }

    private trySetupRenderWorker() {
        this.workerInitAttempted = true

        if (!this.workerAccelerationAllowed || this.renderWorker || this.workerRenderingEnabled || !this.canvas) {
            return
        }

        const transfer = (this.canvas as any).transferControlToOffscreen
        if (typeof Worker === "undefined" || typeof transfer !== "function") {
            if (typeof Worker === "undefined") {
                this.workerInitError = "Worker API unsupported"
            } else {
                this.workerInitError = "OffscreenCanvas transfer unsupported"
            }
            return
        }

        try {
            const offscreen = transfer.call(this.canvas) as OffscreenCanvas
            this.renderWorker = new Worker(new URL("./video_render_worker.js", import.meta.url), { type: "module" })
            this.renderWorker.onmessage = (event: MessageEvent) => {
                if (event.data?.type === "stats") {
                    this.workerDrawnFrameCount   = event.data.drawn
                    this.workerDroppedFrameCount = event.data.dropped
                    this.workerArrivedCount      = event.data.arrived
                    this.workerMinGapMs          = event.data.minGapMs
                    this.workerAvgGapMs          = event.data.avgGapMs
                    this.workerMaxGapMs          = event.data.maxGapMs
                }
            }
            this.renderWorker.postMessage({
                type: "init",
                canvas: offscreen,
                stretchToFit: this.stretchToFit,
                width: Math.max(1, this.canvas.clientWidth),
                height: Math.max(1, this.canvas.clientHeight),
            }, [offscreen as any])
            this.workerRenderingEnabled = true
            this.workerInitError = null
        } catch (e) {
            console.error("Failed to initialize video render worker, falling back to main-thread canvas rendering", e)
            this.renderWorker = null
            this.workerRenderingEnabled = false
            this.workerInitError = String(e)
        }
    }

    getWorkerDiagnostics() {
        const isWorkerActive = this.workerRenderingEnabled
        const isVideoElementActive = this.useVideoElementSource && this.hiddenVideo != null
        const mainMinGapMs = this.drawGapMin
        const mainAvgGapMs = this.drawGapAvg
        const mainMaxGapMs = this.drawGapMax
        const mainJumpCount = this.drawJumpCount

        // Expose a rolling main-thread gap window instead of a lifetime max.
        // The stats overlay polls periodically, so resetting here makes max-gap
        // reflect only the most recent interval and highlights fresh stutter spikes.
        if (!isWorkerActive && !isVideoElementActive) {
            this.drawGapMin = -1
            this.drawGapAvg = -1
            this.drawGapMax = -1
            this.drawJumpCount = 0
        }

        return {
            allowed: this.workerAccelerationAllowed,
            attempted: this.workerInitAttempted,
            active: isWorkerActive,
            hasWorkerInstance: this.renderWorker != null,
            error: this.workerInitError,
            // In video-element mode report video element stats
            // In worker mode use counts reported back from the worker;
            // in main-thread mode use the rAF-loop counters.
            rafMissedFrames: isWorkerActive ? this.workerDroppedFrameCount : this.rafMissedFrames,
            drawnFrameCount: isVideoElementActive ? this.videoDrawnCount : (isWorkerActive ? this.workerDrawnFrameCount : this.drawnFrameCount),
            arrivedCount:    isVideoElementActive ? this.videoNewFrameCount : (isWorkerActive ? this.workerArrivedCount : this.mainArrivedCount),
            supersededCount: isWorkerActive ? 0 : this.mainSupersededCount,
            jumpCount:       isWorkerActive ? 0 : mainJumpCount,
            minGapMs:        isWorkerActive ? this.workerMinGapMs          : mainMinGapMs,
            avgGapMs:        isWorkerActive ? this.workerAvgGapMs          : mainAvgGapMs,
            maxGapMs:        isWorkerActive ? this.workerMaxGapMs          : mainMaxGapMs,
            videoElementMode: isVideoElementActive,
        }
    }

    setVideoTrack(track: MediaStreamTrack) {
        if (this.videoTrack === track) {
            return
        }

        this.stopRendering() // Stop any existing rendering
        this.videoTrack = track

        if (this.videoTrack) {
            if (this.useVideoElementSource) {
                // Hidden video element approach: attach track to a hidden <video>,
                // let the browser handle jitter buffer smoothing and frame timing natively,
                // then draw from the video element to canvas at each rAF.
                this.setupHiddenVideoElement(this.videoTrack)
                this.startRenderingFromVideo()
            } else {
                // Legacy: MediaStreamTrackProcessor → ReadableStream → Worker/main-thread
                if (!("MediaStreamTrackProcessor" in window)) {
                    console.error("MediaStreamTrackProcessor not supported in this browser.")
                    return
                }
                try {
                    this.trackProcessor = new MediaStreamTrackProcessor({ track: this.videoTrack })
                    this.readableStream = this.trackProcessor.readable
                    this.startRendering()
                } catch (e) {
                    console.error("Error creating MediaStreamTrackProcessor:", e)
                }
            }
        }
    }

    private setupHiddenVideoElement(track: MediaStreamTrack) {
        this.hiddenVideo = document.createElement("video")
        this.hiddenVideo.style.position = "absolute"
        this.hiddenVideo.style.width = "1px"
        this.hiddenVideo.style.height = "1px"
        this.hiddenVideo.style.opacity = "0"
        this.hiddenVideo.style.pointerEvents = "none"
        this.hiddenVideo.muted = true
        this.hiddenVideo.autoplay = true
        this.hiddenVideo.playsInline = true
        this.hiddenVideo.srcObject = new MediaStream([track])
        // Append to DOM so the browser actually decodes frames
        document.body.appendChild(this.hiddenVideo)
        this.hiddenVideo.play().catch(e => console.error("Hidden video play failed:", e))
    }

    private startRenderingFromVideo() {
        if (!this.canvas || !this.hiddenVideo) return
        this.ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true })
        this.isRunning = true
        this.lastVideoTime = -1
        this.videoDrawnCount = 0
        this.videoNewFrameCount = 0

        // Use requestVideoFrameCallback if available for frame-precise timing,
        // otherwise fall back to requestAnimationFrame
        if ("requestVideoFrameCallback" in this.hiddenVideo) {
            this.videoFrameCallbackLoop()
        } else {
            this.videoRafLoop()
        }
    }

    private videoFrameCallbackLoop() {
        if (!this.isRunning || !this.hiddenVideo) return
        this.hiddenVideo.requestVideoFrameCallback((_now, _metadata) => {
            this.drawFromVideoElement()
            this.videoFrameCallbackLoop()
        })
    }

    private videoRafLoop() {
        if (!this.isRunning) return
        this.rafId = requestAnimationFrame(() => {
            this.drawFromVideoElement()
            this.videoRafLoop()
        })
    }

    private drawFromVideoElement() {
        if (!this.ctx || !this.canvas || !this.hiddenVideo) return
        if (this.hiddenVideo.readyState < 2) return  // HAVE_CURRENT_DATA

        const currentTime = this.hiddenVideo.currentTime
        if (currentTime === this.lastVideoTime) return  // no new frame
        this.lastVideoTime = currentTime
        this.videoNewFrameCount++

        const vw = this.hiddenVideo.videoWidth
        const vh = this.hiddenVideo.videoHeight
        if (vw === 0 || vh === 0) return

        // Recalculate layout if needed
        if (this.drawWidth === 0 || this.drawHeight === 0) {
            this.recalcLayoutFromDimensions(vw, vh)
        }

        if (this.offsetX !== 0 || this.offsetY !== 0) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
        }
        this.ctx.drawImage(this.hiddenVideo, this.offsetX, this.offsetY, this.drawWidth, this.drawHeight)
        this.videoDrawnCount++
    }

    private recalcLayoutFromDimensions(frameWidth: number, frameHeight: number) {
        if (!this.canvas) return
        const canvasAspect = this.canvas.clientWidth / this.canvas.clientHeight
        const frameAspect = frameWidth / frameHeight
        this.offsetX = 0
        this.offsetY = 0

        if (this.stretchToFit) {
            this.canvas.width = this.canvas.clientWidth
            this.canvas.height = this.canvas.clientHeight
            this.drawWidth = this.canvas.width
            this.drawHeight = this.canvas.height
        } else {
            this.canvas.width = frameWidth
            this.canvas.height = frameHeight
            if (canvasAspect > frameAspect) {
                this.drawHeight = this.canvas.height
                this.drawWidth = this.drawHeight * frameAspect
                this.offsetX = (this.canvas.width - this.drawWidth) / 2
            } else {
                this.drawWidth = this.canvas.width
                this.drawHeight = this.drawWidth / frameAspect
                this.offsetY = (this.canvas.height - this.drawHeight) / 2
            }
        }
    }

    // Try to hand the ReadableStream to the worker so it pulls frames directly,
    // bypassing the main-thread async readLoop entirely. Falls back gracefully if
    // the browser does not support transferable ReadableStream (Chrome 87+).
    private tryTransferStreamToWorker(): boolean {
        if (!this.renderWorker || !this.workerRenderingEnabled || !this.readableStream) {
            return false
        }
        try {
            this.renderWorker.postMessage(
                { type: "setStream", stream: this.readableStream },
                [this.readableStream as any]
            )
            this.readableStream = null  // worker now owns it
            this.workerOwnsStream = true
            return true
        } catch (_e) {
            // Browser doesn't support transferable ReadableStream — fall back to postMessage frames
            this.workerOwnsStream = false
            return false
        }
    }

    startRendering() {
        if ((this.readableStream || this.frameReader) && !this.isRunning) {
            this.trySetupRenderWorker()
            if (!this.workerRenderingEnabled && this.canvas && !this.ctx) {
                this.ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true })
            }
            this.isRunning = true
            if (this.workerRenderingEnabled && this.tryTransferStreamToWorker()) {
                // Worker owns the ReadableStream and reads frames directly on its own thread.
                // No main-thread readLoop needed — this is the zero-main-thread-involvement path.
            } else {
                // Main-thread path: readLoop stores latest frame, drawLoop renders at vsync.
                this.workerOwnsStream = false
                if (!this.frameReader && this.readableStream) {
                    this.frameReader = this.readableStream.getReader()
                }
                this.readLoop()
                this.startDrawLoop()
            }
        }
    }

    private scheduleDraw() {
        if (!this.isRunning || this.workerRenderingEnabled || this.useVideoElementSource) {
            return
        }
        if (this.drawRafPending) {
            return
        }
        this.drawRafPending = true
        this.rafId = requestAnimationFrame(this.drawLoop)
    }

    /** Start the continuous rAF render loop (runs every vsync). */
    private startDrawLoop() {
        if (this.drawRafPending) return
        this.drawRafPending = true
        this.rafId = requestAnimationFrame(this.drawLoop)
    }

    stopRendering() {
        this.isRunning = false
        this.drawRafPending = false
        if (this.rafId) {
            cancelAnimationFrame(this.rafId)
            this.rafId = 0
        }
        if (this.hiddenVideo) {
            this.hiddenVideo.pause()
            this.hiddenVideo.srcObject = null
            this.hiddenVideo.remove()
            this.hiddenVideo = null
        }
        if (this.workerOwnsStream && this.renderWorker) {
            // Tell the worker to cancel its stream reader
            this.renderWorker.postMessage({ type: "stopStream" })
            this.workerOwnsStream = false
            this.readableStream = null  // worker owns/cancels it
        }
        if (this.frameReader) {
            this.frameReader.cancel()
            this.frameReader = null
        }
        if (this.trackProcessor) {
            // Only cancel the readable if we still hold a reference to it
            if (this.readableStream) {
                this.readableStream.cancel().catch(() => {})
                this.readableStream = null
            }
            this.trackProcessor = null
        }
        if (this.latestFrame) {
            this.latestFrame.close()
            this.latestFrame = null
        }
        this.videoTrack = null
    }

    async readLoop() {
        if (!this.frameReader) return

        try {
            while (this.isRunning && this.frameReader) {
                const { value, done } = await this.frameReader.read()
                if (done) {
                    this.stopRendering()
                    break
                }

                if (this.workerRenderingEnabled && this.renderWorker) {
                    // Transfer frame ownership to worker for rasterization.
                    this.renderWorker.postMessage({ type: "frame", frame: value }, [value as any])
                    continue
                }

                // Store only the latest frame for rAF-paced rendering.
                // At 120fps decode on a 60Hz display, draw-immediately wastes 2x GPU
                // budget drawing frames that are overwritten before vsync scans them out.
                // rAF pacing ensures exactly one draw per display refresh — halves GPU
                // work and produces perfectly even frame timing.
                this.mainArrivedCount++
                const prev = this.latestFrame
                const prevWasDrawn = this.latestFrameDrawn
                this.latestFrame = value
                this.latestFrameDrawn = false
                if (prev) {
                    // Previous frame was never drawn — it got superseded
                    if (!prevWasDrawn) this.mainSupersededCount++
                    prev.close()
                }
            }
        } catch (e) {
            console.error("Error reading video frame:", e)
            this.stopRendering()
        }
    }

    private drawFrameImmediate(frame: VideoFrame) {
        if (!this.ctx || !this.canvas) {
            frame.close()
            return
        }

        if (this.drawWidth === 0) {
            this.onFirstFrameAfterResize(frame)
        }

        if (this.offsetX !== 0 || this.offsetY !== 0) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
        }
        this.ctx.drawImage(frame, this.offsetX, this.offsetY, this.drawWidth, this.drawHeight)
        
        // Eagerly transfer GPU rasterization out of JS memory and close the frame
        // to massively decrease GC pressure, avoiding the wait for the next frame
        this.drawnFrameCount++
        this.latestFrameDrawn = true
        frame.close()
        this.latestFrame = null
    }

    private offsetX = 0;
    private offsetY = 0;
    private drawWidth = 0;
    private drawHeight = 0;
    // true when the worker has taken ownership of the ReadableStream via setStream transfer
    private workerOwnsStream: boolean = false
    private rafMissedFrames: number = 0;  // rAF ticks with no decoded frame ready (stream not started)
    private drawnFrameCount: number = 0;
    private latestFrameDrawn: boolean = false;  // true once we've drawn the current latestFrame
    // Main-thread frame pacing stats
    private mainArrivedCount: number = 0;       // total frames received by readLoop
    private mainSupersededCount: number = 0;    // frames closed without ever being drawn
    private lastDrawTime: number = 0;           // performance.now() of last draw
    private drawGapMin: number = -1;
    private drawGapAvg: number = -1;
    private drawGapMax: number = -1;
    private drawJumpCount: number = 0;          // draw gaps > 25ms in current diagnostics interval
    // Stats received from the render worker (worker mode)
    private workerDrawnFrameCount: number = 0;
    private workerDroppedFrameCount: number = 0;
    private workerArrivedCount: number = 0;
    private workerMinGapMs: number = -1;
    private workerAvgGapMs: number = -1;
    private workerMaxGapMs: number = -1;

    setStatsEnabled(enabled: boolean) {
        if (this.renderWorker) {
            this.renderWorker.postMessage({ type: enabled ? 'enable-stats' : 'disable-stats' })
        }
    }

    public onFirstFrameAfterResize(frame: VideoFrame) {
        if(!this.canvas) return
        // Calculate aspect ratios
        const canvasAspect = this.canvas.clientWidth / this.canvas.clientHeight
        const frameAspect = frame.displayWidth / frame.displayHeight

        // Reset offsets to avoid stale values from a previous layout
        this.offsetX = 0
        this.offsetY = 0

        if (this.stretchToFit) {
            this.canvas.width = this.canvas.clientWidth
            this.canvas.height = this.canvas.clientHeight
            this.drawWidth = this.canvas.width
            this.drawHeight = this.canvas.height
            this.offsetX = 0
            this.offsetY = 0
        } else {
            this.canvas.width = frame.displayWidth
            this.canvas.height = frame.displayHeight

            if (canvasAspect > frameAspect) {
                // Canvas is wider than the video frame, so the video will be pillarboxed.
                this.drawHeight = this.canvas.height
                this.drawWidth = this.drawHeight * frameAspect
                this.offsetX = (this.canvas.width - this.drawWidth) / 2
            } else {
                // Canvas is taller than the video frame, so the video will be letterboxed.
                this.drawWidth = this.canvas.width
                this.drawHeight = this.drawWidth / frameAspect
                this.offsetY = (this.canvas.height - this.drawHeight) / 2
            }
        }
    }

    drawLoop() {
        this.drawRafPending = false
        if (!this.isRunning) return

        // Always reschedule — continuous rAF loop ensures we never miss a vsync
        // waiting for readLoop to deliver a frame. Cost when idle: ~1μs per tick.
        this.drawRafPending = true
        this.rafId = requestAnimationFrame(this.drawLoop)

        if (!this.ctx || !this.canvas) return

        if (!this.latestFrame) {
            // No frame has ever arrived yet (stream startup)
            this.rafMissedFrames++
            return
        }

        // If we already drew this frame, skip — no new content to render.
        // This happens when display refresh > stream FPS (e.g. 120Hz display, 60fps stream).
        if (this.latestFrameDrawn) return

        const frame = this.latestFrame
        this.latestFrameDrawn = true
        
        if(this.drawWidth === 0) {
            this.onFirstFrameAfterResize(frame)
        }

        // Only clear when there's letterboxing/pillarboxing; full-frame draw overwrites everything
        if (this.offsetX !== 0 || this.offsetY !== 0) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
        }
        this.ctx.drawImage(frame, this.offsetX, this.offsetY, this.drawWidth, this.drawHeight)
        this.drawnFrameCount++

        // If a fresher frame arrived while we were drawing, schedule another draw tick.
        if (!this.latestFrameDrawn) {
            this.scheduleDraw()
        }
    }

    destroy() {
        this.stopRendering()
        if (this.renderWorker) {
            this.renderWorker.postMessage({ type: "stop" })
            this.renderWorker.terminate()
            this.renderWorker = null
        }
        this.workerRenderingEnabled = false
        if (this.handleResize) {
            window.removeEventListener("resize", this.handleResize)
        }
        if (this.hiddenVideo) {
            this.hiddenVideo.pause()
            this.hiddenVideo.srcObject = null
            this.hiddenVideo.remove()
            this.hiddenVideo = null
        }
        this.canvas = null
        this.ctx = null
    }
}
