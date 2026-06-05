import "./polyfill/index.js"
import { Api, getApi, logout } from "./api.js";
import { Component } from "./component/index.js";
import { showErrorPopup } from "./component/error.js";
import { getStreamerSize, InfoEvent, Stream } from "./stream/index.js"
import { getModalBackground, Modal, showMessage, showModal } from "./component/modal/index.js";
import { getSidebarRoot, setSidebar, setSidebarExtended, setSidebarStyle, Sidebar } from "./component/sidebar/index.js";
import { defaultStreamInputConfig, MouseMode, ScreenKeyboardSetVisibleEvent, StreamInputConfig } from "./stream/input.js";
import { defaultStreamSettings, getLocalStreamSettings, StreamSettings } from "./component/settings_menu.js";
import { SelectComponent } from "./component/input.js";
import { getStandardVideoFormats, getSupportedVideoFormats } from "./stream/video.js";
import { CanvasRenderer } from "./stream/canvas.js";
import { StreamCapabilities, StreamKeys } from "./api_bindings.js";
import { getTeslaVirtualSwapOverride, setTeslaVirtualSwapOverride } from "./stream/gamepad.js";
import { KeyboardModeEvent, ScreenKeyboard, TextEvent } from "./screen_keyboard.js";
import { requestKeyboardLock } from "./iframe.js";
import { FormModal } from "./component/modal/form.js";
import { StreamStatsOverlay } from "./component/stream_stats.js";

function getBuildVersionTag(): string {
    try {
        const url = new URL(import.meta.url)
        const version = url.searchParams.get("v")
        return version ?? "dev"
    } catch {
        return "unknown"
    }
}

async function startApp() {
    const api = await getApi()

    const rootElement = document.getElementById("root");
    if (rootElement == null) {
        showErrorPopup("couldn't find root element", true)
        return;
    }

    // Get Host and App via Query
    const queryParams = new URLSearchParams(location.search)

    const hostIdStr = queryParams.get("hostId")
    const appIdStr = queryParams.get("appId")
    if (hostIdStr == null || appIdStr == null) {
        await showMessage("No Host or no App Id found")

        window.close()
        return
    }
    const hostId = Number.parseInt(hostIdStr)
    const appId = Number.parseInt(appIdStr)

    // event propagation on overlays
    const sidebarRoot = getSidebarRoot()
    if (sidebarRoot) {
        stopPropagationOn(sidebarRoot)
    }

    const modalBackground = getModalBackground()
    if (modalBackground) {
        stopPropagationOn(modalBackground)
    }

    // Start and Mount App
    const app = new ViewerApp(api, hostId, appId)
    app.mount(rootElement)
}

// Prevent starting transition
window.requestAnimationFrame(() => {
    // Note: elements is a live array
    const elements = document.getElementsByClassName("prevent-start-transition")
    while (elements.length > 0) {
        elements.item(0)?.classList.remove("prevent-start-transition")
    }
})

startApp()

class ViewerApp implements Component {
    private api: Api

    private sidebar: ViewerSidebar

    private div = document.createElement("div")
    private videoElement = document.createElement("video")
    private canvasElement = document.createElement("canvas")

    private stream: Stream | null = null

    private canvasRenderer: CanvasRenderer | null = null
    private settings: StreamSettings
    private statsOverlay: StreamStatsOverlay

    private streamerSize: [number, number]

    private inputConfig: StreamInputConfig = defaultStreamInputConfig()
    private previousMouseMode: MouseMode
    private toggleFullscreenWithKeybind: boolean
    private hasShownFullscreenEscapeWarning = false
    
    private wakeLock: WakeLockSentinel | null = null
    private hasInteracted = false
    private cachedStreamRect: DOMRect | null = null
    private pollRafId: number | null = null
    private pollTimerId: ReturnType<typeof setTimeout> | null = null
    private pollLoopRunning: boolean = false
    private gamepadPollToggle: boolean = false  // poll gamepads at 30Hz (every other frame)

