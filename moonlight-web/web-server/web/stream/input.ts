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

const CONTROLLER_RUMBLE_INTERVAL_MS = 60

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
        const now = performance.now()
        this.debugLogs.push({ time: now, message })
        if (this.debugLogs.length > this.maxDebugLogs) {
            this.debugLogs.shift()
        }
        console.log(`[DebugLog] ${message}`)
    }

    getDebugLogs(): Array<string> {
        return this.debugLogs.map((log, i) => `${(log.time / 1000).toFixed(2)}s [${i}] ${log.message}`)
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
        if (this.config.mouseScrollMode == "highres") {
            this.sendMouseWheelHighRes(event.deltaX, -event.deltaY)
        } else if (this.config.mouseScrollMode == "normal") {
            this.sendMouseWheel(event.deltaX, -event.deltaY)
        }
    }

    sendMouseMove(movementX: number, movementY: number) {
        this.buffer.reset()

        this.buffer.putU8(0)
        this.buffer.putI16(movementX)
        this.buffer.putI16(movementY)

        trySendChannel(this.mouseRelative, this.buffer)
    }
    sendMouseMoveClientCoordinates(movementX: number, movementY: number, rect: DOMRect) {
        const scaledMovementX = movementX / rect.width * this.streamerSize[0];
        const scaledMovementY = movementY / rect.height * this.streamerSize[1];

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
                        this.sendMouseWheelHighRes(-movementX * TOUCH_HIGH_RES_SCROLL_MULTIPLIER, movementY * TOUCH_HIGH_RES_SCROLL_MULTIPLIER)
                    } else if (this.config.mouseScrollMode == "normal") {
                        this.sendMouseWheel(-movementX * TOUCH_SCROLL_MULTIPLIER, movementY * TOUCH_SCROLL_MULTIPLIER)
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

                    if (this.touchMouseAction == "default") {
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
    }

    onTouchCancel(event: TouchEvent, rect: DOMRect) {
        this.onTouchEnd(event, rect)
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
    }

    private collectActuators(gamepad: Gamepad): Array<GamepadHapticActuator> {
        const actuators = []
        if ("vibrationActuator" in gamepad && gamepad.vibrationActuator) {
            actuators.push(gamepad.vibrationActuator)
        }
        if ("hapticActuators" in gamepad && gamepad.hapticActuators) {
            const hapticActuators = gamepad.hapticActuators as Array<GamepadHapticActuator>
            actuators.push(...hapticActuators)
        }
        return actuators
    }

    private gamepads: Map<number, { internalId: number; gamepadId: string; vendorId: string | null; isVirtual: boolean }> = new Map() // Maps gamepad.index to metadata
    private pendingGamepads: Map<number, { gamepadId: string; vendorId: string | null; isVirtual: boolean; connectedAt: number }> = new Map()
    private gamepadRumbleInterval: number | null = null

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

        if (this.gamepadRumbleInterval == null) {
            this.gamepadRumbleInterval = window.setInterval(this.onGamepadRumbleInterval.bind(this), CONTROLLER_RUMBLE_INTERVAL_MS - 10)
        }

        this.gamepadRumbleCurrent[id] = { lowFrequencyMotor: 0, highFrequencyMotor: 0, leftTrigger: 0, rightTrigger: 0 }

        let capabilities = 0
        for (const actuator of this.collectActuators(gamepad)) {
            if ("effects" in actuator) {
                const supportedEffects = actuator.effects as Array<string>
                for (const effect of supportedEffects) {
                    if (effect == "dual-rumble") {
                        capabilities = StreamControllerCapabilities.CAPABILITY_RUMBLE
                    } else if (effect == "trigger-rumble") {
                        capabilities = StreamControllerCapabilities.CAPABILITY_TRIGGER_RUMBLE
                    }
                }
            } else if ("type" in actuator && (actuator.type == "vibration" || actuator.type == "dual-rumble")) {
                capabilities = StreamControllerCapabilities.CAPABILITY_RUMBLE
            } else if ("playEffect" in actuator && typeof actuator.playEffect == "function") {
                capabilities = StreamControllerCapabilities.CAPABILITY_RUMBLE | StreamControllerCapabilities.CAPABILITY_TRIGGER_RUMBLE
            } else if ("pulse" in actuator && typeof actuator.pulse == "function") {
                capabilities = StreamControllerCapabilities.CAPABILITY_RUMBLE
            }
        }

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

        const activePending: Array<{ index: number; gamepad: Gamepad; vendorId: string | null; isVirtual: boolean; state: GamepadState }> = []

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
                state: { ...state }
            })
        }

        if (activePending.length === 0) {
            return
        }

        // Group by state signature to detect mirrors among pending controllers.
        // Tesla mirrors input to all connected controllers, so multiple pending
        // controllers with the same state in the same frame are mirrors.
        // Only promote one per unique state (prefer physical over virtual).
        const promotedSignatures = new Set<string>()
        activePending.sort((a, b) => Number(a.isVirtual) - Number(b.isVirtual))
        for (const candidate of activePending) {
            const sig = this.buildGamepadStateSignature(candidate.state)
            if (promotedSignatures.has(sig)) {
                this.addDebugLog(`Skipping mirrored pending controller: "${candidate.gamepad.id}" at index ${candidate.index} (same state as already promoted)`)
                continue // Keep in pending - may produce independent input later
            }

            this.registerGamepad(candidate.gamepad, candidate.vendorId, candidate.isVirtual)
            promotedSignatures.add(sig)
        }
    }

    onGamepadConnect(gamepad: Gamepad) {
        if (!this.connected) {
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
        this.pendingGamepads.set(gamepad.index, {
            gamepadId: gamepad.id,
            vendorId,
            isVirtual,
            connectedAt: performance.now()
        })
        this.addDebugLog(`Queued gamepad pending activation at index ${gamepad.index}: ${gamepad.id}`)
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
        this.processPendingGamepads(gamepads)
        if (this.gamepads.size === 0) return
        const pendingUpdates: Array<{
            internalId: number
            gamepadId: string
            timestamp: number
            state: GamepadState
        }> = []
        
        if (this.gamepads.size === 0) return
        
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
        if (!(event.data instanceof ArrayBuffer)) {
            return
        }
        const buffer = new ByteBuffer(new Uint8Array(event.data))

        const ty = buffer.getU8()
        if (ty == 0) {
            // Rumble
            const id = buffer.getU8()
            const lowFrequencyMotor = buffer.getU16() / U16_MAX
            const highFrequencyMotor = buffer.getU16() / U16_MAX

            const gamepadIndex = this.getGamepadIndex(id)
            if (gamepadIndex == undefined) {
                return
            }

            this.setGamepadEffect(id, "dual-rumble", { lowFrequencyMotor, highFrequencyMotor })
        } else if (ty == 1) {
            // Trigger Rumble
            const id = buffer.getU8()
            const leftTrigger = buffer.getU16() / U16_MAX
            const rightTrigger = buffer.getU16() / U16_MAX

            const gamepadIndex = this.getGamepadIndex(id)
            if (gamepadIndex == undefined) {
                return
            }

            this.setGamepadEffect(id, "trigger-rumble", { leftTrigger, rightTrigger })
        }
    }

    // -- Controller rumble
    private gamepadRumbleCurrent: Array<{
        lowFrequencyMotor: number, highFrequencyMotor: number,
        leftTrigger: number, rightTrigger: number
    }> = []

    private setGamepadEffect(id: number, ty: "dual-rumble", params: { lowFrequencyMotor: number, highFrequencyMotor: number }): void
    private setGamepadEffect(id: number, ty: "trigger-rumble", params: { leftTrigger: number, rightTrigger: number }): void

    private setGamepadEffect(id: number, _ty: "dual-rumble" | "trigger-rumble", params: { lowFrequencyMotor: number, highFrequencyMotor: number } | { leftTrigger: number, rightTrigger: number }) {
        const rumble = this.gamepadRumbleCurrent[id]

        Object.assign(rumble, params)
    }

    private onGamepadRumbleInterval() {
        for (const [index, entry] of this.gamepads.entries()) {
            const rumble = this.gamepadRumbleCurrent[entry.internalId]
            const gamepad = navigator.getGamepads()[index]
            if (gamepad && rumble) {
                this.refreshGamepadRumble(rumble, gamepad)
            }
        }
    }
    private refreshGamepadRumble(
        rumble: {
            lowFrequencyMotor: number, highFrequencyMotor: number,
            leftTrigger: number, rightTrigger: number
        },
        gamepad: Gamepad
    ) {
        // Browsers are making this more complicated than it is

        const actuators = this.collectActuators(gamepad)

        for (const actuator of actuators) {
            if ("effects" in actuator) {
                const supportedEffects = actuator.effects as Array<string>

                for (const effect of supportedEffects) {
                    if (effect == "dual-rumble") {
                        actuator.playEffect("dual-rumble", {
                            duration: CONTROLLER_RUMBLE_INTERVAL_MS,
                            weakMagnitude: rumble.lowFrequencyMotor,
                            strongMagnitude: rumble.highFrequencyMotor
                        }).catch(() => {})
                    } else if (effect == "trigger-rumble") {
                        actuator.playEffect("trigger-rumble", {
                            duration: CONTROLLER_RUMBLE_INTERVAL_MS,
                            leftTrigger: rumble.leftTrigger,
                            rightTrigger: rumble.rightTrigger
                        }).catch(() => {})
                    }
                }
            } else if ("type" in actuator && (actuator.type == "vibration" || actuator.type == "dual-rumble")) {
                actuator.playEffect(actuator.type as any, {
                    duration: CONTROLLER_RUMBLE_INTERVAL_MS,
                    weakMagnitude: rumble.lowFrequencyMotor,
                    strongMagnitude: rumble.highFrequencyMotor
                }).catch(() => {})
            } else if ("playEffect" in actuator && typeof actuator.playEffect == "function") {
                actuator.playEffect("dual-rumble", {
                    duration: CONTROLLER_RUMBLE_INTERVAL_MS,
                    weakMagnitude: rumble.lowFrequencyMotor,
                    strongMagnitude: rumble.highFrequencyMotor
                }).catch(() => {})
                actuator.playEffect("trigger-rumble", {
                    duration: CONTROLLER_RUMBLE_INTERVAL_MS,
                    leftTrigger: rumble.leftTrigger,
                    rightTrigger: rumble.rightTrigger
                }).catch(() => {})
            } else if ("pulse" in actuator && typeof actuator.pulse == "function") {
                const weak = Math.min(Math.max(rumble.lowFrequencyMotor, 0), 1);
                const strong = Math.min(Math.max(rumble.highFrequencyMotor, 0), 1);

                const average = (weak + strong) / 2.0

                const promise = actuator.pulse(average, CONTROLLER_RUMBLE_INTERVAL_MS)
                if (promise && typeof promise.catch == "function") {
                    promise.catch(() => {})
                }
            }
        }
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