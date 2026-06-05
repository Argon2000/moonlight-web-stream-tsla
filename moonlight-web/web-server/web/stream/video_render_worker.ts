type InitMessage = {
    type: "init"
    canvas: OffscreenCanvas
    stretchToFit: boolean
    width: number
    height: number
}
type SetStreamMessage = { type: "setStream"; stream: ReadableStream<VideoFrame> }
type StopStreamMessage = { type: "stopStream" }
type FrameMessage = { type: "frame"; frame: VideoFrame }
type ResizeMessage = { type: "resize"; width: number; height: number }
type StopMessage = { type: "stop" }
type EnableStatsMessage = { type: "enable-stats" }
type DisableStatsMessage = { type: "disable-stats" }
type WorkerMessage = InitMessage | SetStreamMessage | StopStreamMessage | FrameMessage | ResizeMessage | StopMessage | EnableStatsMessage | DisableStatsMessage

// Message the worker sends back to the main thread
export type WorkerStatsMessage = {
    type: "stats"
    drawn: number
    dropped: number
    /** frames that arrived at the worker this interval */
    arrived: number
    /** inter-frame arrival gap stats (ms); -1 means no data yet */
    minGapMs: number
    avgGapMs: number
    maxGapMs: number
    /** source frame timestamp gap stats (ms); -1 means no data — detects encoder pacing issues */
    srcMinGapMs: number
    srcAvgGapMs: number
    srcMaxGapMs: number
}

let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null
let bitmapCtx: ImageBitmapRenderingContext | null = null
let useBitmapRenderer = false
let stretchToFit = false
let drawWidth = 0
let drawHeight = 0
let offsetX = 0
let offsetY = 0
const workerSelf = self as any

// Active reader when the ReadableStream has been transferred to this worker.
// All frame delivery happens here, bypassing the main-thread readLoop entirely.
let activeStreamReader: ReadableStreamDefaultReader<VideoFrame> | null = null

async function readStreamLoop(reader: ReadableStreamDefaultReader<VideoFrame>) {
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done || reader !== activeStreamReader) {
                if (!done && value) value.close()
                break
            }
            scheduleFrame(value)
        }
    } catch (_e) {
        // Stream was cancelled (stopStream / worker terminate) — expected, not an error
    }
}

// === Draw-immediately strategy ===
// On a 60Hz display the compositor picks up the latest canvas content at vsync
// regardless of how many drawImage calls happened. Drawing immediately on frame
// arrival ensures zero added latency and zero drift. At 60fps stream on 60Hz
// display this is exactly 1 draw per vsync.

let lastDrawnTimestamp: number = -1
let workerDrawn = 0
let workerDropped = 0

// Stats reporting enabled flag — controlled by main thread
let statsEnabled = false

// Arrival-timing accumulators (reset each stats interval)
let arrivalCount = 0
let lastArrivalMs = -1
let gapMin = Infinity
let gapMax = -Infinity
let gapSum = 0
let gapCount = 0

// Source frame timestamp gap tracking (detects encoder-side unevenness)
let lastFrameTimestamp = -1
let srcGapMin = Infinity
let srcGapMax = -Infinity
let srcGapSum = 0
let srcGapCount = 0

function clearPresentationQueue() { /* no queue — draw immediately */ }

function scheduleFrame(frame: VideoFrame) {
    // Track inter-frame arrival gap (only when stats enabled)
    if (statsEnabled) {
    const nowMs = typeof frame.timestamp === "number" && Number.isFinite(frame.timestamp)
        ? frame.timestamp / 1000
        : Date.now()
    if (lastArrivalMs >= 0) {
        const gap = nowMs - lastArrivalMs
        if (gap < gapMin) gapMin = gap
        if (gap > gapMax) gapMax = gap
        gapSum += gap
        gapCount++
    }
    lastArrivalMs = nowMs
    arrivalCount++
    }

    // Monotonic guard — discard exact duplicate timestamps only
    if (frame.timestamp === lastDrawnTimestamp) {
        frame.close()
        workerDropped++
        return
    }

    // Track source frame timestamp gaps (encoder pacing)
    if (statsEnabled && lastFrameTimestamp >= 0 && frame.timestamp > lastFrameTimestamp) {
        const srcGap = (frame.timestamp - lastFrameTimestamp) / 1000 // μs → ms
        if (srcGap < srcGapMin) srcGapMin = srcGap
        if (srcGap > srcGapMax) srcGapMax = srcGap
        srcGapSum += srcGap
        srcGapCount++
    }
    lastFrameTimestamp = frame.timestamp

    lastDrawnTimestamp = frame.timestamp
    drawFrame(frame)  // calls frame.close() — decoder buffer released immediately
    workerDrawn++
}

// Reusable stats message — avoids allocation each interval
const statsMsg: WorkerStatsMessage = {
    type: "stats", drawn: 0, dropped: 0, arrived: 0,
    minGapMs: -1, avgGapMs: -1, maxGapMs: -1,
    srcMinGapMs: -1, srcAvgGapMs: -1, srcMaxGapMs: -1,
}