    constructor(api: Api, hostId: number, appId: number) {
        this.api = api

        // Bind update loops
        this.onTouchUpdate = this.onTouchUpdate.bind(this)
        this.onGamepadUpdate = this.onGamepadUpdate.bind(this)

        // Configure sidebar
        this.sidebar = new ViewerSidebar(this)
        setSidebar(this.sidebar)

        // Configure stream
        const settings = getLocalStreamSettings() ?? defaultStreamSettings()

        let browserWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0)
        let browserHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0)

        this.previousMouseMode = this.inputConfig.mouseMode
        this.toggleFullscreenWithKeybind = settings.toggleFullscreenWithKeybind

        // Create stats overlay early (before startStream which uses it async)
        this.statsOverlay = new StreamStatsOverlay()

        this.startStream(hostId, appId, settings, [browserWidth, browserHeight])

        this.streamerSize = getStreamerSize(settings, [browserWidth, browserHeight])

        this.settings = settings

        // Configure video element
        this.videoElement.classList.add("video-stream")
        this.videoElement.preload = "none"
        this.videoElement.controls = false
        this.videoElement.autoplay = true
        this.videoElement.disablePictureInPicture = true
        this.videoElement.playsInline = true
        this.videoElement.muted = true

        // Apply stretch-to-fit for video element mode
        if(!this.settings.canvasRenderer && this.settings.stretchToFit) {
            this.videoElement.classList.add("video-stream-stretched")
        }

        // Configure canvas element
        if(this.settings.canvasRenderer) {
            this.canvasElement.classList.add("video-stream")
            this.div.appendChild(this.canvasElement)
            this.canvasRenderer = new CanvasRenderer(this.canvasElement, settings.stretchToFit, settings.useVideoWorker)
            this.videoElement.autoplay = false
        }

        this.div.appendChild(this.videoElement)

        // Configure stats overlay
        this.statsOverlay.mount(this.div)
        if (!settings.showStreamStats) {
            this.statsOverlay.hide()
        }

        // Configure input
        this.addListeners(document)
        this.addListeners(document.getElementById("input") as HTMLDivElement)

        document.addEventListener("pointerlockchange", this.onPointerLockChange.bind(this))
        document.addEventListener("fullscreenchange", this.onFullscreenChange.bind(this))

        // Invalidate cached stream rect on resize
        window.addEventListener("resize", () => { this.cachedStreamRect = null })
        // Also invalidate when the video element itself resizes (e.g. when the video
        // stream starts and its intrinsic dimensions become known, causing the element
        // to reflow from its initial min-width/min-height square into the correct ratio)
        new ResizeObserver(() => { this.cachedStreamRect = null }).observe(this.videoElement)

        window.addEventListener("gamepadconnected", this.onGamepadConnect.bind(this))
        window.addEventListener("gamepaddisconnected", this.onGamepadDisconnect.bind(this))
        // Connect all gamepads
        for (const gamepad of navigator.getGamepads()) {
            if (gamepad != null) {
                this.onGamepadAdd(gamepad)
            }
        }
    }
    private addListeners(element: GlobalEventHandlers) {
        element.addEventListener("keydown", this.onKeyDown.bind(this), { passive: false })
        element.addEventListener("keyup", this.onKeyUp.bind(this), { passive: false })
        element.addEventListener("paste", this.onPaste.bind(this) as any)

        element.addEventListener("mousedown", this.onMouseButtonDown.bind(this), { passive: false })
        element.addEventListener("mouseup", this.onMouseButtonUp.bind(this), { passive: false })
        element.addEventListener("mousemove", this.onMouseMove.bind(this), { passive: false })
        element.addEventListener("wheel", this.onMouseWheel.bind(this), { passive: false })
        element.addEventListener("contextmenu", this.onContextMenu.bind(this), { passive: false })

        element.addEventListener("touchstart", this.onTouchStart.bind(this), { passive: false })
        element.addEventListener("touchend", this.onTouchEnd.bind(this), { passive: false })
        element.addEventListener("touchcancel", this.onTouchCancel.bind(this), { passive: false })
        element.addEventListener("touchmove", this.onTouchMove.bind(this), { passive: false })
    }

    private async startStream(hostId: number, appId: number, settings: StreamSettings, browserSize: [number, number]) {
        setSidebarStyle({
            edge: settings.sidebarEdge,
        })

        let supportedVideoFormats = getStandardVideoFormats()
        if (settings.dontForceH264) {
            supportedVideoFormats = await getSupportedVideoFormats()
        }

        this.stream = new Stream(this.api, hostId, appId, settings, supportedVideoFormats, browserSize)

        // Wire stats overlay to WebRTC peer (lazily resolved since peer is created async)
        this.statsOverlay.setPeerGetter(() => this.stream?.getPeer() ?? null)
        this.statsOverlay.setStreamGetter(() => this.stream)
        this.statsOverlay.setWorkerDiagnosticsGetter(() => this.getWorkerDiagnostics())
        this.statsOverlay.setStatsEnabledCallback((enabled) => {
            this.stream?.setStatsEnabled(enabled)
            this.canvasRenderer?.setStatsEnabled(enabled)
        })
        if (settings.showStreamStats) {
            this.statsOverlay.show()
        }

        // Add app info listener
        this.stream.addInfoListener(this.onInfo.bind(this))

        // Create connection info modal
        const connectionInfo = new ConnectionInfoModal()
        this.stream.addInfoListener(connectionInfo.onInfo.bind(connectionInfo))
        showModal(connectionInfo)

        // Set video
        if(!settings?.canvasRenderer) {
            this.videoElement.srcObject = this.stream.getMediaStream()
        }

        this.ensurePollLoopRunning()

        this.stream.getInput().addScreenKeyboardVisibleEvent(this.onScreenKeyboardSetVisible.bind(this))
        
        this.requestWakeLock();
    }
    
    private async requestWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                this.wakeLock = await navigator.wakeLock.request('screen');
                this.wakeLock.addEventListener('release', () => {
                    console.log('Wake Lock was released');
                    // Re-acquire wake lock if it was released (e.g. tab switch)
                    // unless we are navigating away (not handled here but implicit)
                });
                console.log('Wake Lock is active');
            } catch (err) {
                console.error(`Wake Lock failed: ${err}`);
            }
        }
    }

    private async onInfo(event: InfoEvent) {
        const data = event.detail

        if (data.type == "app") {
            const app = data.app

            document.title = `Stream: ${app.title}`
        } else if (data.type == "connectionComplete") {
            this.sidebar.onCapabilitiesChange(data.capabilities)
        } else if (data.type == "videoTrack") {
            if (this.canvasRenderer) {
                this.canvasRenderer.setVideoTrack(data.track)
            }
        }
    }

    private focusInput() {
        const inputElement = document.getElementById("input") as HTMLDivElement
        inputElement.focus()
    }

    onUserInteraction() {
        this.stream?.resumeAudio();
        
        if (this.hasInteracted) return
        this.hasInteracted = true

        this.focusInput()

        if (this.videoElement) {
            this.videoElement.muted = false
            if(this.videoElement.paused) {
                this.videoElement.play().then(() => {
                    // Playing
                }).catch(error => {
                    console.error(`Failed to play videoElement: ${error.message || error}`);
                })
            }
        }
    }
    private onScreenKeyboardSetVisible(event: ScreenKeyboardSetVisibleEvent) {
        console.info(event.detail)
        const screenKeyboard = this.sidebar.getScreenKeyboard()

        const newShown = event.detail.visible
        if (newShown != screenKeyboard.isVisible()) {
            if (newShown) {
                screenKeyboard.show()
            } else {
                screenKeyboard.hide()
            }
        }
    }

    // Input
    getInputConfig(): StreamInputConfig {
        return this.inputConfig
    }
    setInputConfig(config: StreamInputConfig) {
        Object.assign(this.inputConfig, config)

        this.stream?.getInput().setConfig(this.inputConfig)
    }

    getStreamInput() {
        return this.stream?.getInput() ?? null
    }

    getWorkerDiagnostics() {
        return {
            stream: this.stream?.getWorkerDiagnostics() ?? null,
            canvas: this.canvasRenderer?.getWorkerDiagnostics() ?? null,
            canvasRendererEnabled: this.settings.canvasRenderer,
            workersAllowedBySettings: this.settings.useVideoWorker,
        }
    }

    // Keyboard
    onKeyDown(event: KeyboardEvent) {
        this.onUserInteraction()

        if (event.ctrlKey && event.code == "KeyV") {
            // We are likely pasting -> don't send keys
        } else if (event.code == "F11") {
            // Allow manual fullscreen
        } else {
            event.preventDefault()
            this.stream?.getInput().onKeyDown(event)
        }

        event.stopPropagation()
    }

    private isTogglingFullscreenWithKeybind: "waitForCtrl" | "makingFullscreen" | "none" = "none"
    onKeyUp(event: KeyboardEvent) {
        this.onUserInteraction()

        event.preventDefault()
        this.stream?.getInput().onKeyUp(event)
        event.stopPropagation()

        if (this.toggleFullscreenWithKeybind && this.isTogglingFullscreenWithKeybind == "none" && event.ctrlKey && event.shiftKey && event.code == "KeyI") {
            this.isTogglingFullscreenWithKeybind = "waitForCtrl"
        }
        if (this.isTogglingFullscreenWithKeybind == "waitForCtrl" && (event.code == "ControlRight" || event.code == "ControlLeft")) {
            this.isTogglingFullscreenWithKeybind = "makingFullscreen";

            (async () => {
                if (this.isFullscreen()) {
                    await this.exitPointerLock()
                    await this.exitFullscreen()
                } else {
                    await this.requestFullscreen()
                    await this.requestPointerLock()
                }

                this.isTogglingFullscreenWithKeybind = "none"
            })()
        }
    }

    onPaste(event: ClipboardEvent) {
        this.onUserInteraction()

        this.stream?.getInput().onPaste(event)

        event.stopPropagation()
    }

    // Mouse
    onMouseButtonDown(event: MouseEvent) {
        this.onUserInteraction()

        event.preventDefault()
        this.stream?.getInput().onMouseDown(event, this.getStreamRect());

        event.stopPropagation()
    }
    onMouseButtonUp(event: MouseEvent) {
        this.onUserInteraction()

        event.preventDefault()
        this.stream?.getInput().onMouseUp(event)

        event.stopPropagation()
    }
    onMouseMove(event: MouseEvent) {
        event.preventDefault()
        this.stream?.getInput().onMouseMove(event, this.getStreamRect())

        event.stopPropagation()
    }
    onMouseWheel(event: WheelEvent) {
        event.preventDefault()
        this.stream?.getInput().onMouseWheel(event)

        event.stopPropagation()
    }
    onContextMenu(event: MouseEvent) {
        event.preventDefault()

        event.stopPropagation()
    }

    // Touch
    onTouchStart(event: TouchEvent) {
        this.onUserInteraction()

        event.preventDefault()
        this.stream?.getInput().onTouchStart(event, this.getStreamRect())
        this.ensurePollLoopRunning()

        event.stopPropagation()
    }
    onTouchEnd(event: TouchEvent) {
        this.onUserInteraction()

        event.preventDefault()
        this.stream?.getInput().onTouchEnd(event, this.getStreamRect())
        this.ensurePollLoopRunning()

        event.stopPropagation()
    }
    onTouchCancel(event: TouchEvent) {
        this.onUserInteraction()

        event?.preventDefault()
        this.stream?.getInput().onTouchCancel(event, this.getStreamRect())
        this.ensurePollLoopRunning()

        event.stopPropagation()
    }
    onTouchUpdate() {
        this.stream?.getInput().onTouchUpdate(this.getStreamRect())
    }
    onTouchMove(event: TouchEvent) {
        event.preventDefault()
        this.stream?.getInput().onTouchMove(event, this.getStreamRect())

        event.stopPropagation()
    }

    // Gamepad
    onGamepadConnect(event: GamepadEvent) {
        this.onGamepadAdd(event.gamepad)
    }
    onGamepadAdd(gamepad: Gamepad) {
        this.stream?.getInput().onGamepadConnect(gamepad)
        this.ensurePollLoopRunning()
    }
    onGamepadDisconnect(event: GamepadEvent) {
        this.stream?.getInput().onGamepadDisconnect(event)
        this.ensurePollLoopRunning()
    }
    onGamepadUpdate() {
        this.stream?.getInput().onGamepadUpdate()
    }

    private shouldPollInputs(): boolean {
        const input = this.stream?.getInput()
        if (!input) return false
        return input.hasPrimaryTouch() || input.hasGamepads()
    }

    private ensurePollLoopRunning() {
        if (this.pollLoopRunning || !this.shouldPollInputs()) {
            return
        }

        this.pollLoopRunning = true
        const pollLoop = () => {
            const input = this.stream?.getInput()
            if (!input) {
                this.pollLoopRunning = false
                this.pollRafId = null
                this.pollTimerId = null
                return
            }

            const hasPrimaryTouch = input.hasPrimaryTouch()

            if (hasPrimaryTouch) {
                this.onTouchUpdate()
            }

            // Poll gamepads at 30Hz (every other rAF). navigator.getGamepads()
            // is expensive on Tesla (~100μs+ per call due to object allocation).
            // 33ms input latency is imperceptible for controller input.
            this.gamepadPollToggle = !this.gamepadPollToggle
            if (this.gamepadPollToggle && input.hasGamepads()) {
                this.onGamepadUpdate()
            }

            if (!this.shouldPollInputs()) {
                this.pollLoopRunning = false
                this.pollRafId = null
                this.pollTimerId = null
                return
            }

            // Always use rAF for both touch and gamepad polling.
            // This syncs input sampling with the display refresh (~16.6ms at 60Hz),
            // reducing input latency from 50ms to ~16ms for gamepads while keeping
            // touch tracking smooth. navigator.getGamepads() allocates a new array
            // each call but at 60Hz the GC pressure is negligible.
            this.pollRafId = requestAnimationFrame(pollLoop)
            this.pollTimerId = null
        }

        this.pollRafId = requestAnimationFrame(pollLoop)
        this.pollTimerId = null
    }

    // Fullscreen
    async requestFullscreen() {
        const body = document.body
        if (body) {
            if (!("requestFullscreen" in body && typeof body.requestFullscreen == "function")) {
                await showMessage("Fullscreen is not supported by your browser!")

                return
            }

            this.focusInput()

            if (!this.isFullscreen()) {
                try {
                    await body.requestFullscreen({
                        navigationUI: "hide"
                    })
                } catch (e) {
                    console.warn("failed to request fullscreen", e)
                }
            }

            try {
                await requestKeyboardLock()

                if (!this.hasShownFullscreenEscapeWarning) {
                    await showMessage("To exit Fullscreen you'll have to hold ESC for a few seconds.")
                }
                this.hasShownFullscreenEscapeWarning = true
            } catch (e) {
                console.warn("Keyboard lock failed", e)
            }

            if (this.getStream()?.getInput().getConfig().mouseMode == "relative") {
                await this.requestPointerLock()
            }

            try {
                if (screen && "orientation" in screen) {
                    const orientation = screen.orientation

                    if ("lock" in orientation && typeof orientation.lock == "function") {
                        await orientation.lock("landscape")
                    }
                }
            } catch (e) {
                console.warn("failed to set orientation to landscape", e)
            }
        } else {
            console.warn("root element not found")
        }
    }
    async exitFullscreen() {
        if ("keyboard" in navigator && navigator.keyboard && "unlock" in navigator.keyboard) {
            await navigator.keyboard.unlock()
        }

        if ("exitFullscreen" in document && typeof document.exitFullscreen == "function") {
            await document.exitFullscreen()
        }
    }
    isFullscreen(): boolean {
        return "fullscreenElement" in document && !!document.fullscreenElement
    }
    toggleStats() {
        if (this.statsOverlay.isVisible()) {
            this.statsOverlay.hide()
        } else {
            this.statsOverlay.show()
        }
    }
    private async onFullscreenChange() {
        this.cachedStreamRect = null
        this.checkFullyImmersed()
    }

    // Pointer Lock
    async requestPointerLock(errorIfNotFound: boolean = false) {
        this.previousMouseMode = this.inputConfig.mouseMode

        const inputElement = document.getElementById("input") as HTMLDivElement

        if (inputElement && "requestPointerLock" in inputElement && typeof inputElement.requestPointerLock == "function") {
            this.focusInput()

            this.inputConfig.mouseMode = "relative"
            this.setInputConfig(this.inputConfig)

            setSidebarExtended(false)

            const onLockError = () => {
                document.removeEventListener("pointerlockerror", onLockError)

                // Fallback: try to request pointer lock without options
                inputElement.requestPointerLock()
            }

            document.addEventListener("pointerlockerror", onLockError, { once: true })

            try {
                let promise = inputElement.requestPointerLock({
                    unadjustedMovement: true
                })

                if (promise) {
                    await promise
                } else {
                    inputElement.requestPointerLock()
                }
            } catch (error) {
                // Some platforms do not support unadjusted movement. If you
                // would like PointerLock anyway, request again.
                if (error instanceof Error && error.name == "NotSupportedError") {
                    inputElement.requestPointerLock()
                } else {
                    throw error
                }
            } finally {
                document.removeEventListener("pointerlockerror", onLockError)
            }

        } else if (errorIfNotFound) {
            await showMessage("Pointer Lock not supported")
        }
    }
    async exitPointerLock() {
        if ("exitPointerLock" in document && typeof document.exitPointerLock == "function") {
            document.exitPointerLock()
        }
    }
    private onPointerLockChange() {
        this.checkFullyImmersed()

        if (!document.pointerLockElement) {
            this.inputConfig.mouseMode = this.previousMouseMode
            this.setInputConfig(this.inputConfig)
        }
    }

    // -- Fully immersed Fullscreen -> Fullscreen API + Pointer Lock
    private checkFullyImmersed() {
        if ("pointerLockElement" in document && document.pointerLockElement &&
            "fullscreenElement" in document && document.fullscreenElement) {
            // We're fully immersed -> remove sidebar
            setSidebar(null)
        } else {
            setSidebar(this.sidebar)
        }
    }


    mount(parent: HTMLElement): void {
        parent.appendChild(this.div)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.div)
    }

    getStreamRect(): DOMRect {
        if (this.cachedStreamRect) return this.cachedStreamRect

        // The bounding rect of the videoElement or canvasElement can be bigger than the actual video
        // -> We need to correct for this when sending positions, else positions are wrong

        const videoSize = this.stream?.getStreamerSize() ?? this.streamerSize
        const videoAspect = videoSize[0] / videoSize[1]

        if(!this.settings?.canvasRenderer) {
            const boundingRect = this.videoElement.getBoundingClientRect()

            if (this.settings?.stretchToFit) {
                // Stretched: the entire bounding rect is the input surface
                this.cachedStreamRect = boundingRect
                return this.cachedStreamRect
            }

            // Use the video element's actual intrinsic dimensions when available.
            // Before the video plays, videoWidth/videoHeight are 0 and the CSS box
            // is forced to min-width/min-height (potentially a square), which would
            // produce a wrong rect. Don't cache in that case.
            const intrinsicW = this.videoElement.videoWidth
            const intrinsicH = this.videoElement.videoHeight
            const effectiveSize: [number, number] = (intrinsicW > 0 && intrinsicH > 0)
                ? [intrinsicW, intrinsicH]
                : videoSize
            const effectiveAspect = effectiveSize[0] / effectiveSize[1]
            const boundingRectAspect = boundingRect.width / boundingRect.height

            let x = boundingRect.x
            let y = boundingRect.y
            let videoMultiplier
            if (boundingRectAspect > effectiveAspect) {
                // How much is the video scaled up
                videoMultiplier = boundingRect.height / effectiveSize[1]

                // Note: Both in boundingRect / page scale
                const boundingRectHalfWidth = boundingRect.width / 2
                const videoHalfWidth = effectiveSize[0] * videoMultiplier / 2

                x += boundingRectHalfWidth - videoHalfWidth
            } else {
                // Same as above but inverted
                videoMultiplier = boundingRect.width / effectiveSize[0]

                const boundingRectHalfHeight = boundingRect.height / 2
                const videoHalfHeight = effectiveSize[1] * videoMultiplier / 2

                y += boundingRectHalfHeight - videoHalfHeight
            }

            const rect = new DOMRect(
                x,
                y,
                effectiveSize[0] * videoMultiplier,
                effectiveSize[1] * videoMultiplier
            )
            // Only cache once we have real intrinsic dimensions; otherwise the video
            // element is still at its pre-load size and we'd cache a wrong rect.
            if (intrinsicW > 0) {
                this.cachedStreamRect = rect
            }
            return rect
        }
        else {
            const clientRect = this.canvasElement.getBoundingClientRect()
            
            const canvasCssWidth = this.canvasElement.clientWidth
            const canvasCssHeight = this.canvasElement.clientHeight

            const boundingRectAspect = canvasCssWidth / canvasCssHeight
            let x = clientRect.x
            let y = clientRect.y
            let width = canvasCssWidth
            let height = canvasCssHeight
            let videoMultiplier

            if (this.settings?.stretchToFit) {
                // If stretched, the input rect is simply the canvas's client rect
                this.cachedStreamRect = clientRect
                return this.cachedStreamRect
            } else if (boundingRectAspect > videoAspect) {
                // Canvas is wider than video aspect, video will be pillarboxed
                videoMultiplier = canvasCssHeight / videoSize[1]
                const videoRenderedWidth = videoSize[0] * videoMultiplier
                x += (canvasCssWidth - videoRenderedWidth) / 2 // Center horizontally
                width = videoRenderedWidth
            }
            else {
                // Canvas is taller than video aspect, video will be letterboxed
                videoMultiplier = canvasCssWidth / videoSize[0]
                const videoRenderedHeight = videoSize[1] * videoMultiplier
                y += (canvasCssHeight - videoRenderedHeight) / 2 // Center vertically
                height = videoRenderedHeight
            }
            this.cachedStreamRect = new DOMRect(x, y, width, height)
            return this.cachedStreamRect
        }
    }
    getElement(): HTMLElement {
        return !this.settings?.canvasRenderer ? this.videoElement : this.canvasElement
    }
    getStream(): Stream | null {
        return this.stream
    }

    setBrightness(value: number) {
        // value = 0 (no effect) to 1 (max shadow boost)
        // Gamma curve lifts dark pixels disproportionately; saturation compensation
        // counteracts the perceived colour washout caused by dynamic-range compression.
        if (!this.shadowBoostSvg) this.setupShadowBoostFilter()
        const exponent = 1 - value * 0.7  // 0 -> 1.0 (linear), 1 -> 0.3 (strong lift)
        for (const fn of this.shadowBoostFuncs) {
            fn.setAttribute('exponent', String(exponent))
        }
        // Saturation scales with boost: 0 -> 1.0, 1 -> 1.6
        const saturation = 1 + value * 0.6
        const filterStr = value === 0 ? '' : `url(#ml-shadow-filter) saturate(${saturation})`
        this.canvasElement.style.filter = filterStr
        this.videoElement.style.filter = filterStr
        try { localStorage.setItem('mlShadowBoost', String(value)) } catch (_) {}
    }

    private shadowBoostSvg: SVGSVGElement | null = null
    private shadowBoostFuncs: Element[] = []
    private setupShadowBoostFilter() {
        const ns = 'http://www.w3.org/2000/svg'
        const svg = document.createElementNS(ns, 'svg') as SVGSVGElement
        svg.style.cssText = 'display:none;position:absolute;'
        const filter = document.createElementNS(ns, 'filter')
        filter.id = 'ml-shadow-filter'
        filter.setAttribute('color-interpolation-filters', 'sRGB')
        const transfer = document.createElementNS(ns, 'feComponentTransfer')
        const funcs: Element[] = []
        for (const ch of ['R', 'G', 'B']) {
            const fn = document.createElementNS(ns, `feFunc${ch}`)
            fn.setAttribute('type', 'gamma')
            fn.setAttribute('amplitude', '1')
            fn.setAttribute('exponent', '1')
            fn.setAttribute('offset', '0')
            transfer.appendChild(fn)
            funcs.push(fn)
        }
        filter.appendChild(transfer)
        svg.appendChild(filter)
        document.body.appendChild(svg)
        this.shadowBoostSvg = svg
        this.shadowBoostFuncs = funcs
    }

    getBrightness(): number {
        try {
            const saved = localStorage.getItem('mlShadowBoost')
            if (saved !== null) {
                const v = parseFloat(saved)
                if (isFinite(v) && v >= 0 && v <= 1) return v
            }
        } catch (_) {}
        return 0
    }
}

