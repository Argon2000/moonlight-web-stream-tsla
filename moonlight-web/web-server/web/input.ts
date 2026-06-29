import "./polyfill/index.js"
import { getApi } from "./api.js"
import { Component } from "./component/index.js"
import { showErrorPopup } from "./component/error.js"
import { InputComponent, SelectComponent } from "./component/input.js"
import { InputOnlyStream, InputStreamInfoEvent } from "./stream/input_stream.js"
import { StreamInputConfig } from "./stream/input.js"
import { ScreenKeyboard, TextEvent } from "./screen_keyboard.js"

function defaultInputOnlySettings(): StreamInputConfig {
    return {
        mouseMode: "relative",
        mouseScrollMode: "highres",
        touchMode: "mouseRelative",
        controllerConfig: {
            invertAB: false,
            invertXY: false,
        },
    }
}

function getLocalInputOnlySettings(hostId: number): StreamInputConfig {
    const settings = defaultInputOnlySettings()
    try {
        const raw = localStorage.getItem(`mlInputOnlySettings_host_${hostId}`)
        if (raw != null) {
            Object.assign(settings, JSON.parse(raw))
        }
    } catch (e) {
        localStorage.removeItem(`mlInputOnlySettings_host_${hostId}`)
    }
    return settings
}

function setLocalInputOnlySettings(hostId: number, settings: StreamInputConfig) {
    localStorage.setItem(`mlInputOnlySettings_host_${hostId}`, JSON.stringify(settings))
}

async function startApp() {
    const api = await getApi()

    const rootElement = document.getElementById("root")
    if (rootElement == null) {
        showErrorPopup("couldn't find root element", true)
        return
    }

    const queryParams = new URLSearchParams(location.search)
    const hostIdStr = queryParams.get("hostId")
    if (hostIdStr == null) {
        showErrorPopup("No Host Id found", true)
        return
    }
    const hostId = Number.parseInt(hostIdStr)

    const app = new InputApp(api, hostId)
    app.mount(rootElement)
}

startApp()

class InputApp implements Component {
    private div = document.createElement("div")
    private toolbar = document.createElement("div")
    private statusText = document.createElement("p")
    private buttonRow = document.createElement("div")
    private lockButton = document.createElement("button")
    private keyboardButton = document.createElement("button")
    private settingsButton = document.createElement("button")
    private settingsPanel = document.createElement("div")

    private screenKeyboard = new ScreenKeyboard()

    private inputElement: HTMLDivElement

    private hostId: number
    private inputConfig: StreamInputConfig

    private mouseMode: SelectComponent
    private touchMode: SelectComponent
    private mouseScrollMode: SelectComponent
    private controllerInvertAB: InputComponent
    private controllerInvertXY: InputComponent

    private stream: InputOnlyStream

