import { Api, apiDisableTotp, apiEnableTotp, apiGetAuthInfo, apiGetTotpSetup, AuthInfo, logout } from "../api.js";
import { ControllerConfig } from "../stream/gamepad.js";
import { MouseScrollMode } from "../stream/input.js";
import { Component, ComponentEvent } from "./index.js";
import { InputComponent, SelectComponent } from "./input.js";
import { showMessage, showModal } from "./modal/index.js";
import { FormModal } from "./modal/form.js";
import { SidebarEdge } from "./sidebar/index.js";

export type StreamSettings = {
    sidebarEdge: SidebarEdge,
    bitrate: number
    packetSize: number
    videoSampleQueueSize: number
    videoSize: "720p" | "1080p" | "1440p" | "4k" | "native" | "custom"
    videoSizeCustom: {
        width: number
        height: number
    },
    fps: number
    dontForceH264: boolean
    canvasRenderer: boolean
    playAudioLocal: boolean
    keepAudioAlive: boolean
    audioSampleQueueSize: number
    mouseScrollMode: MouseScrollMode
    controllerConfig: ControllerConfig
    controllerDeviceMode: "auto" | "physical" | "virtual"
    toggleFullscreenWithKeybind: boolean,
    stretchToFit: boolean,
    showStreamStats: boolean,
    useAudioWorker: boolean,
    useVideoWorker: boolean,
}

export function defaultStreamSettings(): StreamSettings {
    return {
        sidebarEdge: "left",
        bitrate: 12000,
        packetSize: 1024,
        fps: 120,
        videoSampleQueueSize: 1,
        videoSize: "1080p",
        videoSizeCustom: {
            width: 960,
            height: 540,
        },
        dontForceH264: false,
        canvasRenderer: true,
        playAudioLocal: false,
        keepAudioAlive: true,
        audioSampleQueueSize: 1,
        mouseScrollMode: "normal",
        controllerConfig: {
            invertAB: false,
            invertXY: false
        },
        controllerDeviceMode: "auto",
        toggleFullscreenWithKeybind: false,
        stretchToFit: true,
        showStreamStats: false,
        useAudioWorker: true,
        useVideoWorker: false,
    }
}

export function getLocalStreamSettings(hostId?: number): StreamSettings | null {
    let settings = null
    try {
        // Try host-specific settings first, then fall back to global
        const hostKey = hostId != null ? `mlSettings_host_${hostId}` : null
        const raw = (hostKey && localStorage.getItem(hostKey)) || localStorage.getItem("mlSettings")
        if (raw == null) {
            return null
        }

        const settingsLoaded = JSON.parse(raw)

        settings = defaultStreamSettings()
        Object.assign(settings, settingsLoaded)
    } catch (e) {
        if (hostId != null) {
            localStorage.removeItem(`mlSettings_host_${hostId}`)
        }
        localStorage.removeItem("mlSettings")
    }
    return settings
}
export function setLocalStreamSettings(settings?: StreamSettings, hostId?: number) {
    const json = JSON.stringify(settings)
    // Always save to global key
    localStorage.setItem("mlSettings", json)
    // Also save per-host if a hostId was provided
    if (hostId != null) {
        localStorage.setItem(`mlSettings_host_${hostId}`, json)
    }
}

export type StreamSettingsChangeListener = (event: ComponentEvent<StreamSettingsComponent>) => void

export class StreamSettingsComponent implements Component {

    private divElement: HTMLDivElement = document.createElement("div")
    private securityStatusText: HTMLSpanElement = document.createElement("span")
    private setupTotpButton: HTMLButtonElement = document.createElement("button")
    private disableTotpButton: HTMLButtonElement = document.createElement("button")
    private logoutButton: HTMLButtonElement = document.createElement("button")

    private sidebarEdge: SelectComponent

    private bitrate: InputComponent
    private packetSize: InputComponent
    private fps: InputComponent
    private forceH264: InputComponent
    private canvasRenderer: InputComponent

    private videoSize: SelectComponent
    private videoSizeWidth: InputComponent
    private videoSizeHeight: InputComponent

    private videoSampleQueueSize: InputComponent

