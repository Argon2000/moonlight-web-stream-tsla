import { StreamCapabilities, StreamControllerCapabilities, StreamMouseButton } from "../api_bindings.js"
import { ByteBuffer, I16_MAX, U16_MAX, U8_MAX } from "./buffer.js"
import { ControllerConfig, extractGamepadState, GamepadState, SUPPORTED_BUTTONS } from "./gamepad.js"
import { convertToKey, convertToModifiers } from "./keyboard.js"
import { convertToButton } from "./mouse.js"

// Smooth scrolling multiplier
const TOUCH_HIGH_RES_SCROLL_MULTIPLIER = 10
// Normal scrolling multiplier
const TOUCH_SCROLL_MULTIPLIER = 1
// Distance until a touch is 100% a click
const TOUCH_AS_CLICK_MAX_DISTANCE = 30
// Time till it's registered as a click, else it might be scrolling
const TOUCH_AS_CLICK_MIN_TIME_MS = 100
// Everything greater than this is a right click
const TOUCH_AS_CLICK_MAX_TIME_MS = 300
// How much to move to open up the screen keyboard when having three touches at the same time
const TOUCHES_AS_KEYBOARD_DISTANCE = 100

// When a virtual and physical controller connect within this many ms, prefer the physical and skip the virtual in auto mode
const VIRTUAL_SUPPRESSION_MS = 200

function trySendChannel(channel: RTCDataChannel | null, buffer: ByteBuffer) {
    if (!channel || channel.readyState != "open") {
        return
    }

    buffer.flip()
    const readView = buffer.getReadView()
    if (readView.byteLength == 0) {
        throw "illegal buffer size"
    }
    channel.send(readView)
}

export type MouseScrollMode = "highres" | "normal"
export type MouseMode = "relative" | "follow" | "pointAndDrag"

export type StreamInputConfig = {
    mouseMode: MouseMode
    mouseScrollMode: MouseScrollMode
    touchMode: "touch" | "mouseRelative" | "pointAndDrag"
    controllerConfig: ControllerConfig
    controllerDeviceMode?: "auto" | "physical" | "virtual"
}

export function defaultStreamInputConfig(): StreamInputConfig {
    return {
        mouseMode: "follow",
        mouseScrollMode: "highres",
        touchMode: "touch",
        controllerConfig: {
            invertAB: false,
            invertXY: false
        }
    }
}

export type ScreenKeyboardSetVisibleEvent = CustomEvent<{ visible: boolean }>

export class StreamInput {

    private eventTarget = new EventTarget()

    private peer: RTCPeerConnection | null = null

    private buffer: ByteBuffer = new ByteBuffer(1024)

    private connected = false
    private config: StreamInputConfig
    private capabilities: StreamCapabilities = { touch: true }
    // Size of the streamer device
    private streamerSize: [number, number] = [0, 0]

    private keyboard: RTCDataChannel | null = null
    private mouseClicks: RTCDataChannel | null = null
    private mouseAbsolute: RTCDataChannel | null = null
    private mouseRelative: RTCDataChannel | null = null
    private touch: RTCDataChannel | null = null
    private controllers: RTCDataChannel | null = null
    private controllerInputs: Array<RTCDataChannel | null> = []

    private touchSupported: boolean | null = null
    private previousStates: { [internalId: number]: GamepadState } = {}
    private scratchState: GamepadState = { buttonFlags: 0, leftTrigger: 0, rightTrigger: 0, leftStickX: 0, leftStickY: 0, rightStickX: 0, rightStickY: 0 }

    // Debug logging
    private debugLogs: Array<{ time: number; message: string }> = []
    private maxDebugLogs = 100

    constructor(config?: StreamInputConfig, peer?: RTCPeerConnection,) {
        if (peer) {
            this.setPeer(peer)
        }

        this.config = defaultStreamInputConfig()
        if (config) {
            this.setConfig(config)
        }
    }

    setPeer(peer: RTCPeerConnection) {
        if (this.peer) {
            this.keyboard?.close()
            this.mouseClicks?.close()
            this.mouseAbsolute?.close()
            this.mouseRelative?.close()
            this.touch?.close()
            this.controllers?.close()
            for (const controller of this.controllerInputs.splice(0, this.controllerInputs.length)) {
                controller?.close()
            }
        }
        this.peer = peer

        this.keyboard = peer.createDataChannel("keyboard")

        this.mouseClicks = peer.createDataChannel("mouseClicks", {
            ordered: false
        })
        this.mouseAbsolute = peer.createDataChannel("mouseAbsolute", {
            ordered: false,
            maxRetransmits: 0
        })
        this.mouseRelative = peer.createDataChannel("mouseRelative", {
            ordered: false
        })

        this.touch = peer.createDataChannel("touch")
        this.touch.onmessage = this.onTouchMessage.bind(this)

        this.controllers = peer.createDataChannel("controllers")
        this.controllers.addEventListener("message", this.onControllerMessage.bind(this))
    }

    setConfig(config: StreamInputConfig) {
        Object.assign(this.config, config)

        // Touch
        this.primaryTouch = null
        this.touchTracker.clear()
    }
    getConfig(): StreamInputConfig {
        return this.config
    }

    getCapabilities(): StreamCapabilities {
        return this.capabilities
    }

    private addDebugLog(message: string) {
        const now = Date.now()
        this.debugLogs.push({ time: now, message })
        if (this.debugLogs.length > this.maxDebugLogs) {
            this.debugLogs.shift()
        }
        console.log(`[DebugLog] ${message}`)
    }

    getDebugLogs(): Array<string> {
        const base = this.debugLogs.length > 0 ? this.debugLogs[0].time : 0
        return this.debugLogs.map((log, i) => `${((log.time - base) / 1000).toFixed(2)}s [${i}] ${log.message}`)
    }

