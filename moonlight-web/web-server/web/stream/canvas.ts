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
        return {
            allowed: this.workerAccelerationAllowed,
            attempted: this.workerInitAttempted,
            active: this.workerRenderingEnabled,
            hasWorkerInstance: this.renderWorker != null,
            error: this.workerInitError,
        }
    }

    setVideoTrack(track: MediaStreamTrack) {
        if (this.videoTrack === track) {
            return
        }

        this.stopRendering() // Stop any existing rendering
        this.videoTrack = track

        if (this.videoTrack) {
            if (!("MediaStreamTrackProcessor" in window)) {
                console.error("MediaStreamTrackProcessor not supported in this browser.")
                // Fallback or error handling if API is not available
                return
            }
            try {
                this.trackProcessor = new MediaStreamTrackProcessor({ track: this.videoTrack })
                this.readableStream = this.trackProcessor.readable
                this.frameReader = this.readableStream.getReader()
                this.startRendering()
            } catch (e) {
                console.error("Error creating MediaStreamTrackProcessor:", e)
            }
        }
    }

    startRendering() {
        if (this.frameReader && !this.isRunning) {
            this.trySetupRenderWorker()
            if (!this.workerRenderingEnabled && this.canvas && !this.ctx) {
                this.ctx = this.canvas.getContext("2d")
            }
            this.isRunning = true
            this.readLoop()
            if (!this.workerRenderingEnabled) {
                requestAnimationFrame(this.drawLoop)
            }
        }
    }

    stopRendering() {
        this.isRunning = false
        if (this.frameReader) {
            this.frameReader.cancel()
            this.frameReader = null
        }
        if (this.trackProcessor) {
            this.trackProcessor.readable.cancel()
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

                const old = this.latestFrame
                this.latestFrame = value
                if (old) old.close()
            }
        } catch (e) {
            console.error("Error reading video frame:", e)
            this.stopRendering()
        }
    }

    private offsetX = 0;
    private offsetY = 0;
    private drawWidth = 0;
    private drawHeight = 0;

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
        if (!this.isRunning) return
        
        requestAnimationFrame(this.drawLoop)

        if (!this.ctx || !this.latestFrame || !this.canvas) {
            return
        }

        const frame = this.latestFrame
        this.latestFrame = null
        
        if(this.drawWidth === 0) {
            this.onFirstFrameAfterResize(frame)
        }

        // Only clear when there's letterboxing/pillarboxing; full-frame draw overwrites everything
        if (this.offsetX !== 0 || this.offsetY !== 0) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
        }
        this.ctx.drawImage(frame, this.offsetX, this.offsetY, this.drawWidth, this.drawHeight)
        frame.close() // Close the VideoFrame to release resources
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
        this.canvas = null
        this.ctx = null
    }
}
