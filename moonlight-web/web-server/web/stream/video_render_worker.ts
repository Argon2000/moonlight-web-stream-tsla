type InitMessage = {
    type: "init"
    canvas: OffscreenCanvas
    stretchToFit: boolean
    width: number
    height: number
}
type FrameMessage = { type: "frame"; frame: VideoFrame }
type ResizeMessage = { type: "resize"; width: number; height: number }
type StopMessage = { type: "stop" }
type WorkerMessage = InitMessage | FrameMessage | ResizeMessage | StopMessage

let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null
let stretchToFit = false
let drawWidth = 0
let drawHeight = 0
let offsetX = 0
let offsetY = 0
const workerSelf = self as any

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
    if (!canvas || !ctx) {
        frame.close()
        return
    }

    if (drawWidth === 0 || drawHeight === 0) {
        recalcForFrame(frame)
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
        ctx = canvas.getContext("2d")
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

    if (data.type === "frame") {
        drawFrame(data.frame)
        return
    }

    if (data.type === "stop") {
        canvas = null
        ctx = null
    }
}