    // -- External Event Listeners
    addScreenKeyboardVisibleEvent(listener: (event: ScreenKeyboardSetVisibleEvent) => void) {
        this.eventTarget.addEventListener("ml-screenkeyboardvisible", listener as any)
    }

    // -- On Stream Start
    onStreamStart(capabilities: StreamCapabilities, streamerSize: [number, number]) {
        this.connected = true

        this.capabilities = capabilities
        this.streamerSize = streamerSize
        this.registerBufferedControllers()
    }

    // -- Keyboard
    onKeyDown(event: KeyboardEvent) {
        if ("repeat" in event && event.repeat) {
            return
        }

        this.sendKeyEvent(true, event)
    }
    onKeyUp(event: KeyboardEvent) {
        this.sendKeyEvent(false, event)
    }

    onPaste(event: ClipboardEvent) {
        const data = event.clipboardData
        if (!data) {
            return
        }

        const text = data.getData("text/plain")
        if (text) {
            this.sendText(text)
        }
    }

    private sendKeyEvent(isDown: boolean, event: KeyboardEvent) {
        this.buffer.reset()

        const key = convertToKey(event)
        if (!key) {
            return
        }
        const modifiers = convertToModifiers(event)

        this.sendKey(isDown, key, modifiers)
    }

    // Note: key = StreamKeys.VK_, modifiers = StreamKeyModifiers.
    sendKey(isDown: boolean, key: number, modifiers: number) {
        this.buffer.putU8(0)

        this.buffer.putBool(isDown)
        this.buffer.putU8(modifiers)
        this.buffer.putU16(key)

        trySendChannel(this.keyboard, this.buffer)
    }
    sendText(text: string) {
        this.buffer.reset()

        this.buffer.putU8(1)

        this.buffer.putU8(text.length)
        this.buffer.putUtf8(text)

        trySendChannel(this.keyboard, this.buffer)
    }

    // -- Mouse
    onMouseDown(event: MouseEvent, rect: DOMRect) {
        const button = convertToButton(event)
        if (button == null) {
            return
        }

        if (this.config.mouseMode == "relative" || this.config.mouseMode == "follow") {
            this.sendMouseButton(true, button)
        } else if (this.config.mouseMode == "pointAndDrag") {
            this.sendMousePositionClientCoordinates(event.clientX, event.clientY, rect, button)
        }
    }
    onMouseUp(event: MouseEvent) {
        const button = convertToButton(event)
        if (button == null) {
            return
        }

        this.sendMouseButton(false, button)
    }
    onMouseMove(event: MouseEvent, rect: DOMRect) {
        if (this.config.mouseMode == "relative") {
            this.sendMouseMoveClientCoordinates(event.movementX, event.movementY, rect)
        } else if (this.config.mouseMode == "follow") {
            this.sendMousePositionClientCoordinates(event.clientX, event.clientY, rect)
        } else if (this.config.mouseMode == "pointAndDrag") {
            if (event.buttons) {
                // some button pressed
                this.sendMouseMoveClientCoordinates(event.movementX, event.movementY, rect)
            }
        }
    }
    onMouseWheel(event: WheelEvent) {
        this.sendAccumulatedScroll(event.deltaX / 5, -event.deltaY / 5)
    }

    sendMouseMove(movementX: number, movementY: number) {
        this.buffer.reset()

        this.buffer.putU8(0)
        this.buffer.putI16(movementX)
        this.buffer.putI16(movementY)

        trySendChannel(this.mouseRelative, this.buffer)
    }
    sendMouseMoveClientCoordinates(movementX: number, movementY: number, rect: DOMRect) {
        // Use screen diagonal as reference for consistent mouse movement across orientations.
        // Same physical drag distance = same mouse movement, whether phone is portrait or landscape.
        // Diagonal is orientation-independent: portrait and landscape have similar diagonals
        // even though their width/height ratios are opposite.
        const screenDiagonal = Math.sqrt(rect.width * rect.width + rect.height * rect.height);
        const SENSITIVITY_MULTIPLIER = 1.3; // Responsive dragging that works in both orientations
        const scaledMovementX = (movementX / screenDiagonal) * this.streamerSize[0] * SENSITIVITY_MULTIPLIER;
        const scaledMovementY = (movementY / screenDiagonal) * this.streamerSize[1] * SENSITIVITY_MULTIPLIER;

        this.sendMouseMove(scaledMovementX, scaledMovementY)
    }
    sendMousePosition(x: number, y: number, referenceWidth: number, referenceHeight: number) {
        this.buffer.reset()

        this.buffer.putU8(1)
        this.buffer.putI16(x)
        this.buffer.putI16(y)
        this.buffer.putI16(referenceWidth)
        this.buffer.putI16(referenceHeight)

        trySendChannel(this.mouseAbsolute, this.buffer)
    }
    sendMousePositionClientCoordinates(clientX: number, clientY: number, rect: DOMRect, mouseButton?: number) {
        const position = this.calcNormalizedPosition(clientX, clientY, rect)
        if (position) {
            const [x, y] = position
            this.sendMousePosition(x * 4096.0, y * 4096.0, 4096.0, 4096.0)

            if (mouseButton != undefined) {
                this.sendMouseButton(true, mouseButton)
            }
        }
    }
    // Note: button = StreamMouseButton.
    sendMouseButton(isDown: boolean, button: number) {
        this.buffer.reset()

        this.buffer.putU8(2)
        this.buffer.putBool(isDown)
        this.buffer.putU8(button)

        trySendChannel(this.mouseClicks, this.buffer)
    }
    private scrollRemainderX = 0
    private scrollRemainderY = 0

