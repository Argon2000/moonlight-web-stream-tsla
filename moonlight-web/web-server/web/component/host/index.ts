import { DetailedHost, UndetailedHost } from "../../api_bindings.js"
import { Api, apiDeleteHost, apiGetHost, isDetailedHost, apiPostPair, apiWakeUp } from "../../api.js"
import { Component, ComponentEvent } from "../index.js"
import { setContextMenu } from "../context_menu.js"
import { showErrorPopup } from "../error.js"
import { showMessage } from "../modal/index.js"
import { HOST_IMAGE, HOST_OVERLAY_LOCK, HOST_OVERLAY_NONE, HOST_OVERLAY_OFFLINE } from "../../resources/index.js"

export type HostEventListener = (event: ComponentEvent<Host>) => void

export class Host implements Component {
    private api: Api

    private hostId: number
    private cache: UndetailedHost | DetailedHost | null = null

    private divElement: HTMLDivElement = document.createElement("div")

    private imageElement: HTMLImageElement = document.createElement("img")
    private imageOverlayElement: HTMLImageElement = document.createElement("img")
    private nameElement: HTMLElement = document.createElement("p")

    constructor(api: Api, hostId: number, host: UndetailedHost | DetailedHost | null) {
        this.api = api

        this.hostId = hostId
        this.cache = host

        // Configure image
        this.imageElement.classList.add("host-image")
        this.imageElement.src = HOST_IMAGE

        // Configure image overlay
        this.imageOverlayElement.classList.add("host-image-overlay")

        // Configure name
        this.nameElement.classList.add("host-name")

        // Append elements
        this.divElement.appendChild(this.imageElement)
        this.divElement.appendChild(this.imageOverlayElement)
        this.divElement.appendChild(this.nameElement)

        this.divElement.addEventListener("click", this.onClick.bind(this))
        this.divElement.addEventListener("contextmenu", this.onContextMenu.bind(this))

        // Update cache
        if (host != null) {
            this.updateCache(host)
        } else {
            this.forceFetch(false)
        }
    }

    async forceFetch(forceServerRefresh?: boolean) {
        const newCache = await apiGetHost(this.api, {
            host_id: this.hostId,
            force_refresh: forceServerRefresh || false
        })

        this.updateCache(newCache)
    }
    async getCurrentGame(): Promise<number | null> {
        await this.forceFetch(true)

        if (this.cache && isDetailedHost(this.cache) && this.cache.current_game != 0) {
            return this.cache.current_game
        } else {
            return null
        }
    }

    private async onClick(event: MouseEvent) {
        if (this.cache?.server_state == null) {
            this.onContextMenu(event)
        } else if (this.cache?.paired == "Paired") {
            this.divElement.dispatchEvent(new ComponentEvent("ml-hostopen", this))
        } else {
            await this.pair()
        }
    }

    private onContextMenu(event: MouseEvent) {
        const elements = []

        if (this.cache?.server_state != null) {
            elements.push({
                name: "Show Details",
                callback: this.showDetails.bind(this),
            })
        } else {
            elements.push({
                name: "Send Wake Up Packet",
                callback: this.wakeUp.bind(this)
            })
        }

        elements.push({
            name: "Reload",
            callback: async () => this.forceFetch(true)
        })

        if (this.cache?.paired == "NotPaired") {
            elements.push({
                name: "Pair",
                callback: this.pair.bind(this)
            })
        }

        elements.push({
            name: "Remove Host",
            callback: this.remove.bind(this)
        })

        setContextMenu(event, {
            elements
        })
    }

    private async showDetails() {
        let host = this.cache;
        if (!host || !isDetailedHost(host)) {
            host = await apiGetHost(this.api, {
                host_id: this.hostId,
                force_refresh: false
            })
        }
        if (!host || !isDetailedHost(host)) {
            showErrorPopup(`failed to get details for host ${this.hostId}`)
            return;
        }
        this.updateCache(host)

        await showMessage(
            `Web Id: ${host.host_id}\n` +
            `Name: ${host.name}\n` +
            `Pair Status: ${host.paired}\n` +
            `State: ${host.server_state}\n` +
            `Address: ${host.address}\n` +
            `Http Port: ${host.http_port}\n` +
            `Https Port: ${host.https_port}\n` +
            `External Port: ${host.external_port}\n` +
            `Version: ${host.version}\n` +
            `Gfe Version: ${host.gfe_version}\n` +
            `Unique ID: ${host.unique_id}\n` +
            `MAC: ${host.mac}\n` +
            `Local IP: ${host.local_ip}\n` +
            `Current Game: ${host.current_game}\n` +
            `Max Luma Pixels Hevc: ${host.max_luma_pixels_hevc}\n` +
            `Server Codec Mode Support: ${host.server_codec_mode_support}`
        )
    }

    addHostRemoveListener(listener: HostEventListener, options?: EventListenerOptions) {
        this.divElement.addEventListener("ml-hostremove", listener as any, options)
    }
    removeHostRemoveListener(listener: HostEventListener, options?: EventListenerOptions) {
        this.divElement.removeEventListener("ml-hostremove", listener as any, options)
    }

    addHostOpenListener(listener: HostEventListener, options?: EventListenerOptions) {
        this.divElement.addEventListener("ml-hostopen", listener as any, options)
    }
    removeHostOpenListener(listener: HostEventListener, options?: EventListenerOptions) {
        this.divElement.removeEventListener("ml-hostopen", listener as any, options)
    }

    private async remove() {
        const success = await apiDeleteHost(this.api, {
            host_id: this.getHostId()
        })

        if (!success) {
            showErrorPopup(`something went wrong whilst removing the host ${this.getHostId()}`)
        }
        this.divElement.dispatchEvent(new ComponentEvent("ml-hostremove", this))
    }
    private async wakeUp() {
        await apiWakeUp(this.api, {
            host_id: this.getHostId()
        })

        await showMessage("Sent Wake Up packet. It might take a moment for your pc to start.")
    }
    private async pair() {
        if (this.cache?.paired == "Paired") {
            await this.forceFetch()

            if (this.cache?.paired == "Paired") {
                showMessage("This host is already paired!")
                return;
            }
        }

        const pinResponse = await apiPostPair(this.api, {
            host_id: this.getHostId()
        })

        const messageAbort = new AbortController()
        showMessage(`Please pair your host ${this.getCache()?.name} with this pin:\nPin: ${pinResponse.pin}`, { signal: messageAbort.signal })

        const resultResponse = await pinResponse.result
        messageAbort.abort()

        this.updateCache(resultResponse)
    }

    getHostId(): number {
        return this.hostId
    }

    getCache(): DetailedHost | UndetailedHost | null {
        return this.cache
    }

    updateCache(host: UndetailedHost | DetailedHost) {
        if (this.getHostId() != host.host_id) {
            showErrorPopup(`tried to overwrite host ${this.getHostId()} with data from ${host.host_id}`)
            return
        }

        if (this.cache == null) {
            this.cache = host
        } else {
            // if server_state == null it means this host is offline
            // -> updating cache means setting it to offline
            if (this.cache.server_state != null) {
                Object.assign(this.cache, host)
            } else {
                this.cache = host
            }
        }

        // Update Elements
        this.nameElement.innerText = this.cache.name

        if (this.cache.server_state == null) {
            this.imageOverlayElement.src = HOST_OVERLAY_OFFLINE
        } else if (this.cache.paired != "Paired") {
            this.imageOverlayElement.src = HOST_OVERLAY_LOCK
        } else {
            this.imageOverlayElement.src = HOST_OVERLAY_NONE
        }
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.divElement)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.divElement)
    }
}