// Post stats back to main thread every 2s (matches overlay refresh; reduces GC pressure)
setInterval(() => {
    if (!statsEnabled) return
    statsMsg.drawn = workerDrawn
    statsMsg.dropped = workerDropped
    statsMsg.arrived = arrivalCount
    statsMsg.minGapMs = gapCount > 0 ? gapMin : -1
    statsMsg.avgGapMs = gapCount > 0 ? gapSum / gapCount : -1
    statsMsg.maxGapMs = gapCount > 0 ? gapMax : -1
    statsMsg.srcMinGapMs = srcGapCount > 0 ? srcGapMin : -1
    statsMsg.srcAvgGapMs = srcGapCount > 0 ? srcGapSum / srcGapCount : -1
    statsMsg.srcMaxGapMs = srcGapCount > 0 ? srcGapMax : -1
    workerSelf.postMessage(statsMsg)
    // Reset interval accumulators
    arrivalCount = 0
    gapMin = Infinity; gapMax = -Infinity; gapSum = 0; gapCount = 0
    srcGapMin = Infinity; srcGapMax = -Infinity; srcGapSum = 0; srcGapCount = 0
}, 2000)

function recalcForFrame(frame: VideoFrame) {
    if (!canvas) return

    const safeHeight = Math.max(1, canvas.height)
    const safeDisplayHeight = Math.max(1, frame.displayHeight)
    const canvasAspect = canvas.width / safeHeight
    const frameAspect = frame.displayWidth / safeDisplayHeight

    offsetX = 0
    offsetY = 0

    if (stretchToFit) {
        drawWidth = canvas.width
        drawHeight = canvas.height
        return
    }

    // Keep source resolution in non-stretch mode.
    if (drawWidth === 0 || drawHeight === 0) {
        canvas.width = frame.displayWidth
        canvas.height = frame.displayHeight
    }

    if (canvasAspect > frameAspect) {
        drawHeight = canvas.height
        drawWidth = drawHeight * frameAspect
        offsetX = (canvas.width - drawWidth) / 2
    } else {
        drawWidth = canvas.width
        drawHeight = drawWidth / frameAspect
        offsetY = (canvas.height - drawHeight) / 2
    }
}

function drawFrame(frame: VideoFrame) {
    if (!canvas) {
        frame.close()
        return
    }

    if (drawWidth === 0 || drawHeight === 0) {
        recalcForFrame(frame)
    }

    if (useBitmapRenderer && bitmapCtx) {
        // ImageBitmapRenderingContext path: atomic frame handoff to compositor
        // createImageBitmap resize handles scaling; transferFromImageBitmap is a
        // zero-copy ownership transfer that guarantees the compositor picks it up.
        createImageBitmap(frame, {
            resizeWidth: drawWidth,
            resizeHeight: drawHeight,
            resizeQuality: "low",
        }).then(bitmap => {
            bitmapCtx!.transferFromImageBitmap(bitmap)
            // Explicitly close the bitmap to eagerly free the JS wrapper and reduce GC pressure
            bitmap.close()
            // Close the frame ONLY after createImageBitmap is done to ensure it's not prematurely recycled
            frame.close()
        }).catch(() => {
            frame.close()
        })
        return
    }

    if (!ctx) {
        frame.close()
        return
    }

    if (offsetX !== 0 || offsetY !== 0) {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
    }

    ctx.drawImage(frame, offsetX, offsetY, drawWidth, drawHeight)
    frame.close()
}

workerSelf.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const data = event.data
    if (!data) return

    if (data.type === "init") {
        canvas = data.canvas
        stretchToFit = data.stretchToFit
        canvas.width = Math.max(1, data.width)
        canvas.height = Math.max(1, data.height)
        drawWidth = 0
        drawHeight = 0
        offsetX = 0
        offsetY = 0
        // Try bitmaprenderer first — it uses transferFromImageBitmap which is an
        // atomic compositor handoff, avoiding the 30fps compositing bug with 2D context
        // in worker OffscreenCanvas on some Chromium builds (e.g. Tesla browser).
        bitmapCtx = canvas.getContext("bitmaprenderer", { alpha: false }) as ImageBitmapRenderingContext | null
        if (bitmapCtx) {
            useBitmapRenderer = true
            ctx = null
        } else {
            useBitmapRenderer = false
            ctx = canvas.getContext("2d", { alpha: false, desynchronized: true })
        }
        return
    }

    if (data.type === "resize") {
        if (!canvas) return
        if (stretchToFit) {
            canvas.width = Math.max(1, data.width)
            canvas.height = Math.max(1, data.height)
            drawWidth = canvas.width
            drawHeight = canvas.height
            offsetX = 0
            offsetY = 0
        } else {
            drawWidth = 0
            drawHeight = 0
            offsetX = 0
            offsetY = 0
        }
        return
    }

    if (data.type === "setStream") {
        if (activeStreamReader) {
            const old = activeStreamReader
            activeStreamReader = null
            old.cancel().catch(() => {})
        }
        lastDrawnTimestamp = -1
        lastArrivalMs = -1
        activeStreamReader = data.stream.getReader()
        readStreamLoop(activeStreamReader)
        return
    }

    if (data.type === "stopStream") {
        if (activeStreamReader) {
            activeStreamReader.cancel().catch(() => {})
            activeStreamReader = null
        }
        return
    }

    if (data.type === "frame") {
        scheduleFrame(data.frame)
        return
    }

    if (data.type === "stop") {
        if (activeStreamReader) { activeStreamReader.cancel().catch(() => {}); activeStreamReader = null }
        lastDrawnTimestamp = -1
        canvas = null
        ctx = null
    }

    if (data.type === "enable-stats") { statsEnabled = true }
    if (data.type === "disable-stats") { statsEnabled = false }
}