    private resetScrollRemainder() {
        this.scrollRemainderX = 0
        this.scrollRemainderY = 0
    }
    private sendAccumulatedScroll(deltaX: number, deltaY: number) {
        this.scrollRemainderX += deltaX
        this.scrollRemainderY += deltaY

        const integerX = Math.trunc(this.scrollRemainderX)
        const integerY = Math.trunc(this.scrollRemainderY)

        if (integerX == 0 && integerY == 0) {
            return
        }

        this.scrollRemainderX -= integerX
        this.scrollRemainderY -= integerY

        if (this.config.mouseScrollMode == "highres") {
            this.sendMouseWheelHighRes(integerX, integerY)
        } else if (this.config.mouseScrollMode == "normal") {
            this.sendMouseWheel(integerX, integerY)
        }
    }

    sendMouseWheelHighRes(deltaX: number, deltaY: number) {
        this.buffer.reset()

        this.buffer.putU8(3)
        this.buffer.putI16(deltaX)
        this.buffer.putI16(deltaY)

        trySendChannel(this.mouseClicks, this.buffer)
    }
    sendMouseWheel(deltaX: number, deltaY: number) {
        this.buffer.reset()

        this.buffer.putU8(4)
        this.buffer.putI8(deltaX)
        this.buffer.putI8(deltaY)

        trySendChannel(this.mouseClicks, this.buffer)
    }

    // -- Touch
    private touchTracker: Map<number, {
        startTime: number
        originX: number
        originY: number
        x: number
        y: number
        mouseClicked: boolean
        mouseMoved: boolean
    }> = new Map()
    private touchMouseAction: "default" | "scroll" | "screenKeyboard" = "default"
    private primaryTouch: number | null = null
    // Set when the current gesture has been consumed by a multi-touch action.
    // Prevents the remaining finger from producing a phantom click.
    private touchGestureSuppressClick: boolean = false

    private onTouchMessage(event: MessageEvent) {
        const data = event.data
        const buffer = new ByteBuffer(data)
        this.touchSupported = buffer.getBool()
    }

    private updateTouchTracker(touch: Touch) {
        const oldTouch = this.touchTracker.get(touch.identifier)
        if (!oldTouch) {
            this.touchTracker.set(touch.identifier, {
                startTime: Date.now(),
                originX: touch.clientX,
                originY: touch.clientY,
                x: touch.clientX,
                y: touch.clientY,
                mouseMoved: false,
                mouseClicked: false
            })
        } else {
            oldTouch.x = touch.clientX
            oldTouch.y = touch.clientY
        }
    }

    private calcTouchTime(touch: { startTime: number }): number {
        return Date.now() - touch.startTime
    }
    private calcTouchOriginDistance(
        touch: { x: number, y: number } | { clientX: number, clientY: number },
        oldTouch: { originX: number, originY: number }
    ): number {
        if ("clientX" in touch) {
            return Math.hypot(touch.clientX - oldTouch.originX, touch.clientY - oldTouch.originY)
        } else {
            return Math.hypot(touch.x - oldTouch.originX, touch.y - oldTouch.originY)
        }
    }

    onTouchStart(event: TouchEvent, rect: DOMRect) {
        if (this.touchTracker.size == 0) {
            this.touchGestureSuppressClick = false
        }

        for (const touch of event.changedTouches) {
            this.updateTouchTracker(touch)
        }

        if (this.config.touchMode == "touch") {
            for (const touch of event.changedTouches) {
                this.sendTouch(0, touch, rect)
            }
        } else if (this.config.touchMode == "mouseRelative" || this.config.touchMode == "pointAndDrag") {
            for (const touch of event.changedTouches) {
                if (this.primaryTouch == null) {
                    this.primaryTouch = touch.identifier
                    this.touchMouseAction = "default"
                }
            }

            if (this.primaryTouch != null && this.touchTracker.size == 2) {
                const primaryTouch = this.touchTracker.get(this.primaryTouch)
                if (primaryTouch && !primaryTouch.mouseMoved && !primaryTouch.mouseClicked) {
                    this.touchMouseAction = "scroll"
                    this.touchGestureSuppressClick = true
                    this.resetScrollRemainder()

                    if (this.config.touchMode == "pointAndDrag") {
                        let middleX = 0;
                        let middleY = 0;
                        for (const touch of this.touchTracker.values()) {
                            middleX += touch.x;
                            middleY += touch.y;
                        }
                        // Tracker size = 2 so there will only be 2 elements
                        middleX /= 2;
                        middleY /= 2;

                        primaryTouch.mouseMoved = true
                        this.sendMousePositionClientCoordinates(middleX, middleY, rect)
                    }
                }
            } else if (this.touchTracker.size == 3) {
                this.touchMouseAction = "screenKeyboard"
                this.touchGestureSuppressClick = true
            }
        }
    }

    onTouchUpdate(rect: DOMRect) {
        if (this.config.touchMode == "pointAndDrag") {
            if (this.primaryTouch == null) {
                return
            }
            const touch = this.touchTracker.get(this.primaryTouch)
            if (!touch) {
                return
            }

            const time = this.calcTouchTime(touch)
            if (this.touchMouseAction == "default" && !touch.mouseMoved && time >= TOUCH_AS_CLICK_MIN_TIME_MS) {
                this.sendMousePositionClientCoordinates(touch.originX, touch.originY, rect)

                touch.mouseMoved = true
            }
        }
    }