    constructor(api: import("./api.js").Api, hostId: number) {
        this.hostId = hostId
        this.inputConfig = getLocalInputOnlySettings(hostId)
        this.inputElement = document.getElementById("input") as HTMLDivElement

        const surfaceHint = document.createElement("p")
        surfaceHint.classList.add("input-only-surface-hint")
        surfaceHint.innerText = "Touch or drag anywhere here to send mouse/touch input"
        this.inputElement.appendChild(surfaceHint)

        // On mobile, adjust the input surface's position to start below the toolbar,
        // so it doesn't overlap buttons when the soft keyboard appears/disappears.
        // Also trigger input rect recalculation on orientation changes.
        const adjustSurfacePosition = () => {
            const toolbar = document.querySelector('.input-only-toolbar') as HTMLElement
            if (toolbar) {
                const toolbarHeight = toolbar.offsetHeight
                this.inputElement.style.top = `${toolbarHeight}px`
                this.inputElement.style.height = `calc(100dvh - ${toolbarHeight}px)`
            }
        }

        // Adjust on first load
        setTimeout(adjustSurfacePosition, 0)

        // Re-adjust when viewport changes (soft keyboard appears/disappears, orientation change, etc.)
        // Use a throttled handler to avoid excessive recalculation
        let resizeTimeout: number | null = null
        const throttledResize = () => {
            if (resizeTimeout !== null) return
            resizeTimeout = window.setTimeout(() => {
                adjustSurfacePosition()
                // Trigger focus on the input element to refresh getInputRect() calculations
                this.inputElement.focus()
                resizeTimeout = null
            }, 100)
        }

        window.addEventListener("resize", throttledResize)
        window.addEventListener("orientationchange", throttledResize)

        this.div.classList.add("input-only-app")

        this.toolbar.classList.add("input-only-toolbar")
        this.div.appendChild(this.toolbar)

        this.statusText.classList.add("input-only-status")
        this.statusText.innerText = "Connecting..."
        this.toolbar.appendChild(this.statusText)

        this.buttonRow.classList.add("input-only-buttons")
        this.toolbar.appendChild(this.buttonRow)

        this.lockButton.innerText = "Lock Mouse"
        this.lockButton.addEventListener("click", (e) => {
            e.preventDefault()
            e.stopPropagation()
            this.requestPointerLock()
        })
        this.buttonRow.appendChild(this.lockButton)

        this.keyboardButton.innerText = "Keyboard"
        this.keyboardButton.addEventListener("click", (e) => {
            e.preventDefault()
            e.stopPropagation()
            // Toggle based on whether the hidden textarea is actually focused.
            // This is more reliable than checking isVisible() because the state
            // can get out of sync if click events interfere with focus.
            const hiddenTextarea = document.querySelector('.hiddeninput') as HTMLElement
            if (document.activeElement === hiddenTextarea) {
                // Textarea is focused, so hide the keyboard
                this.screenKeyboard.hide()
            } else {
                // Textarea is not focused, so show the keyboard
                this.screenKeyboard.show()
            }
        })
        this.buttonRow.appendChild(this.keyboardButton)
        this.div.appendChild(this.screenKeyboard.getHiddenElement())

        this.settingsButton.innerText = "Settings"
        this.settingsButton.addEventListener("click", (e) => {
            e.preventDefault()
            e.stopPropagation()
            this.toggleSettings()
        })
        this.buttonRow.appendChild(this.settingsButton)

        this.settingsPanel.classList.add("input-only-settings")
        this.settingsPanel.style.display = "none"
        this.toolbar.appendChild(this.settingsPanel)

        this.mouseMode = new SelectComponent("mouseMode", [
            { value: "relative", name: "Relative" },
            { value: "follow", name: "Follow" },
            { value: "pointAndDrag", name: "Point and Drag" },
        ], {
            displayName: "Mouse Mode",
            preSelectedOption: this.inputConfig.mouseMode,
        })
        this.mouseMode.addChangeListener(this.onSettingsChange.bind(this))
        this.mouseMode.mount(this.settingsPanel)

        this.touchMode = new SelectComponent("touchMode", [
            { value: "touch", name: "Touch" },
            { value: "mouseRelative", name: "Relative" },
            { value: "pointAndDrag", name: "Point and Drag" },
        ], {
            displayName: "Touch Mode",
            preSelectedOption: this.inputConfig.touchMode,
        })
        this.touchMode.addChangeListener(this.onSettingsChange.bind(this))
        this.touchMode.mount(this.settingsPanel)

        this.mouseScrollMode = new SelectComponent("mouseScrollMode", [
            { value: "highres", name: "High Res" },
            { value: "normal", name: "Normal" },
        ], {
            displayName: "Scroll Mode",
            preSelectedOption: this.inputConfig.mouseScrollMode,
        })
        this.mouseScrollMode.addChangeListener(this.onSettingsChange.bind(this))
        this.mouseScrollMode.mount(this.settingsPanel)

        this.controllerInvertAB = new InputComponent("controllerInvertAB", "checkbox", "Invert A and B", {
            checked: this.inputConfig.controllerConfig.invertAB,
        })
        this.controllerInvertAB.addChangeListener(this.onSettingsChange.bind(this))
        this.controllerInvertAB.mount(this.settingsPanel)

        this.controllerInvertXY = new InputComponent("controllerInvertXY", "checkbox", "Invert X and Y", {
            checked: this.inputConfig.controllerConfig.invertXY,
        })
        this.controllerInvertXY.addChangeListener(this.onSettingsChange.bind(this))
        this.controllerInvertXY.mount(this.settingsPanel)

        this.stream = new InputOnlyStream(api, hostId, this.inputConfig)
        this.stream.addInfoListener(this.onInfo.bind(this))

        this.screenKeyboard.addKeyDownListener((event) => this.stream.getInput().onKeyDown(event))
        this.screenKeyboard.addKeyUpListener((event) => this.stream.getInput().onKeyUp(event))
        this.screenKeyboard.addTextListener(this.onScreenText.bind(this))

        // Only the dedicated input surface gets these listeners — not `document` —
        // so taps on the toolbar's buttons/settings (a separate sibling element)
        // can never also register as mouse/touch input to the host.
        this.addListeners(this.inputElement)

        this.inputElement.focus()

        window.addEventListener("gamepadconnected", this.onGamepadConnect.bind(this))
        window.addEventListener("gamepaddisconnected", this.onGamepadDisconnect.bind(this))
        for (const gamepad of navigator.getGamepads()) {
            if (gamepad != null) {
                this.stream.getInput().onGamepadConnect(gamepad)
            }
        }
        this.ensureGamepadPollLoop()
    }

    private toggleSettings() {
        const hidden = this.settingsPanel.style.display == "none"
        this.settingsPanel.style.display = hidden ? "" : "none"
    }

    private onSettingsChange() {
        this.inputConfig.mouseMode = this.mouseMode.getValue() as any
        this.inputConfig.touchMode = this.touchMode.getValue() as any
        this.inputConfig.mouseScrollMode = this.mouseScrollMode.getValue() as any
        this.inputConfig.controllerConfig.invertAB = this.controllerInvertAB.isChecked()
        this.inputConfig.controllerConfig.invertXY = this.controllerInvertXY.isChecked()

        this.stream.getInput().setConfig(this.inputConfig)
        setLocalInputOnlySettings(this.hostId, this.inputConfig)
    }