class ConnectionInfoModal implements Modal<void> {

    private eventTarget = new EventTarget()

    private root = document.createElement("div")

    private text = document.createElement("p")

    private debugDetailButton = document.createElement("button")
    private debugDetailRetryButton = document.createElement("button")
    private authFailed = false
    private debugDetail = "" // We store this seperate because line breaks don't work when the element is not mounted on the dom
    private debugDetailDisplay = document.createElement("div")

    constructor() {
        this.root.classList.add("modal-video-connect")

        this.text.innerText = "Connecting"
        this.root.appendChild(this.text)

        this.debugDetailButton.innerText = "Show Logs"
        this.debugDetailButton.addEventListener("click", this.onDebugDetailClick.bind(this))
        this.root.appendChild(this.debugDetailButton)

        this.debugDetailRetryButton.innerText = "Retry"
        this.debugDetailRetryButton.style.display = "none"
        this.debugDetailRetryButton.addEventListener("click", this.onDebugDetailRetryClick.bind(this))
        this.root.appendChild(this.debugDetailRetryButton)

        this.debugDetailDisplay.classList.add("textlike")
        this.debugDetailDisplay.classList.add("modal-video-connect-debug")
    }

    private onDebugDetailClick() {
        let debugDetailCurrentlyShown = this.root.contains(this.debugDetailDisplay)

        if (debugDetailCurrentlyShown) {
            this.debugDetailButton.innerText = "Show Logs"
            this.root.removeChild(this.debugDetailDisplay)
        } else {
            this.debugDetailButton.innerText = "Hide Logs"
            this.root.appendChild(this.debugDetailDisplay)
            this.debugDetailDisplay.innerText = this.debugDetail
        }
    }