    onTouchMove(event: TouchEvent, rect: DOMRect) {
        if (this.config.touchMode == "touch") {
            for (const touch of event.changedTouches) {
                this.sendTouch(1, touch, rect)
            }
        } else if (this.config.touchMode == "mouseRelative" || this.config.touchMode == "pointAndDrag") {
            for (const touch of event.changedTouches) {
                if (this.primaryTouch != touch.identifier) {
                    continue
                }
                const oldTouch = this.touchTracker.get(this.primaryTouch)
                if (!oldTouch) {
                    continue
                }

                // mouse move
                const movementX = touch.clientX - oldTouch.x;
                const movementY = touch.clientY - oldTouch.y;

                if (this.touchMouseAction == "default") {
                    this.sendMouseMoveClientCoordinates(movementX, movementY, rect)

                    const distance = this.calcTouchOriginDistance(touch, oldTouch)
                    if (this.config.touchMode == "pointAndDrag" && distance > TOUCH_AS_CLICK_MAX_DISTANCE) {
                        if (!oldTouch.mouseMoved) {
                            this.sendMousePositionClientCoordinates(touch.clientX, touch.clientY, rect)
                            oldTouch.mouseMoved = true
                        }

                        if (!oldTouch.mouseClicked) {
                            this.sendMousePositionClientCoordinates(oldTouch.originX, oldTouch.originY, rect)
                            this.sendMouseButton(true, StreamMouseButton.LEFT)
                            oldTouch.mouseClicked = true
                        }
                    }
                } else if (this.touchMouseAction == "scroll") {
                    // inverting horizontal scroll
                    if (this.config.mouseScrollMode == "highres") {
                        this.sendAccumulatedScroll(
                            -movementX * TOUCH_HIGH_RES_SCROLL_MULTIPLIER,
                            movementY * TOUCH_HIGH_RES_SCROLL_MULTIPLIER
                        )
                    } else if (this.config.mouseScrollMode == "normal") {
                        this.sendAccumulatedScroll(
                            -movementX * TOUCH_SCROLL_MULTIPLIER,
                            movementY * TOUCH_SCROLL_MULTIPLIER
                        )
                    }
                } else if (this.touchMouseAction == "screenKeyboard") {
                    const distanceY = touch.clientY - oldTouch.originY

                    if (distanceY < -TOUCHES_AS_KEYBOARD_DISTANCE) {
                        const customEvent: ScreenKeyboardSetVisibleEvent = new CustomEvent("ml-screenkeyboardvisible", {
                            detail: { visible: true }
                        })
                        this.eventTarget.dispatchEvent(customEvent)
                    } else if (distanceY > TOUCHES_AS_KEYBOARD_DISTANCE) {
                        const customEvent: ScreenKeyboardSetVisibleEvent = new CustomEvent("ml-screenkeyboardvisible", {
                            detail: { visible: false }
                        })
                        this.eventTarget.dispatchEvent(customEvent)
                    }
                }
            }
        }

        for (const touch of event.changedTouches) {
            this.updateTouchTracker(touch)
        }
    }

    onTouchEnd(event: TouchEvent, rect: DOMRect) {
        if (this.config.touchMode == "touch") {
            for (const touch of event.changedTouches) {
                this.sendTouch(2, touch, rect)
            }
        } else if (this.config.touchMode == "mouseRelative" || this.config.touchMode == "pointAndDrag") {
            for (const touch of event.changedTouches) {
                if (this.primaryTouch != touch.identifier) {
                    continue
                }
                const oldTouch = this.touchTracker.get(this.primaryTouch)
                this.primaryTouch = null

                if (oldTouch) {
                    const time = this.calcTouchTime(oldTouch)
                    const distance = this.calcTouchOriginDistance(touch, oldTouch)

                    if (this.touchMouseAction == "default" && !this.touchGestureSuppressClick) {
                        if (distance <= TOUCH_AS_CLICK_MAX_DISTANCE) {
                            if (time <= TOUCH_AS_CLICK_MAX_TIME_MS || oldTouch.mouseClicked) {
                                if (this.config.touchMode == "pointAndDrag" && !oldTouch.mouseMoved) {
                                    this.sendMousePositionClientCoordinates(touch.clientX, touch.clientY, rect)
                                }
                                if (!oldTouch.mouseClicked) {
                                    this.sendMouseButton(true, StreamMouseButton.LEFT)
                                }
                                this.sendMouseButton(false, StreamMouseButton.LEFT)
                            } else {
                                this.sendMouseButton(true, StreamMouseButton.RIGHT)
                                this.sendMouseButton(false, StreamMouseButton.RIGHT)
                            }
                        } else if (this.config.touchMode == "pointAndDrag") {
                            this.sendMouseButton(true, StreamMouseButton.LEFT)
                            this.sendMouseButton(false, StreamMouseButton.LEFT)
                        }
                    }
                }
            }
        }

        for (const touch of event.changedTouches) {
            this.touchTracker.delete(touch.identifier)
        }

        if (this.touchMouseAction == "scroll" && this.touchTracker.size < 2) {
            this.touchMouseAction = "default"
            this.resetScrollRemainder()
        }

        if (this.touchTracker.size == 0) {
            this.touchGestureSuppressClick = false
        }
    }

    onTouchCancel(event: TouchEvent, rect: DOMRect) {
        if (this.config.touchMode == "touch") {
            for (const touch of event.changedTouches) {
                this.sendTouch(2, touch, rect)
            }
        } else {
            for (const trackedTouch of this.touchTracker.values()) {
                if (trackedTouch.mouseClicked) {
                    this.sendMouseButton(false, StreamMouseButton.LEFT)
                    trackedTouch.mouseClicked = false
                }
            }
        }

        this.touchTracker.clear()
        this.primaryTouch = null
        this.touchMouseAction = "default"
        this.touchGestureSuppressClick = false
        this.resetScrollRemainder()
    }

    private calcNormalizedPosition(clientX: number, clientY: number, rect: DOMRect): [number, number] | null {
        const x = (clientX - rect.left) / rect.width
        const y = (clientY - rect.top) / rect.height

        if (x < 0 || x > 1.0 || y < 0 || y > 1.0) {
            // invalid touch
            return null
        }
        return [x, y]
    }
    private sendTouch(type: number, touch: Touch, rect: DOMRect) {
        this.buffer.reset()

        this.buffer.putU8(type)

        this.buffer.putU32(touch.identifier)

        const position = this.calcNormalizedPosition(touch.clientX, touch.clientY, rect)
        if (!position) {
            return
        }
        const [x, y] = position
        this.buffer.putF32(x)
        this.buffer.putF32(y)

        this.buffer.putF32(touch.force)

        this.buffer.putF32(touch.radiusX)
        this.buffer.putF32(touch.radiusY)
        this.buffer.putU16(touch.rotationAngle)

        trySendChannel(this.touch, this.buffer)
    }

