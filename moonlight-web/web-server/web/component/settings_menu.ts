import { ControllerConfig } from "../stream/gamepad.js";
import { MouseScrollMode } from "../stream/input.js";
import { Component, ComponentEvent } from "./index.js";
import { InputComponent, SelectComponent } from "./input.js";
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
    audioSampleQueueSize: number
    mouseScrollMode: MouseScrollMode
    controllerConfig: ControllerConfig
    toggleFullscreenWithKeybind: boolean
}

export function defaultStreamSettings(): StreamSettings {
    return {
        sidebarEdge: "left",
        bitrate: 3000,
        packetSize: 1024,
        fps: 60,
        videoSampleQueueSize: 6,
        videoSize: "720p",
        videoSizeCustom: {
            width: 1280,
            height: 720,
        },
        dontForceH264: true,
        canvasRenderer: true,
        playAudioLocal: false,
        audioSampleQueueSize: 20,
        mouseScrollMode: "normal",
        controllerConfig: {
            invertAB: false,
            invertXY: false
        },
        toggleFullscreenWithKeybind: false
    }
}

export function getLocalStreamSettings(): StreamSettings | null {
    let settings = null
    try {
        const settingsLoadedJson = localStorage.getItem("mlSettings")
        if (settingsLoadedJson == null) {
            return null
        }

        const settingsLoaded = JSON.parse(settingsLoadedJson)

        settings = defaultStreamSettings()
        Object.assign(settings, settingsLoaded)
    } catch (e) {
        localStorage.removeItem("mlSettings")
    }
    return settings
}
export function setLocalStreamSettings(settings?: StreamSettings) {
    localStorage.setItem("mlSettings", JSON.stringify(settings))
}

export type StreamSettingsChangeListener = (event: ComponentEvent<StreamSettingsComponent>) => void

export class StreamSettingsComponent implements Component {

    private divElement: HTMLDivElement = document.createElement("div")

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
    private audioSampleQueueSize: InputComponent

    private mouseScrollMode: SelectComponent

    private controllerInvertAB: InputComponent
    private controllerInvertXY: InputComponent

    private toggleFullscreenWithKeybind: InputComponent

    constructor(settings?: StreamSettings) {
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
            step: "100"
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

        if (!window.isSecureContext) {
            this.controllerInvertAB.setEnabled(false)
            this.controllerInvertXY.setEnabled(false)
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

        this.toggleFullscreenWithKeybind = new InputComponent("toggleFullscreenWithKeybind", "checkbox", "Toggle Fullscreen and Mouse Lock with Ctrl + Shift + I", {
            checked: settings?.toggleFullscreenWithKeybind
        })
        this.toggleFullscreenWithKeybind.addChangeListener(this.onSettingsChange.bind(this))
        this.toggleFullscreenWithKeybind.mount(advancedSection)

        this.onSettingsChange()
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
        settings.audioSampleQueueSize = parseInt(this.audioSampleQueueSize.getValue())

        settings.mouseScrollMode = this.mouseScrollMode.getValue() as any

        settings.controllerConfig.invertAB = this.controllerInvertAB.isChecked()
        settings.controllerConfig.invertXY = this.controllerInvertXY.isChecked()

        settings.toggleFullscreenWithKeybind = this.toggleFullscreenWithKeybind.isChecked()

        return settings
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.divElement)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.divElement)
    }
}