    private onDebugDetailRetryClick() {
        if (this.authFailed) {
            logout()
            window.location.href = window.location.origin + "/"
        } else {
            window.location.reload()
        }
    }

    private debugLog(line: string) {
        this.debugDetail += `${line}\n`
        this.debugDetailDisplay.innerText = this.debugDetail
        console.info(`[Stream]: ${line}`)
    }

    onInfo(event: InfoEvent) {
        const data = event.detail

        if (data.type == "stageStarting") {
            const text = `Server: Starting Stage: ${data.stage}`
            this.text.innerText = text
            this.debugLog(text)
        } else if (data.type == "stageComplete") {
            const text = `Server: Completed Stage: ${data.stage}`
            this.text.innerText = text
            this.debugLog(text)
        } else if (data.type == "stageFailed") {
            const text = `Server: Failed Stage: ${data.stage} with error ${data.errorCode}`
            this.debugLog(text)
            if (data.stage === "Authentication") {
                this.authFailed = true
                this.text.innerText = "Authentication failed. Please log in again."
                this.debugDetailRetryButton.innerText = "Login Again"
                this.debugDetailRetryButton.style.display = "inline-block"
                showModal(this)
            } else {
                this.text.innerText = text
            }
        } else if (data.type == "connectionComplete") {
            const text = `Connection Complete`
            this.text.innerText = text
            this.debugLog(text)

            this.eventTarget.dispatchEvent(new Event("ml-connected"))
        } else if (data.type == "addDebugLine") {
            this.debugLog(data.line)
        }
        // Reopen the modal cause we might already be closed at this point
        else if (data.type == "connectionTerminated") {
            const text = `Server: Connection Terminated with code ${data.errorCode}`
            this.text.innerText = text
            this.debugLog(text)
            this.debugDetailRetryButton.style.display = "inline-block"
            showModal(this)
        } else if (data.type == "error") {
            const text = `Server: Error: ${data.message}`
            this.text.innerText = text
            this.debugLog(text)
            this.debugDetailRetryButton.style.display = "inline-block"
            showModal(this)
        } else if (data.type == "connectionRecovered") {
            this.debugLog("Connection recovered")
            this.debugDetailRetryButton.style.display = "none"
            // Resolve the modal's onFinish promise to auto-dismiss
            this.eventTarget.dispatchEvent(new Event("ml-connected"))
        }
    }