    isTouchSupported(): boolean | null {
        return this.touchSupported
    }

    // -- Controller
    // Wait for stream to connect and then send controllers
    private bufferedControllers: Array<number> = []
    private registerBufferedControllers() {
        const gamepads = navigator.getGamepads()
        this.addDebugLog(`registerBufferedControllers called with ${this.bufferedControllers.length} buffered controllers`)

        for (const index of this.bufferedControllers.splice(0)) {
            const gamepad = gamepads[index]
            this.addDebugLog(`Attempting to register buffered controller at index ${index}: ${gamepad ? gamepad.id : 'NOT FOUND'}`)
            if (gamepad) {
                this.onGamepadConnect(gamepad)
            }
        }

        // Gamepads already in `this.gamepads` were registered against a
        // *previous* peer's "controllers" channel (e.g. before a stream
        // reconnect). `setPeer()` always creates a brand new "controllers"
        // channel, which has no memory of that registration, but polling
        // keeps sending raw input for them on a freshly-recreated per-gamepad
        // channel regardless — so without re-announcing here, the host would
        // see input for a gamepad it never heard arrive, forever.
        for (const [, entry] of this.gamepads) {
            this.addDebugLog(`Re-announcing already-registered controller "${entry.gamepadId}" (internal ID ${entry.internalId}) to new peer`)
            this.sendControllerAdd(entry.internalId, SUPPORTED_BUTTONS, 0)
        }
    }

    private gamepads: Map<number, { internalId: number; gamepadId: string; vendorId: string | null; isVirtual: boolean }> = new Map() // Maps gamepad.index to metadata
    private pendingGamepads: Map<number, { gamepadId: string; vendorId: string | null; isVirtual: boolean; connectedAt: number }> = new Map()
    private pendingGamepadTimerId: ReturnType<typeof setInterval> | null = null  // 500ms timer for pending promotion

    /** True when there are gamepads that need polling (registered or pending). */
    hasGamepads(): boolean {
        return this.gamepads.size > 0 || this.pendingGamepads.size > 0
    }

    /** True when there's an active touch being tracked (for point-and-drag hold detection). */
    hasPrimaryTouch(): boolean {
        // onTouchUpdate work is only relevant in point-and-drag mode.
        if (this.config.touchMode !== "pointAndDrag") {
            return false
        }
        if (this.primaryTouch == null) {
            return false
        }
        // Guard against stale primaryTouch ids if a browser drops touchend/cancel.
        if (!this.touchTracker.has(this.primaryTouch)) {
            this.primaryTouch = null
            return false
        }
        return true
    }

    private getGamepadVendorId(gamepadOrId: Gamepad | string): string | null {
        const id = typeof gamepadOrId === "string" ? gamepadOrId : (gamepadOrId.id || "")
        const match = /VENDOR\s*:?\s*([0-9A-F]{4})/i.exec(id)
        return match ? match[1].toUpperCase() : null
    }

    private isVirtualGamepad(gamepadOrId: Gamepad | string): boolean {
        const id = typeof gamepadOrId === "string" ? gamepadOrId : (gamepadOrId.id || "")
        return /TESLA\s+VIRTUAL\s+GAMEPAD/i.test(id)
    }

    private removeRegisteredGamepad(index: number, reason: string) {
        const entry = this.gamepads.get(index)
        if (!entry) {
            return
        }

        this.addDebugLog(`${reason}: "${entry.gamepadId}" at index ${index} (internal ID ${entry.internalId})`)
        this.sendControllerRemove(entry.internalId)
        this.gamepads.delete(index)
        delete this.previousStates[entry.internalId]
        if (this.controllerInputs[entry.internalId]) {
            this.controllerInputs[entry.internalId]?.close()
            this.controllerInputs[entry.internalId] = null
        }
    }

    private registerGamepad(gamepad: Gamepad, vendorId: string | null, isVirtual: boolean) {
        // Find the lowest available internal ID
        let id = 0
        while (true) {
            let inUse = false
            for (const entry of this.gamepads.values()) {
                if (entry.internalId === id) {
                    inUse = true
                    break
                }
            }
            if (!inUse) break
            id++
        }

        this.gamepads.set(gamepad.index, { internalId: id, gamepadId: gamepad.id, vendorId, isVirtual })
        this.pendingGamepads.delete(gamepad.index)
        this.addDebugLog(`Connected "${gamepad.id}" at index ${gamepad.index} with internal ID ${id}, total: ${this.gamepads.size}, map keys: ${Array.from(this.gamepads.keys()).join(', ')}`)

        let capabilities = 0

        this.sendControllerAdd(id, SUPPORTED_BUTTONS, capabilities)

        if (gamepad.mapping != "standard") {
            console.warn(`[Gamepad]: Unable to read values of gamepad with mapping ${gamepad.mapping}`)
        }
    }