    private playAudioLocal: InputComponent
    private keepAudioAlive: InputComponent
    private audioSampleQueueSize: InputComponent

    private mouseScrollMode: SelectComponent

    private controllerInvertAB: InputComponent
    private controllerInvertXY: InputComponent
    private controllerDeviceMode: SelectComponent

    private toggleFullscreenWithKeybind: InputComponent
    private stretchToFit: InputComponent
    private showStreamStats: InputComponent
    private useAudioWorker: InputComponent
    private useVideoWorker: InputComponent

    constructor(settings?: StreamSettings, api?: Api) {
        const defaultSettings = defaultStreamSettings()

        // Root div
        this.divElement.classList.add("settings")

        const createSection = (title: string) => {
            const section = document.createElement("div")
            section.classList.add("settings-section")
            const header = document.createElement("h2")
            header.innerText = title
            section.appendChild(header)
            this.divElement.appendChild(section)
            return section
        }

        // --- Presets ---
        const presetsSection = createSection("Presets")

        const presetDesc = document.createElement("p")
        presetDesc.style.cssText = "margin:0 0 8px;opacity:0.7;font-size:0.85em;"
        presetDesc.innerText = "Apply optimized defaults. Overrides video, FPS, and bitrate settings."
        presetsSection.appendChild(presetDesc)

        const presetRow = document.createElement("div")
        presetRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;"

        const presets: Array<{ label: string, desc: string, values: Partial<StreamSettings> }> = [
            {
                label: "🎬 Video / Streaming",
                desc: "1080p 30fps 3 Mbps — low bandwidth, smooth video playback",
                values: { videoSize: "1080p", fps: 30, bitrate: 3000 }
            },
            {
                label: "🎮 Gaming (Balanced)",
                desc: "1080p 60fps 8 Mbps — good balance of quality and responsiveness",
                values: { videoSize: "1080p", fps: 60, bitrate: 8000 }
            },
            {
                label: "🎮 Gaming (Performance)",
                desc: "1080p 120fps 12 Mbps — maximum responsiveness",
                values: { videoSize: "1080p", fps: 120, bitrate: 12000 }
            },
            {
                label: "📱 Low Bandwidth",
                desc: "720p 30fps 1.5 Mbps — minimal data usage",
                values: { videoSize: "720p", fps: 30, bitrate: 1500 }
            },
        ]

        for (const preset of presets) {
            const btn = document.createElement("button")
            btn.innerText = preset.label
            btn.title = preset.desc
            btn.style.cssText = "flex:1;min-width:140px;padding:6px 10px;font-size:0.85em;"
            btn.addEventListener("click", () => {
                const current = getLocalStreamSettings() ?? defaultStreamSettings()
                Object.assign(current, preset.values)
                setLocalStreamSettings(current)
                location.reload()
            })
            presetRow.appendChild(btn)
        }
        presetsSection.appendChild(presetRow)

        // --- Basic Settings ---
        const basicSection = createSection("Basic Settings")

        // Sidebar
        this.sidebarEdge = new SelectComponent("sidebarEdge", [
            { value: "left", name: "Left" },
            { value: "right", name: "Right" },
            { value: "up", name: "Up" },
            { value: "down", name: "Down" },
        ], {
            displayName: "Sidebar Edge",
            preSelectedOption: settings?.sidebarEdge ?? defaultSettings.sidebarEdge,
        })
        this.sidebarEdge.addChangeListener(this.onSettingsChange.bind(this))
        this.sidebarEdge.mount(basicSection)

        // Video Size
        this.videoSize = new SelectComponent("videoSize",
            [
                { value: "720p", name: "720p" },
                { value: "1080p", name: "1080p" },
                { value: "1440p", name: "1440p" },
                { value: "4k", name: "4k" },
                { value: "native", name: "native" },
                { value: "custom", name: "custom" }
            ],
            {
                displayName: "Video Size",
                preSelectedOption: settings?.videoSize || defaultSettings.videoSize
            }
        )
        this.videoSize.addChangeListener(this.onSettingsChange.bind(this))
        this.videoSize.mount(basicSection)

        this.videoSizeWidth = new InputComponent("videoSizeWidth", "number", "Video Width", {
            defaultValue: defaultSettings.videoSizeCustom.width.toString(),
            value: settings?.videoSizeCustom.width.toString()
        })
        this.videoSizeWidth.addChangeListener(this.onSettingsChange.bind(this))
        this.videoSizeWidth.mount(basicSection)

        this.videoSizeHeight = new InputComponent("videoSizeHeight", "number", "Video Height", {
            defaultValue: defaultSettings.videoSizeCustom.height.toString(),
            value: settings?.videoSizeCustom.height.toString()
        })
        this.videoSizeHeight.addChangeListener(this.onSettingsChange.bind(this))
        this.videoSizeHeight.mount(basicSection)

        // Fps
        this.fps = new InputComponent("fps", "number", "Fps", {
            defaultValue: defaultSettings.fps.toString(),
            value: settings?.fps?.toString(),
            step: "5"
        })
        this.fps.addChangeListener(this.onSettingsChange.bind(this))
        this.fps.mount(basicSection)

        // Bitrate
        this.bitrate = new InputComponent("bitrate", "number", "Bitrate", {
            defaultValue: defaultSettings.bitrate.toString(),
            value: settings?.bitrate?.toString(),
            step: "100",
        })
        this.bitrate.addChangeListener(this.onSettingsChange.bind(this))
        this.bitrate.mount(basicSection)

        // --- Audio Settings ---
        const audioSection = createSection("Audio Settings")

        this.playAudioLocal = new InputComponent("playAudioLocal", "checkbox", "Play Audio Local", {
            checked: settings?.playAudioLocal ?? defaultSettings.playAudioLocal
        })
        this.playAudioLocal.addChangeListener(this.onSettingsChange.bind(this))
        this.playAudioLocal.mount(audioSection)

        this.keepAudioAlive = new InputComponent("keepAudioAlive", "checkbox", "Keep Audio Context Alive (Tesla Fix)", {
            checked: settings?.keepAudioAlive ?? defaultSettings.keepAudioAlive
        })
        this.keepAudioAlive.addChangeListener(this.onSettingsChange.bind(this))
        this.keepAudioAlive.mount(audioSection)

        // Audio Sample Queue Size
        this.audioSampleQueueSize = new InputComponent("audioSampleQueueSize", "number", "Audio Sample Queue Size", {
            defaultValue: defaultSettings.audioSampleQueueSize.toString(),
            value: settings?.audioSampleQueueSize?.toString()
        })
        this.audioSampleQueueSize.addChangeListener(this.onSettingsChange.bind(this))
        this.audioSampleQueueSize.mount(audioSection)


        // --- Input Settings ---
        const inputSection = createSection("Input Settings")

        this.mouseScrollMode = new SelectComponent("mouseScrollMode",
            [
                { value: "highres", name: "High Res" },
                { value: "normal", name: "Normal" }
            ],
            {
                displayName: "Scroll Mode",
                preSelectedOption: settings?.mouseScrollMode || defaultSettings.mouseScrollMode
            }
        )
        this.mouseScrollMode.addChangeListener(this.onSettingsChange.bind(this))
        this.mouseScrollMode.mount(inputSection)

        // Controller Header info
        const controllerHeader = document.createElement("h3")
        if (window.isSecureContext) {
            controllerHeader.innerText = "Controller"
        } else {
            controllerHeader.innerText = "Controller (Disabled: Secure Context Required)"
        }
        inputSection.appendChild(controllerHeader)

        this.controllerInvertAB = new InputComponent("controllerInvertAB", "checkbox", "Invert A and B", {
            checked: settings?.controllerConfig.invertAB ?? defaultSettings.controllerConfig.invertAB
        })
        this.controllerInvertAB.addChangeListener(this.onSettingsChange.bind(this))
        this.controllerInvertAB.mount(inputSection)

        this.controllerInvertXY = new InputComponent("controllerInvertXY", "checkbox", "Invert X and Y", {
            checked: settings?.controllerConfig.invertXY ?? defaultSettings.controllerConfig.invertXY
        })
        this.controllerInvertXY.addChangeListener(this.onSettingsChange.bind(this))
        this.controllerInvertXY.mount(inputSection)

        this.controllerDeviceMode = new SelectComponent("controllerDeviceMode", [
            { value: "auto", name: "Auto (prefer physical)" },
            { value: "physical", name: "Physical Only" },
            { value: "virtual", name: "Virtual Only" },
        ], {
            displayName: "Controller Device Mode",
            preSelectedOption: settings?.controllerDeviceMode ?? defaultSettings.controllerDeviceMode
        })
        this.controllerDeviceMode.addChangeListener(this.onSettingsChange.bind(this))
        this.controllerDeviceMode.mount(inputSection)

        if (!window.isSecureContext) {
            this.controllerInvertAB.setEnabled(false)
            this.controllerInvertXY.setEnabled(false)
            this.controllerDeviceMode.setOptionEnabled("auto", false)
            this.controllerDeviceMode.setOptionEnabled("physical", false)
            this.controllerDeviceMode.setOptionEnabled("virtual", false)
        }


        // --- Advanced Settings ---
        const advancedSection = createSection("Advanced Settings")

        // Packet Size
        this.packetSize = new InputComponent("packetSize", "number", "Packet Size", {
            defaultValue: defaultSettings.packetSize.toString(),
            value: settings?.packetSize?.toString(),
            step: "100"
        })
        this.packetSize.addChangeListener(this.onSettingsChange.bind(this))
        this.packetSize.mount(advancedSection)

        // Video Sample Queue Size
        this.videoSampleQueueSize = new InputComponent("videoSampleQueueSize", "number", "Video Sample Queue Size", {
            defaultValue: defaultSettings.videoSampleQueueSize.toString(),
            value: settings?.videoSampleQueueSize?.toString()
        })
        this.videoSampleQueueSize.addChangeListener(this.onSettingsChange.bind(this))
        this.videoSampleQueueSize.mount(advancedSection)

        // Force H264
        this.forceH264 = new InputComponent("dontForceH264", "checkbox", "Select Codec based on Support in Browser (Experimental)", {
            defaultValue: defaultSettings.dontForceH264.toString(),
            checked: settings?.dontForceH264
        })
        this.forceH264.addChangeListener(this.onSettingsChange.bind(this))
        this.forceH264.mount(advancedSection)

        // Use Canvas Renderer
        this.canvasRenderer = new InputComponent("canvasRenderer", "checkbox", "Use Canvas Renderer (Experimental)", {
            defaultValue: defaultSettings.canvasRenderer.toString(),
            checked: settings?.canvasRenderer ?? defaultSettings.canvasRenderer
        })
        this.canvasRenderer.addChangeListener(this.onSettingsChange.bind(this))
        this.canvasRenderer.mount(advancedSection)

        // Worker acceleration toggles
        this.useAudioWorker = new InputComponent("useAudioWorker", "checkbox", "Audio Decode Worker", {
            checked: settings?.useAudioWorker ?? defaultSettings.useAudioWorker
        })
        this.useAudioWorker.addChangeListener(this.onSettingsChange.bind(this))
        this.useAudioWorker.mount(advancedSection)

        this.useVideoWorker = new InputComponent("useVideoWorker", "checkbox", "Video Render Worker (OffscreenCanvas)", {
            checked: settings?.useVideoWorker ?? defaultSettings.useVideoWorker
        })
        this.useVideoWorker.addChangeListener(this.onSettingsChange.bind(this))
        this.useVideoWorker.mount(advancedSection)

        // Stretch to fit
        this.stretchToFit = new InputComponent("stretchToFit", "checkbox", "Stretch image to fit window", {
            checked: settings?.stretchToFit ?? defaultSettings.stretchToFit
        })
        this.stretchToFit.addChangeListener(this.onSettingsChange.bind(this))
        this.stretchToFit.mount(advancedSection)

        this.toggleFullscreenWithKeybind = new InputComponent("toggleFullscreenWithKeybind", "checkbox", "Toggle Fullscreen and Mouse Lock with Ctrl + Shift + I", {
            checked: settings?.toggleFullscreenWithKeybind
        })
        this.toggleFullscreenWithKeybind.addChangeListener(this.onSettingsChange.bind(this))
        this.toggleFullscreenWithKeybind.mount(advancedSection)

        // Show Stream Stats
        this.showStreamStats = new InputComponent("showStreamStats", "checkbox", "Show Stream Stats Overlay", {
            checked: settings?.showStreamStats ?? defaultSettings.showStreamStats
        })
        this.showStreamStats.addChangeListener(this.onSettingsChange.bind(this))
        this.showStreamStats.mount(advancedSection)

        const resetButton = document.createElement("button")
        resetButton.innerText = "Reset to Default Settings"
        resetButton.addEventListener("click", () => this.resetToDefaults())
        advancedSection.appendChild(resetButton)

        // --- Security Settings ---
        if (api) {
            const securitySection = createSection("Security")

            this.securityStatusText.innerText = "Loading 2FA status…"
            securitySection.appendChild(this.securityStatusText)

            this.setupTotpButton.innerText = "Set Up Two-Factor Authentication"
            this.setupTotpButton.style.display = "none"
            this.setupTotpButton.addEventListener("click", () => this.handleTotpSetup(api))
            securitySection.appendChild(this.setupTotpButton)

            this.disableTotpButton.innerText = "Disable Two-Factor Authentication"
            this.disableTotpButton.style.display = "none"
            this.disableTotpButton.addEventListener("click", () => this.handleTotpDisable(api))
            securitySection.appendChild(this.disableTotpButton)

            const logoutSep = document.createElement("hr")
            logoutSep.style.cssText = "border-color:rgba(255,255,255,0.15);margin:12px 0;"
            securitySection.appendChild(logoutSep)

            this.logoutButton.innerText = "Log Out"
            this.logoutButton.style.background = "rgba(180,40,40,0.8)"
            this.logoutButton.style.color = "white"
            this.logoutButton.addEventListener("click", () => {
                logout()
                location.reload()
            })
            securitySection.appendChild(this.logoutButton)

            // Load current 2FA status asynchronously
            apiGetAuthInfo(api).then(info => this.updateTotpStatus(info))
        }

        this.onSettingsChange()
    }