    onFinish(abort: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            this.eventTarget.addEventListener("ml-connected", () => resolve(), { once: true, signal: abort })
        })
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.root)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.root)
    }
}

class ViewerSidebar implements Component, Sidebar {
    private app: ViewerApp
    private buildTag = getBuildVersionTag()

    private div = document.createElement("div")

    private buttonDiv = document.createElement("div")

    private sendKeycodeButton = document.createElement("button")

    private keyboardButton = document.createElement("button")
    private floatingKeyboardButton = document.createElement("button")
    private screenKeyboard = new ScreenKeyboard()

    private lockMouseButton = document.createElement("button")
    private fullscreenButton = document.createElement("button")
    private brightnessSlider = document.createElement("input")
    private brightnessLabel = document.createElement("label")

    private mouseMode: SelectComponent
    private touchMode: SelectComponent

    constructor(app: ViewerApp) {
        this.app = app

        // Configure divs
        this.div.classList.add("sidebar-stream")

        this.buttonDiv.classList.add("sidebar-stream-buttons")
        this.div.appendChild(this.buttonDiv)

        // Send keycode
        this.sendKeycodeButton.innerText = "Send Keycode"
        this.sendKeycodeButton.addEventListener("click", async () => {
            const key = await showModal(new SendKeycodeModal())

            if (key == null) {
                return
            }

            this.app.getStream()?.getInput().sendKey(true, key, 0)
            this.app.getStream()?.getInput().sendKey(false, key, 0)
        })
        this.buttonDiv.appendChild(this.sendKeycodeButton)

        // Pointer Lock
        this.lockMouseButton.innerText = "Lock Mouse"
        this.lockMouseButton.addEventListener("click", async () => {
            await this.app.requestPointerLock(true)
        })
        this.buttonDiv.appendChild(this.lockMouseButton)

        // Pop up keyboard
        this.keyboardButton.innerText = "Keyboard"
        this.keyboardButton.addEventListener("click", async () => {
            setSidebarExtended(false)
            this.screenKeyboard.show()
        })
        this.buttonDiv.appendChild(this.keyboardButton)

        this.floatingKeyboardButton.innerText = "\u2328\u00d7"
        this.floatingKeyboardButton.title = "Hide Keyboard"
        this.floatingKeyboardButton.style.cssText = "position:fixed;top:50%;right:12px;transform:translateY(-50%);width:44px;height:44px;z-index:1000;display:none;align-items:center;justify-content:center;border:1px solid rgba(100,200,255,0.6);border-radius:999px;background:rgba(0,0,0,0.55);color:white;font-size:18px;opacity:0.78;cursor:pointer;"
        const hideKeyboard = (event: Event) => {
            event.preventDefault()
            event.stopPropagation()
            this.screenKeyboard.hide()
            this.floatingKeyboardButton.style.display = "none"
        }
        this.floatingKeyboardButton.addEventListener("click", hideKeyboard)
        this.floatingKeyboardButton.addEventListener("touchend", hideKeyboard)

        this.screenKeyboard.addKeyDownListener(this.onKeyDown.bind(this))
        this.screenKeyboard.addKeyUpListener(this.onKeyUp.bind(this))
        this.screenKeyboard.addTextListener(this.onText.bind(this))
        this.screenKeyboard.addKeyboardModeListener(this.onKeyboardModeChange.bind(this))
        this.div.appendChild(this.screenKeyboard.getHiddenElement())


        // Fullscreen
        this.fullscreenButton.innerText = "Fullscreen"
        this.fullscreenButton.addEventListener("click", async () => {
            if (this.app.isFullscreen()) {
                await this.app.exitFullscreen()
            } else {
                await this.app.requestFullscreen()
            }
        })
        this.buttonDiv.appendChild(this.fullscreenButton)

        // Shadow Boost slider
        const initialBrightness = this.app.getBrightness()
        this.app.setBrightness(initialBrightness) // apply persisted value immediately

        const brightnessWrapper = document.createElement("div")
        brightnessWrapper.style.cssText = "display:flex;flex-direction:column;gap:4px;padding:4px 0;"

        const pct = Math.round(initialBrightness * 100)
        this.brightnessLabel.innerText = `Shadow Boost: ${pct === 0 ? 'Off' : pct + '%'}`
        this.brightnessLabel.style.cssText = "font-size:13px;color:#ccc;user-select:none;"

        this.brightnessSlider.type = "range"
        this.brightnessSlider.min = "0"
        this.brightnessSlider.max = "1"
        this.brightnessSlider.step = "0.05"
        this.brightnessSlider.value = String(initialBrightness)
        this.brightnessSlider.style.cssText = "width:100%;cursor:pointer;"
        this.brightnessSlider.addEventListener("input", () => {
            const v = parseFloat(this.brightnessSlider.value)
            const p = Math.round(v * 100)
            this.brightnessLabel.innerText = `Shadow Boost: ${p === 0 ? 'Off' : p + '%'}`
            this.app.setBrightness(v)
        })

        brightnessWrapper.appendChild(this.brightnessLabel)
        brightnessWrapper.appendChild(this.brightnessSlider)
        this.buttonDiv.appendChild(brightnessWrapper)

        // Toggle Stats
        const statsButton = document.createElement("button")
        statsButton.innerText = "Toggle Stats"
        statsButton.addEventListener("click", () => {
            this.app.toggleStats()
        })
        this.buttonDiv.appendChild(statsButton)

        const debugGamepadsButton = document.createElement("button")
        debugGamepadsButton.innerText = "Debug Gamepads"
        debugGamepadsButton.addEventListener("click", async () => {
            const gamepads = navigator.getGamepads()
            const lines: string[] = []

            lines.push(`Build: ${this.buildTag}`)
            lines.push(`Detected gamepad slots: ${gamepads.length}`)

            for (let i = 0; i < gamepads.length; i++) {
                const gp = gamepads[i]
                if (!gp) {
                    lines.push(`[${i}] empty`)
                    continue
                }

                lines.push(`[${i}] index=${gp.index} connected=${gp.connected} mapping=${gp.mapping}`)
                lines.push(`    id=${gp.id}`)
                lines.push(`    buttons=${gp.buttons.length} axes=${gp.axes.length} ts=${gp.timestamp}`)
            }

            // Add debug logs from StreamInput
            const streamInput = this.app.getStreamInput()
            if (streamInput) {
                lines.push("")
                lines.push("=== Input Debug Logs ===")
                const debugLogs = streamInput.getDebugLogs()
                debugLogs.forEach(log => lines.push(log))
            }

            await showMessage(lines.join("\n"))
        })
        this.buttonDiv.appendChild(debugGamepadsButton)

        const teslaSwapButton = document.createElement("button")
        const updateTeslaSwapLabel = () => {
            const state = getTeslaVirtualSwapOverride()
            const stateLabel = state === null ? "Auto" : (state ? "On" : "Off")
            teslaSwapButton.innerText = `Tesla ABXY: ${stateLabel}`
        }
        updateTeslaSwapLabel()
        teslaSwapButton.addEventListener("click", async () => {
            const current = getTeslaVirtualSwapOverride()
            const next = current === null ? true : (current === true ? false : null)
            setTeslaVirtualSwapOverride(next)
            updateTeslaSwapLabel()

            const explain = next === null
                ? "Auto mode (ID-based detection)"
                : (next ? "Forced ON: swap Tesla virtual ABXY" : "Forced OFF: no Tesla virtual ABXY swap")
            await showMessage(`Tesla ABXY override changed to ${teslaSwapButton.innerText}.\n${explain}`)
        })
        this.buttonDiv.appendChild(teslaSwapButton)

        const buildInfo = document.createElement("div")
        buildInfo.classList.add("sidebar-build-tag")
        buildInfo.innerText = `Build: ${this.buildTag}`
        this.div.appendChild(buildInfo)


        // Select Mouse Mode
        this.mouseMode = new SelectComponent("mouseMode", [
            { value: "relative", name: "Relative" },
            { value: "follow", name: "Follow" },
            { value: "pointAndDrag", name: "Point and Drag" }
        ], {
            displayName: "Mouse Mode",
            preSelectedOption: this.app.getInputConfig().mouseMode
        })
        this.mouseMode.addChangeListener(this.onMouseModeChange.bind(this))
        this.mouseMode.mount(this.div)

        // Select Touch Mode
        this.touchMode = new SelectComponent("touchMode", [
            { value: "touch", name: "Touch" },
            { value: "mouseRelative", name: "Relative" },
            { value: "pointAndDrag", name: "Point and Drag" }
        ], {
            displayName: "Touch Mode",
            preSelectedOption: this.app.getInputConfig().touchMode
        })
        this.touchMode.addChangeListener(this.onTouchModeChange.bind(this))
        this.touchMode.mount(this.div)
    }