    private processPendingGamepads(gamepads: ArrayLike<Gamepad | null>) {
        if (this.pendingGamepads.size === 0) {
            return
        }

        // Collect current registered controller state signatures for mirror detection
        const registeredSignatures = new Set<string>()
        for (const [index, entry] of this.gamepads.entries()) {
            const gp = gamepads[index]
            if (gp) {
                const state = extractGamepadState(gp, this.config.controllerConfig, this.scratchState)
                if (!this.isNeutralGamepadState(state)) {
                    registeredSignatures.add(this.buildGamepadStateSignature(state))
                }
            }
        }

        const activePending: Array<{ index: number; gamepad: Gamepad; vendorId: string | null; isVirtual: boolean; state: GamepadState; connectedAt: number }> = []

        for (const [index, pending] of this.pendingGamepads.entries()) {
            const gamepad = gamepads[index] ?? null
            if (!gamepad || gamepad.id !== pending.gamepadId) {
                continue // Gamepad gone or identity changed at this index
            }

            const state = extractGamepadState(gamepad, this.config.controllerConfig, this.scratchState)
            if (this.isNeutralGamepadState(state)) {
                continue
            }

            // Skip if this state mirrors an already-registered controller
            const sig = this.buildGamepadStateSignature(state)
            if (registeredSignatures.has(sig)) {
                continue
            }

            activePending.push({
                index,
                gamepad,
                vendorId: pending.vendorId,
                isVirtual: pending.isVirtual,
                state: { ...state },
                connectedAt: pending.connectedAt
            })
        }

        if (activePending.length === 0) {
            return
        }

        // Group pending controllers by state signature so we can detect mirrors.
        const groups = new Map<string, Array<typeof activePending[number]>>()
        for (const candidate of activePending) {
            const sig = this.buildGamepadStateSignature(candidate.state)
            const list = groups.get(sig) ?? []
            list.push(candidate)
            groups.set(sig, list)
        }

        // For each group, choose which pending controller to promote based on
        // controllerDeviceMode and timing. In "physical" mode, skip virtual
        // devices entirely; in "virtual" mode, prefer virtual only; in "auto"
        // mode, prefer physical and if a virtual appears within VIRTUAL_SUPPRESSION_MS
        // of a physical connect, skip the virtual.
        for (const [sig, list] of groups.entries()) {
            if (!list || list.length === 0) continue

            // Determine mode (default to auto)
            const mode = this.config.controllerDeviceMode ?? "auto"

            let chosen: typeof list[0] | null = null

            if (mode === "physical") {
                // prefer physical; if none, pick earliest
                chosen = list.find(c => !c.isVirtual) ?? list.reduce((a, b) => (a.index < b.index ? a : b))
            } else if (mode === "virtual") {
                // prefer virtual; if none, pick earliest
                chosen = list.find(c => c.isVirtual) ?? list.reduce((a, b) => (a.index < b.index ? a : b))
            } else {
                // auto
                // find earliest physical and earliest virtual
                const physicals = list.filter(c => !c.isVirtual)
                const virtuals = list.filter(c => c.isVirtual)
                if (physicals.length > 0 && virtuals.length > 0) {
                    const earliestPhysical = physicals.reduce((a, b) => (a.connectedAt < b.connectedAt ? a : b))
                    const earliestVirtual = virtuals.reduce((a, b) => (a.connectedAt < b.connectedAt ? a : b))
                    const dt = Math.abs(earliestPhysical.connectedAt - earliestVirtual.connectedAt)
                    if (dt <= VIRTUAL_SUPPRESSION_MS) {
                        chosen = earliestPhysical
                    } else {
                        // far apart, pick the earliest connect overall
                        chosen = list.reduce((a, b) => (a.connectedAt < b.connectedAt ? a : b))
                    }
                } else {
                    // simple case: only one type present
                    chosen = list.reduce((a, b) => (a.connectedAt < b.connectedAt ? a : b))
                }
            }

            if (chosen) {
                // Remove every other candidate in this group from pendingGamepads so they
                // cannot slip through into a later poll and get promoted separately.
                for (const candidate of list) {
                    if (candidate !== chosen) {
                        this.pendingGamepads.delete(candidate.index)
                        this.addDebugLog(`[${mode}] Discarded non-chosen pending gamepad at index ${candidate.index}: ${candidate.gamepad.id}`)
                    }
                }
                this.registerGamepad(chosen.gamepad, chosen.vendorId, chosen.isVirtual)
            }
        }
    }

    onGamepadConnect(gamepad: Gamepad) {
        if (!this.connected || !this.controllers || this.controllers.readyState != "open") {
            this.bufferedControllers.push(gamepad.index)
            this.addDebugLog(`Buffering gamepad at index ${gamepad.index}: ${gamepad.id}`)
            return
        }

        // Use gamepad.index as unique key (gamepad.id is NOT unique on Tesla)
        if (this.gamepads.has(gamepad.index)) {
            // Already registered at this index, just verify identity
            const entry = this.gamepads.get(gamepad.index)!
            this.addDebugLog(`Gamepad index ${gamepad.index} already registered ("${entry.gamepadId}" internal ID ${entry.internalId}), got "${gamepad.id}"`)
            return
        }

        if (this.pendingGamepads.has(gamepad.index)) {
            this.addDebugLog(`Gamepad index ${gamepad.index} already pending, got "${gamepad.id}"`)
            return
        }

        const vendorId = this.getGamepadVendorId(gamepad)
        const isVirtual = this.isVirtualGamepad(gamepad)

        // In physical/virtual mode, reject the wrong device type at connect time
        // so it never enters the pending queue and cannot slip through later polls.
        const mode = this.config.controllerDeviceMode ?? "auto"
        if (mode === "physical" && isVirtual) {
            this.addDebugLog(`[physical mode] Rejected virtual gamepad at index ${gamepad.index}: ${gamepad.id}`)
            return
        }
        if (mode === "virtual" && !isVirtual) {
            this.addDebugLog(`[virtual mode] Rejected physical gamepad at index ${gamepad.index}: ${gamepad.id}`)
            return
        }

        // Auto mode: eagerly suppress virtual/physical pairing at connect time.
        // This handles both orderings (physical-first and virtual-first):
        //  - Virtual connects: if any physical is already pending or registered, reject
        //    the virtual immediately without waiting for a state-based poll.
        //  - Physical connects: evict any recently-connected virtual from pendingGamepads
        //    so it can never be promoted.
        if (mode === "auto") {
            const now = Date.now()
            if (isVirtual) {
                // Reject this virtual only if a physical with the same vendor ID is
                // already pending or registered AND connected within the suppression window.
                const matchingPhysicalPending = Array.from(this.pendingGamepads.values()).find(
                    p => !p.isVirtual && p.vendorId !== null && p.vendorId === vendorId &&
                         (now - p.connectedAt) <= VIRTUAL_SUPPRESSION_MS
                )
                const matchingPhysicalRegistered = Array.from(this.gamepads.values()).find(
                    e => !e.isVirtual && e.vendorId !== null && e.vendorId === vendorId
                )
                if (matchingPhysicalPending || matchingPhysicalRegistered) {
                    this.addDebugLog(`[auto] Rejected virtual gamepad (same vendor ${vendorId}, physical present): ${gamepad.id}`)
                    return
                }
            } else {
                // Physical just connected — evict any pending virtual with the same vendor ID
                // that connected within the suppression window.
                for (const [pidx, pending] of this.pendingGamepads.entries()) {
                    if (pending.isVirtual &&
                        pending.vendorId !== null && pending.vendorId === vendorId &&
                        (now - pending.connectedAt) <= VIRTUAL_SUPPRESSION_MS) {
                        this.addDebugLog(`[auto] Evicting pending virtual on physical connect (vendor ${vendorId}): ${pending.gamepadId}`)
                        this.pendingGamepads.delete(pidx)
                    }
                }
            }
        }

        this.pendingGamepads.set(gamepad.index, {
            gamepadId: gamepad.id,
            vendorId,
            isVirtual,
            connectedAt: Date.now()
        })
        this.ensurePendingGamepadTimer()
        this.addDebugLog(`Queued gamepad pending activation at index ${gamepad.index}: ${gamepad.id}`)
    }