    private updateTotpStatus(info: AuthInfo | null) {
        if (!info || !info.credential_authentication_enabled) {
            this.securityStatusText.innerText = "Authentication is disabled in config."
            return
        }
        if (info.totp_enabled) {
            this.securityStatusText.innerText = "Two-Factor Authentication: Enabled ✓"
            this.setupTotpButton.style.display = "none"
            this.disableTotpButton.style.display = ""
        } else {
            this.securityStatusText.innerText = "Two-Factor Authentication: Disabled"
            this.setupTotpButton.style.display = ""
            this.disableTotpButton.style.display = "none"
        }
    }

    private async handleTotpSetup(api: Api) {
        const setupData = await apiGetTotpSetup(api)
        if (!setupData) {
            await showMessage("Failed to retrieve 2FA setup data from server.")
            return
        }

        const confirmModal = new TotpSetupModal(setupData.secret, setupData.uri)
        const code = await showModal(confirmModal)
        if (!code) return

        const result = await apiEnableTotp(api, code)
        if (result === "invalid_code") {
            await showMessage("Invalid code — 2FA was NOT enabled. Try again.")
        } else if (result === "error") {
            await showMessage("Server error — could not enable 2FA.")
        } else {
            await showMessage("Two-Factor Authentication has been enabled.")
            this.updateTotpStatus({ totp_enabled: true, credential_authentication_enabled: true })
        }
    }

