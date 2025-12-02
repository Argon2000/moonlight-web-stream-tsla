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
    pendingFrame: VideoFrame | null
    constructor(canvasElement: HTMLCanvasElement) {
        this.canvas = canvasElement
        this.ctx = canvasElement.getContext("2d")
        this.videoTrack = null
        this.trackProcessor = null
        this.readableStream = null
        this.frameReader = null
        this.pendingFrame = null
        this.onFrame = this.onFrame.bind(this)
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
        if (this.frameReader && !this.pendingFrame) {
            this.readAndDrawFrame()
        }
    }

    stopRendering() {
        if (this.frameReader) {
            this.frameReader.cancel()
            this.frameReader = null
        }
        if (this.trackProcessor) {
            this.trackProcessor.readable.cancel()
            this.trackProcessor = null
        }
        if (this.pendingFrame) {
            this.pendingFrame.close()
            this.pendingFrame = null
        }
        this.videoTrack = null
    }

    async readAndDrawFrame() {
        if (!this.frameReader) {
            return
        }

        try {
            const { value, done } = await this.frameReader.read()
            if (done) {
                this.stopRendering()
                return
            }
            this.pendingFrame = value
            requestAnimationFrame(this.onFrame)
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

    onFrame() {
        if (!this.ctx || !this.pendingFrame || !this.canvas) {
            this.readAndDrawFrame() // Try to read next frame if current is null
            return
        }

        if(this.drawWidth === 0) {
            this.onFirstFrameAfterResize(this.pendingFrame)
        }

        const frame = this.pendingFrame
        this.pendingFrame = null // Clear pending frame

        // Clear the canvas before drawing the new frame to prevent artifacts
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
        this.ctx.drawImage(frame, this.offsetX, this.offsetY, this.drawWidth, this.drawHeight)
        frame.close() // Close the VideoFrame to release resources

        this.readAndDrawFrame() // Read the next frame
    }

    destroy() {
        this.stopRendering()
        this.canvas = null
        this.ctx = null
    }
}
