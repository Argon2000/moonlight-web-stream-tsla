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
    constructor(canvasElement: HTMLCanvasElement) {
        this.canvas = canvasElement
        this.ctx = canvasElement.getContext("2d")
        this.videoTrack = null
        this.trackProcessor = null
        this.readableStream = null
        this.frameReader = null
        this.latestFrame = null
        this.drawLoop = this.drawLoop.bind(this)
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
            this.isRunning = true
            this.readLoop()
            requestAnimationFrame(this.drawLoop)
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
                
                if (this.latestFrame) {
                    this.latestFrame.close()
                }
                this.latestFrame = value
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

    drawLoop() {
        if (!this.isRunning) return
        
        requestAnimationFrame(this.drawLoop)

        if (!this.ctx || !this.latestFrame || !this.canvas) {
            return
        }

        const frame = this.latestFrame
        this.latestFrame = null // Clear reference so we don't draw it again (or close it twice)
        // Note: readLoop might overwrite latestFrame before we draw it, which is fine (we skip frames).
        // But we just took a reference 'frame'.
        // If readLoop updates 'this.latestFrame', it will close the *new* one when it updates again.
        // Wait, ownership issue:
        // readLoop sets latestFrame = frame1.
        // drawLoop takes frame = latestFrame (frame1).
        // readLoop sets latestFrame = frame2. Closes old latestFrame (frame1).
        // drawLoop tries to draw frame (frame1) which is now closed!
        
        // Fix: readLoop should NOT close the frame if it's currently being drawn?
        // Or drawLoop should clone? VideoFrame clone is cheap (shallow copy of handle).
        // Better: drawLoop takes ownership by setting this.latestFrame = null?
        // If readLoop sees latestFrame is not null, it closes it.
        // Race condition:
        // readLoop: sets latestFrame = frame1.
        // drawLoop: takes frame = latestFrame (frame1), sets this.latestFrame = null.
        // readLoop: gets frame2. Checks this.latestFrame (null). Sets this.latestFrame = frame2.
        // drawLoop: draws frame1. Closes frame1.
        // This works!
        // What if readLoop is faster?
        // readLoop: sets latestFrame = frame1.
        // readLoop: gets frame2. Checks latestFrame (frame1). Closes frame1. Sets latestFrame = frame2.
        // drawLoop: takes frame = latestFrame (frame2). Sets latestFrame = null.
        // drawLoop: draws frame2. Closes frame2.
        // We dropped frame1. Correct.
        
        // What if drawLoop is faster?
        // drawLoop: latestFrame is null. Returns.
        
        // So the logic holds:
        // readLoop: if (this.latestFrame) this.latestFrame.close(); this.latestFrame = value;
        // drawLoop: frame = this.latestFrame; this.latestFrame = null; if(frame) { draw(frame); frame.close(); }
        
        // One edge case: readLoop sets frame1. drawLoop takes it (sets field to null).
        // readLoop sets frame2 (sees null, doesn't close anything).
        // drawLoop draws frame1 and closes it.
        // Perfectly safe.
        
        if(this.drawWidth === 0) {
            this.onFirstFrameAfterResize(frame)
        }

        // Clear the canvas before drawing the new frame to prevent artifacts
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
        this.ctx.drawImage(frame, this.offsetX, this.offsetY, this.drawWidth, this.drawHeight)
        frame.close() // Close the VideoFrame to release resources
    }

    destroy() {
        this.stopRendering()
        this.canvas = null
        this.ctx = null
    }
}