    private async handleTotpDisable(api: Api) {
        const ok = await apiDisableTotp(api)
        if (ok) {
            await showMessage("Two-Factor Authentication has been disabled.")
            this.updateTotpStatus({ totp_enabled: false, credential_authentication_enabled: true })
        } else {
            await showMessage("Failed to disable 2FA.")
        }
    }

    private onSettingsChange() {
        if (this.videoSize.getValue() == "custom") {
            this.videoSizeWidth.setEnabled(true)
            this.videoSizeHeight.setEnabled(true)
        } else {
            this.videoSizeWidth.setEnabled(false)
            this.videoSizeHeight.setEnabled(false)
        }

        this.divElement.dispatchEvent(new ComponentEvent("ml-settingschange", this))
    }

    resetToDefaults() {
        setLocalStreamSettings(defaultStreamSettings())
        location.reload()
    }

    addChangeListener(listener: StreamSettingsChangeListener) {
        this.divElement.addEventListener("ml-settingschange", listener as any)
    }
    removeChangeListener(listener: StreamSettingsChangeListener) {
        this.divElement.removeEventListener("ml-settingschange", listener as any)
    }

    getStreamSettings(): StreamSettings {
        const settings = defaultStreamSettings()

        settings.sidebarEdge = this.sidebarEdge.getValue() as any
        settings.bitrate = parseInt(this.bitrate.getValue())
        settings.packetSize = parseInt(this.packetSize.getValue())
        settings.fps = parseInt(this.fps.getValue())
        settings.videoSize = this.videoSize.getValue() as any
        settings.videoSizeCustom = {
            width: parseInt(this.videoSizeWidth.getValue()),
            height: parseInt(this.videoSizeHeight.getValue())
        }
        settings.videoSampleQueueSize = parseInt(this.videoSampleQueueSize.getValue())
        settings.dontForceH264 = this.forceH264.isChecked()
        settings.canvasRenderer = this.canvasRenderer.isChecked()

        settings.playAudioLocal = this.playAudioLocal.isChecked()
        settings.keepAudioAlive = this.keepAudioAlive.isChecked()
        settings.audioSampleQueueSize = parseInt(this.audioSampleQueueSize.getValue())

        settings.mouseScrollMode = this.mouseScrollMode.getValue() as any

        settings.controllerConfig.invertAB = this.controllerInvertAB.isChecked()
        settings.controllerConfig.invertXY = this.controllerInvertXY.isChecked()
        settings.controllerDeviceMode = this.controllerDeviceMode.getValue() as any

        settings.toggleFullscreenWithKeybind = this.toggleFullscreenWithKeybind.isChecked()
        settings.stretchToFit = this.stretchToFit.isChecked()
        settings.showStreamStats = this.showStreamStats.isChecked()
        settings.useAudioWorker = this.useAudioWorker.isChecked()
        settings.useVideoWorker = this.useVideoWorker.isChecked()

        return settings
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.divElement)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.divElement)
    }
}