    private onScreenText(event: TextEvent) {
        this.stream.getInput().sendText(event.detail.text)
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

    private getInputRect(): DOMRect {
        // Input surface starts below the toolbar, so calculate the rect accounting for that.
        // This ensures mouse movement and touch coordinates are correctly mapped when
        // the phone orientation changes (portrait ↔ landscape).
        const toolbar = document.querySelector('.input-only-toolbar') as HTMLElement
        const toolbarHeight = toolbar ? toolbar.offsetHeight : 0
        const surfaceTop = toolbarHeight
        const surfaceHeight = window.innerHeight - toolbarHeight

        return new DOMRect(0, surfaceTop, window.innerWidth, surfaceHeight)
    }

    private onInfo(event: InputStreamInfoEvent) {
        const data = event.detail

        if (data.type == "stageStarting") {
            this.statusText.innerText = `Connecting: ${data.stage}`
        } else if (data.type == "stageComplete") {
            this.statusText.innerText = `Connecting: ${data.stage} done`
        } else if (data.type == "stageFailed") {
            this.statusText.innerText = `Failed: ${data.stage} (code ${data.errorCode})`
            showErrorPopup(`Failed: ${data.stage} (code ${data.errorCode})`, true)
        } else if (data.type == "hostNotFound") {
            this.statusText.innerText = "Host not found"
            showErrorPopup("Host not found", true)
        } else if (data.type == "waitingForStream") {
            this.statusText.innerText = "Waiting for the main stream to start…"
        } else if (data.type == "reconnecting") {
            this.statusText.innerText = "Reconnecting to server…"
        } else if (data.type == "connected") {
            this.statusText.innerText = "Connected — input is being sent"
        } else if (data.type == "error") {
            this.statusText.innerText = `Error: ${data.message}`
            showErrorPopup(data.message, true)
        }
    }

    private async requestPointerLock() {
        if ("requestPointerLock" in this.inputElement) {
            this.inputElement.focus()
            try {
                await this.inputElement.requestPointerLock()
            } catch (error) {
                console.warn("requestPointerLock failed", error)
            }
        }
    }

    // -- Keyboard
    private onKeyDown(event: KeyboardEvent) {
        if (event.ctrlKey && event.code == "KeyV") {
            // Likely pasting — don't send the raw keys
        } else {
            event.preventDefault()
            this.stream.getInput().onKeyDown(event)
        }
        event.stopPropagation()
    }
    private onKeyUp(event: KeyboardEvent) {
        event.preventDefault()
        this.stream.getInput().onKeyUp(event)
        event.stopPropagation()
    }
    private onPaste(event: ClipboardEvent) {
        this.stream.getInput().onPaste(event)
        event.stopPropagation()
    }

    // -- Mouse
    private onMouseButtonDown(event: MouseEvent) {
        event.preventDefault()
        // preventDefault() above can suppress the browser's default
        // focus-on-tap behavior, so focus explicitly to keep keydown/keyup
        // routed to the input surface instead of getting dropped.
        this.inputElement.focus()
        this.stream.getInput().onMouseDown(event, this.getInputRect())
        event.stopPropagation()
    }
    private onMouseButtonUp(event: MouseEvent) {
        event.preventDefault()
        this.stream.getInput().onMouseUp(event)
        event.stopPropagation()
    }
    private onMouseMove(event: MouseEvent) {
        event.preventDefault()
        this.stream.getInput().onMouseMove(event, this.getInputRect())
        event.stopPropagation()
    }
    private onMouseWheel(event: WheelEvent) {
        event.preventDefault()
        this.stream.getInput().onMouseWheel(event)
        event.stopPropagation()
    }
    private onContextMenu(event: MouseEvent) {
        event.preventDefault()
        event.stopPropagation()
    }

    // -- Touch
    private onTouchStart(event: TouchEvent) {
        event.preventDefault()
        this.inputElement.focus()
        this.stream.getInput().onTouchStart(event, this.getInputRect())
        event.stopPropagation()
    }
    private onTouchEnd(event: TouchEvent) {
        event.preventDefault()
        this.stream.getInput().onTouchEnd(event, this.getInputRect())
        event.stopPropagation()
    }
    private onTouchCancel(event: TouchEvent) {
        event?.preventDefault()
        this.stream.getInput().onTouchCancel(event, this.getInputRect())
        event.stopPropagation()
    }
    private onTouchMove(event: TouchEvent) {
        event.preventDefault()
        this.stream.getInput().onTouchMove(event, this.getInputRect())
        event.stopPropagation()
    }

    // -- Gamepad
    private onGamepadConnect(event: GamepadEvent) {
        this.stream.getInput().onGamepadConnect(event.gamepad)
    }
    private onGamepadDisconnect(event: GamepadEvent) {
        this.stream.getInput().onGamepadDisconnect(event)
    }
    private ensureGamepadPollLoop() {
        const poll = () => {
            if (this.stream.getInput().hasGamepads()) {
                this.stream.getInput().onGamepadUpdate()
            }
            requestAnimationFrame(poll)
        }
        requestAnimationFrame(poll)
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.div)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.div)
        this.stream.close()
    }
}
