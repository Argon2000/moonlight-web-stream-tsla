// @ts-ignore
import Module from "./opus-stream-decoder.mjs"

type InitMessage = { type: "init" }
type DecodeMessage = { type: "decode"; packet: ArrayBuffer }
type FreeMessage = { type: "free" }
type WorkerInMessage = InitMessage | DecodeMessage | FreeMessage

type ReadyMessage = { type: "ready" }
type DecodedMessage = { type: "decoded"; left: ArrayBuffer; right: ArrayBuffer }
type ErrorMessage = { type: "error"; message: string }
type WorkerOutMessage = ReadyMessage | DecodedMessage | ErrorMessage

let decoder: any = null
let decoderReady = false
const workerSelf = self as any

// The WASM file lives one directory up from this worker (at the web root),
// but fetch() in a worker resolves relative URLs against the worker's own URL
// (which is in the stream/ subdirectory). Intercept fetch to fix the path.
const originalFetch = workerSelf.fetch.bind(workerSelf)
workerSelf.fetch = function(input: any, init?: any) {
    if (typeof input === "string" && input.endsWith("opus-stream-decoder.wasm")) {
        input = "../opus-stream-decoder.wasm"
    }
    return originalFetch(input, init)
}

async function initDecoder() {
    try {
        const decoderModule = Module()
        const OpusStreamDecoder = decoderModule.OpusStreamDecoder
        decoder = new OpusStreamDecoder({
            onDecode: (decoded: any) => {
                try {
                    const left = decoded.left as Float32Array
                    const right = decoded.right as Float32Array

                    // Slice to create tight buffers that are safe to transfer.
                    const leftCopy = left.slice()
                    const rightCopy = right.slice()

                    const message: DecodedMessage = {
                        type: "decoded",
                        left: leftCopy.buffer,
                        right: rightCopy.buffer,
                    }
                    workerSelf.postMessage(message, [message.left, message.right])
                } catch (e) {
                    const errMsg: ErrorMessage = {
                        type: "error",
                        message: `audio worker decode callback failed: ${e}`,
                    }
                    workerSelf.postMessage(errMsg)
                }
            },
        })

        await decoder.ready
        decoderReady = true
        const ready: ReadyMessage = { type: "ready" }
        workerSelf.postMessage(ready)
    } catch (e) {
        const message: ErrorMessage = {
            type: "error",
            message: `audio worker init failed: ${e}`,
        }
        workerSelf.postMessage(message)
    }
}

workerSelf.onmessage = (event: MessageEvent<WorkerInMessage>) => {
    const data = event.data
    if (!data) return

    if (data.type === "init") {
        if (!decoderReady) {
            void initDecoder()
        }
        return
    }

    if (data.type === "decode") {
        if (!decoderReady || !decoder) return
        try {
            decoder.decode(new Uint8Array(data.packet))
        } catch (e) {
            const message: ErrorMessage = {
                type: "error",
                message: `audio worker decode failed: ${e}`,
            }
            workerSelf.postMessage(message)
        }
        return
    }

    if (data.type === "free") {
        if (decoder) {
            try {
                decoder.free()
            } catch {
                // best effort cleanup
            }
        }
        decoder = null
        decoderReady = false
    }
}