// ---------------------------------------------------------------------------
// TotpSetupModal — shown during 2FA setup to display the secret and confirm
// ---------------------------------------------------------------------------

class TotpSetupModal extends FormModal<string> {
    private codeInput: InputComponent

    private _secret: string
    private _uri: string

    constructor(secret: string, uri: string) {
        super()
        this._secret = secret
        this._uri = uri
        this.codeInput = new InputComponent("ml-totp-setup-code", "text", "Verification Code", {
            inputMode: "numeric",
        })
    }

    reset(): void {
        this.codeInput.reset()
    }

    submit(): string | null {
        return this.codeInput.getValue() || null
    }

    mountForm(form: HTMLFormElement): void {
        const title = document.createElement("h3")
        title.innerText = "Set Up Two-Factor Authentication"

        const instructions = document.createElement("p")
        instructions.innerText =
            "Enter the secret key below into your authenticator app (Google Authenticator, " +
            "Authy, etc.) using the 'Enter setup key' option. Then type the 6-digit code to confirm."

        const keyLabel = document.createElement("p")
        keyLabel.innerHTML = "<strong>Secret key (base32):</strong>"

        const keyDisplay = document.createElement("code")
        keyDisplay.style.cssText =
            "display:block;word-break:break-all;user-select:all;padding:6px;" +
            "background:rgba(0,0,0,0.3);border-radius:4px;margin-bottom:8px;"
        keyDisplay.innerText = this._secret

        const uriNote = document.createElement("p")
        uriNote.style.fontSize = "0.8em"
        uriNote.style.opacity = "0.7"
        uriNote.innerText = "Algorithm: SHA1 · Digits: 6 · Period: 30 s"

        form.appendChild(title)
        form.appendChild(instructions)
        form.appendChild(keyLabel)
        form.appendChild(keyDisplay)
        form.appendChild(uriNote)
        this.codeInput.mount(form)
    }
}