    /** Start a 500ms timer to promote pending gamepads. Off the hot 60Hz path. */
    private ensurePendingGamepadTimer() {
        if (this.pendingGamepadTimerId != null) return
        this.pendingGamepadTimerId = setInterval(() => {
            if (this.pendingGamepads.size === 0) {
                clearInterval(this.pendingGamepadTimerId!)
                this.pendingGamepadTimerId = null
                return
            }
            const gamepads = navigator.getGamepads()
            this.processPendingGamepads(gamepads)
            if (this.pendingGamepads.size === 0) {
                clearInterval(this.pendingGamepadTimerId!)
                this.pendingGamepadTimerId = null
            }
        }, 500)
    }

    onGamepadDisconnect(event: GamepadEvent) {
        const index = event.gamepad.index
        if (this.pendingGamepads.has(index)) {
            this.addDebugLog(`Dropped pending gamepad on disconnect at index ${index}: ${event.gamepad.id}`)
            this.pendingGamepads.delete(index)
            return
        }
        if (this.gamepads.has(index)) {
            this.removeRegisteredGamepad(index, `Disconnected`)
        }
    }
    onGamepadUpdate() {
        const gamepads = navigator.getGamepads()
        if (this.gamepads.size === 0) return

        // Fast path for single registered gamepad (most common case):
        // avoid array allocation, sort, and dedup entirely.
        if (this.gamepads.size === 1) {
            const [index, entry] = this.gamepads.entries().next().value!
            const gamepad = gamepads[index]
            if (!gamepad || gamepad.id !== entry.gamepadId) return
            const state = extractGamepadState(gamepad, this.config.controllerConfig, this.scratchState)
            if (this.previousStates[entry.internalId] && this.areGamepadStatesEqual(this.previousStates[entry.internalId], state)) return
            this.previousStates[entry.internalId] = { ...state }
            this.sendController(entry.internalId, state)
            return
        }

        // Multi-gamepad path (rare): full dedup logic
        const pendingUpdates: Array<{
            internalId: number
            gamepadId: string
            timestamp: number
            state: GamepadState
        }> = []
        
        for (const [index, entry] of this.gamepads.entries()) {
            try {
                const gamepad = gamepads[index]
                
                // Verify the gamepad is still the same device by checking ID
                if (!gamepad || gamepad.id !== entry.gamepadId) {
                    // Index mismatch - browser may have reshuffled, find correct index
                    let foundAt = -1
                    for (let i = 0; i < gamepads.length; i++) {
                        if (gamepads[i] && gamepads[i]?.id === entry.gamepadId) {
                            foundAt = i
                            break
                        }
                    }
                    if (foundAt === -1) {
                        continue
                    }
                    this.addDebugLog(`Found "${entry.gamepadId}" at index ${foundAt}, re-keying`)
                    // Re-key the entry to the new index
                    this.gamepads.delete(index)
                    this.gamepads.set(foundAt, entry)
                    const gamepad2 = gamepads[foundAt]
                    if (!gamepad2) continue

                    const state = extractGamepadState(gamepad2, this.config.controllerConfig, this.scratchState)

                    if (!this.previousStates[entry.internalId] || !this.areGamepadStatesEqual(this.previousStates[entry.internalId], state)) {
                        pendingUpdates.push({
                            internalId: entry.internalId,
                            gamepadId: entry.gamepadId,
                            timestamp: gamepad2.timestamp ?? 0,
                            state: { ...state }
                        })
                        this.previousStates[entry.internalId] = { ...state }
                    }
                } else {
                    const state = extractGamepadState(gamepad, this.config.controllerConfig, this.scratchState)

                    if (!this.previousStates[entry.internalId] || !this.areGamepadStatesEqual(this.previousStates[entry.internalId], state)) {
                        pendingUpdates.push({
                            internalId: entry.internalId,
                            gamepadId: entry.gamepadId,
                            timestamp: gamepad.timestamp ?? 0,
                            state: { ...state }
                        })
                        this.previousStates[entry.internalId] = { ...state }
                    }
                }
            } catch (e) {
                console.error("[Input]: Error processing gamepad update", e)
            }
        }

        if (pendingUpdates.length === 0) return

        // Tesla browser can expose mirrored gamepads for one physical press.
        // Prefer non-virtual pads and suppress mirrored virtual duplicates per poll.
        pendingUpdates.sort((a, b) => Number(this.isTeslaVirtualGamepadId(a.gamepadId)) - Number(this.isTeslaVirtualGamepadId(b.gamepadId)))

        const sentBySignature = new Map<string, { gamepadId: string; timestamp: number }>()
        for (const update of pendingUpdates) {
            let suppress = false
            if (!this.isNeutralGamepadState(update.state)) {
                const signature = this.buildGamepadStateSignature(update.state)
                const previous = sentBySignature.get(signature)
                if (previous) {
                    const currentIsVirtual = this.isTeslaVirtualGamepadId(update.gamepadId)
                    const previousIsVirtual = this.isTeslaVirtualGamepadId(previous.gamepadId)
                    const closeInTime = Math.abs(previous.timestamp - update.timestamp) <= 4
                    if (closeInTime && currentIsVirtual && !previousIsVirtual) {
                        suppress = true
                    }
                }
                if (!suppress) {
                    sentBySignature.set(signature, { gamepadId: update.gamepadId, timestamp: update.timestamp })
                }
            }

            if (!suppress) {
                this.sendController(update.internalId, update.state)
            }
        }
    }