    onCapabilitiesChange(capabilities: StreamCapabilities) {
        this.touchMode.setOptionEnabled("touch", capabilities.touch)
    }

    getScreenKeyboard(): ScreenKeyboard {
        return this.screenKeyboard
    }

    // -- Keyboard
    private onText(event: TextEvent) {
        this.app.getStream()?.getInput().sendText(event.detail.text)
    }
    private onKeyDown(event: KeyboardEvent) {
        this.app.getStream()?.getInput().onKeyDown(event)
    }
    private onKeyUp(event: KeyboardEvent) {
        this.app.getStream()?.getInput().onKeyUp(event)
    }
    private onKeyboardModeChange(event: KeyboardModeEvent) {
        if (event.detail.enabled) {
            this.floatingKeyboardButton.style.display = "flex"
        } else {
            this.floatingKeyboardButton.style.display = "none"
        }
    }

    // -- Mouse Mode
    private onMouseModeChange() {
        const config = this.app.getInputConfig()
        config.mouseMode = this.mouseMode.getValue() as any
        this.app.setInputConfig(config)
    }

    // -- Touch Mode
    private onTouchModeChange() {
        const config = this.app.getInputConfig()
        config.touchMode = this.touchMode.getValue() as any
        this.app.setInputConfig(config)
    }

