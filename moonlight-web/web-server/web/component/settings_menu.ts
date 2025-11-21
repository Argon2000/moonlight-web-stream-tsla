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
        bitrate: 4000,
        packetSize: 512,
        fps: 60,
        videoSampleQueueSize: 3,
        videoSize: "custom", // Cannot change dropdownlist in Tesla browser
        videoSizeCustom: {
            width: 1280,
            height: 720,
        },
        dontForceH264: true,
        canvasRenderer: true,
        playAudioLocal: false,
        audioSampleQueueSize: 6,
        mouseScrollMode: "highres",
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

    private sidebarHeader: HTMLHeadingElement = document.createElement("h2")
    private sidebarEdge: SelectComponent

    private streamHeader: HTMLHeadingElement = document.createElement("h2")
    private bitrate: InputComponent
    private packetSize: InputComponent
    private fps: InputComponent
    private forceH264: InputComponent
    private canvasRenderer: InputComponent

    private videoSize: SelectComponent
    private videoSizeWidth: InputComponent
    private videoSizeHeight: InputComponent

    private videoSampleQueueSize: InputComponent

    private audioHeader: HTMLHeadingElement = document.createElement("h2")
    private playAudioLocal: InputComponent
    private audioSampleQueueSize: InputComponent

    private mouseHeader: HTMLHeadingElement = document.createElement("h2")
    private mouseScrollMode: SelectComponent

    private controllerHeader: HTMLHeadingElement = document.createElement("h2")
    private controllerInvertAB: InputComponent
    private controllerInvertXY: InputComponent

    private otherHeader: HTMLHeadingElement = document.createElement("h2")
    private toggleFullscreenWithKeybind: InputComponent

    constructor(settings?: StreamSettings) {
        const defaultSettings = defaultStreamSettings()

        // Root div
        this.divElement.classList.add("settings")

        // Sidebar
        this.sidebarHeader.innerText = "Sidebar"
        this.divElement.appendChild(this.sidebarHeader)

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
        this.sidebarEdge.mount(this.divElement)

        // Video
        this.streamHeader.innerText = "Video"
        this.divElement.appendChild(this.streamHeader)

        // Bitrate
        this.bitrate = new InputComponent("bitrate", "number", "Bitrate", {
            defaultValue: defaultSettings.bitrate.toString(),
            value: settings?.bitrate?.toString(),
            step: "100",
        })
        this.bitrate.addChangeListener(this.onSettingsChange.bind(this))
        this.bitrate.mount(this.divElement)

        // Packet Size
        this.packetSize = new InputComponent("packetSize", "number", "Packet Size", {
            defaultValue: defaultSettings.packetSize.toString(),
            value: settings?.packetSize?.toString(),
            step: "100"
        })
        this.packetSize.addChangeListener(this.onSettingsChange.bind(this))
        this.packetSize.mount(this.divElement)

        // Fps
        this.fps = new InputComponent("fps", "number", "Fps", {
            defaultValue: defaultSettings.fps.toString(),
            value: settings?.fps?.toString(),
            step: "100"
        })
        this.fps.addChangeListener(this.onSettingsChange.bind(this))
        this.fps.mount(this.divElement)

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
        this.videoSize.mount(this.divElement)

        this.videoSizeWidth = new InputComponent("videoSizeWidth", "number", "Video Width", {
            defaultValue: defaultSettings.videoSizeCustom.width.toString(),
            value: settings?.videoSizeCustom.width.toString()
        })
        this.videoSizeWidth.addChangeListener(this.onSettingsChange.bind(this))
        this.videoSizeWidth.mount(this.divElement)

        this.videoSizeHeight = new InputComponent("videoSizeHeight", "number", "Video Height", {
            defaultValue: defaultSettings.videoSizeCustom.height.toString(),
            value: settings?.videoSizeCustom.height.toString()
        })
        this.videoSizeHeight.addChangeListener(this.onSettingsChange.bind(this))
        this.videoSizeHeight.mount(this.divElement)

        // Video Sample Queue Size
        this.videoSampleQueueSize = new InputComponent("videoSampleQueueSize", "number", "Video Sample Queue Size", {
            defaultValue: defaultSettings.videoSampleQueueSize.toString(),
            value: settings?.videoSampleQueueSize?.toString()
        })
        this.videoSampleQueueSize.addChangeListener(this.onSettingsChange.bind(this))
        this.videoSampleQueueSize.mount(this.divElement)

        // Force H264
        this.forceH264 = new InputComponent("dontForceH264", "checkbox", "Select Codec based on Support in Browser (Experimental)", {
            defaultValue: defaultSettings.dontForceH264.toString(),
            checked: settings?.dontForceH264
        })
        this.forceH264.addChangeListener(this.onSettingsChange.bind(this))
        this.forceH264.mount(this.divElement)

        // Use Canvas Renderer
        this.canvasRenderer = new InputComponent("canvasRenderer", "checkbox", "Use Canvas Renderer (Experimental)", {
            defaultValue: defaultSettings.canvasRenderer.toString(),
            checked: settings?.canvasRenderer ?? defaultSettings.canvasRenderer
        })
        this.canvasRenderer.addChangeListener(this.onSettingsChange.bind(this))
        this.canvasRenderer.mount(this.divElement)

        // Audio local
        this.audioHeader.innerText = "Audio"
        this.divElement.appendChild(this.audioHeader)

        this.playAudioLocal = new InputComponent("playAudioLocal", "checkbox", "Play Audio Local", {
            checked: settings?.playAudioLocal ?? defaultSettings.playAudioLocal
        })
        this.playAudioLocal.addChangeListener(this.onSettingsChange.bind(this))
        this.playAudioLocal.mount(this.divElement)

        // Audio Sample Queue Size
        this.audioSampleQueueSize = new InputComponent("audioSampleQueueSize", "number", "Audio Sample Queue Size", {
            defaultValue: defaultSettings.audioSampleQueueSize.toString(),
            value: settings?.audioSampleQueueSize?.toString()
        })
        this.audioSampleQueueSize.addChangeListener(this.onSettingsChange.bind(this))
        this.audioSampleQueueSize.mount(this.divElement)

        // Mouse
        this.mouseHeader.innerText = "Mouse"
        this.divElement.appendChild(this.mouseHeader)

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
        this.mouseScrollMode.mount(this.divElement)

        // Controller
        if (window.isSecureContext) {
            this.controllerHeader.innerText = "Controller"
        } else {
            this.controllerHeader.innerText = "Controller (Disabled: Secure Context Required)"
        }
        this.divElement.appendChild(this.controllerHeader)

        this.controllerInvertAB = new InputComponent("controllerInvertAB", "checkbox", "Invert A and B", {
            checked: settings?.controllerConfig.invertAB ?? defaultSettings.controllerConfig.invertAB
        })
        this.controllerInvertAB.addChangeListener(this.onSettingsChange.bind(this))
        this.controllerInvertAB.mount(this.divElement)

        this.controllerInvertXY = new InputComponent("controllerInvertXY", "checkbox", "Invert X and Y", {
            checked: settings?.controllerConfig.invertXY ?? defaultSettings.controllerConfig.invertXY
        })
        this.controllerInvertXY.addChangeListener(this.onSettingsChange.bind(this))
        this.controllerInvertXY.mount(this.divElement)

        if (!window.isSecureContext) {
            this.controllerInvertAB.setEnabled(false)
            this.controllerInvertXY.setEnabled(false)
        }

        // Other
        this.otherHeader.innerText = "Other"
        this.divElement.appendChild(this.otherHeader)

        this.toggleFullscreenWithKeybind = new InputComponent("toggleFullscreenWithKeybind", "checkbox", "Toggle Fullscreen and Mouse Lock with Ctrl + Shift + I", {
            checked: settings?.toggleFullscreenWithKeybind
        })
        this.toggleFullscreenWithKeybind.addChangeListener(this.onSettingsChange.bind(this))
        this.toggleFullscreenWithKeybind.mount(this.divElement)

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