    private readonly EPSILON = 0.001 // Tolerans. Ändringar mindre än 0.1% ignoreras.

    private isTeslaVirtualGamepadId(gamepadId: string): boolean {
        return /TESLA\s+VIRTUAL\s+GAMEPAD/i.test(gamepadId)
    }

    private buildGamepadStateSignature(state: GamepadState): string {
        // Quantize analog values to avoid noise while detecting mirrored states.
        const q = (value: number) => Math.round(value * 1000)
        return `${state.buttonFlags}|${q(state.leftTrigger)}|${q(state.rightTrigger)}|${q(state.leftStickX)}|${q(state.leftStickY)}|${q(state.rightStickX)}|${q(state.rightStickY)}`
    }

    private isNeutralGamepadState(state: GamepadState): boolean {
        return state.buttonFlags === 0
            && Math.abs(state.leftTrigger) < this.EPSILON
            && Math.abs(state.rightTrigger) < this.EPSILON
            && Math.abs(state.leftStickX) < this.EPSILON
            && Math.abs(state.leftStickY) < this.EPSILON
            && Math.abs(state.rightStickX) < this.EPSILON
            && Math.abs(state.rightStickY) < this.EPSILON
    }

    private areGamepadStatesEqual(state1: GamepadState, state2: GamepadState): boolean {
        if (state1.buttonFlags !== state2.buttonFlags) {
            return false;
        }

        const compareFloats = (f1: number, f2: number): boolean => {
            return Math.abs(f1 - f2) < this.EPSILON;
        };

        if (!compareFloats(state1.leftTrigger, state2.leftTrigger)) return false;
        if (!compareFloats(state1.rightTrigger, state2.rightTrigger)) return false;
        if (!compareFloats(state1.leftStickX, state2.leftStickX)) return false;
        if (!compareFloats(state1.leftStickY, state2.leftStickY)) return false;
        if (!compareFloats(state1.rightStickX, state2.rightStickX)) return false;
        if (!compareFloats(state1.rightStickY, state2.rightStickY)) return false;

        return true;
    }

    private getGamepadIndex(internalId: number): number | undefined {
        for (const [index, entry] of this.gamepads.entries()) {
            if (entry.internalId === internalId) {
                return index
            }
        }
        return undefined
    }

    private onControllerMessage(event: MessageEvent) {
        // Rumble messages from the host are ignored on Tesla — the Bluetooth HID
        // playEffect() API causes main-thread stalls that produce video micro-stutter.
        // Messages are silently consumed to avoid errors.
    }

    // -- Controller Sending
    sendControllerAdd(id: number, supportedButtons: number, capabilities: number) {
        this.buffer.reset()

        this.buffer.putU8(0)
        this.buffer.putU8(id)
        this.buffer.putU32(supportedButtons)
        this.buffer.putU16(capabilities)

        trySendChannel(this.controllers, this.buffer)
    }
    sendControllerRemove(id: number) {
        this.buffer.reset()

        this.buffer.putU8(1)
        this.buffer.putU8(id)

        trySendChannel(this.controllers, this.buffer)
    }
    // Values
    // - Trigger: range 0..1
    // - Stick: range -1..1
    sendController(id: number, state: GamepadState) {
        this.buffer.reset()

        this.buffer.putU8(0)
        this.buffer.putU32(state.buttonFlags)
        this.buffer.putU8(Math.max(0.0, Math.min(1.0, state.leftTrigger)) * U8_MAX)
        this.buffer.putU8(Math.max(0.0, Math.min(1.0, state.rightTrigger)) * U8_MAX)
        this.buffer.putI16(Math.max(-1.0, Math.min(1.0, state.leftStickX)) * I16_MAX)
        this.buffer.putI16(Math.max(-1.0, Math.min(1.0, -state.leftStickY)) * I16_MAX)
        this.buffer.putI16(Math.max(-1.0, Math.min(1.0, state.rightStickX)) * I16_MAX)
        this.buffer.putI16(Math.max(-1.0, Math.min(1.0, -state.rightStickY)) * I16_MAX)

        this.tryOpenControllerChannel(id)
        trySendChannel(this.controllerInputs[id], this.buffer)
    }
    private tryOpenControllerChannel(id: number) {
        if (!this.controllerInputs[id]) {
            this.controllerInputs[id] = this.peer?.createDataChannel(`controller${id}`, {
                maxRetransmits: 0,
                ordered: false,
            }) ?? null
        }
    }

}