    extended(): void {

    }
    unextend(): void {

    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.div)
        const appRoot = document.getElementById("root")
        ;(appRoot ?? document.body).appendChild(this.floatingKeyboardButton)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.div)
        if (this.floatingKeyboardButton.parentElement) {
            this.floatingKeyboardButton.parentElement.removeChild(this.floatingKeyboardButton)
        }
    }
}

class SendKeycodeModal extends FormModal<number> {

    private dropdownSearch: SelectComponent

    constructor() {
        super()

        const keyList = []
        for (const keyName of Object.keys(StreamKeys)) {
            const keyValue = StreamKeys[keyName]

            const PREFIX = "VK_"

            let name = keyName
            if (name.startsWith(PREFIX)) {
                name = name.slice(PREFIX.length)
            }

            keyList.push({
                value: keyValue.toString(),
                name
            })
        }

        this.dropdownSearch = new SelectComponent("winKeycode", keyList, {
            hasSearch: true,
            displayName: "Select Keycode"
        })
    }

    mountForm(form: HTMLFormElement): void {
        this.dropdownSearch.mount(form)
    }


    reset(): void {
        this.dropdownSearch.reset()
    }

    submit(): number | null {
        const keyString = this.dropdownSearch.getValue()
        if (keyString == null) {
            return null
        }

        return parseInt(keyString)
    }
}

// Stop propagation so the stream doesn't get it
function stopPropagationOn(element: HTMLElement) {
    element.addEventListener("keydown", onStopPropagation)
    element.addEventListener("keyup", onStopPropagation)
    element.addEventListener("keypress", onStopPropagation)
    element.addEventListener("click", onStopPropagation)
    element.addEventListener("mousedown", onStopPropagation)
    element.addEventListener("mouseup", onStopPropagation)
    element.addEventListener("mousemove", onStopPropagation)
    element.addEventListener("wheel", onStopPropagation)
    element.addEventListener("contextmenu", onStopPropagation)
    element.addEventListener("touchstart", onStopPropagation)
    element.addEventListener("touchmove", onStopPropagation)
    element.addEventListener("touchend", onStopPropagation)
    element.addEventListener("touchcancel", onStopPropagation)
}
function onStopPropagation(event: Event) {
    event.stopPropagation()
}
