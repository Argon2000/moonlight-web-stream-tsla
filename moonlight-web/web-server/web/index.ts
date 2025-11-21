import { Api, getApi, apiPutHost, FetchError } from "./api.js";
import { AddHostModal } from "./component/host/add_modal.js";
import { HostList } from "./component/host/list.js";
import { Component, ComponentEvent } from "./component/index.js";
import { showErrorPopup } from "./component/error.js";
import { showModal } from "./component/modal/index.js";
import { setContextMenu } from "./component/context_menu.js";
import { GameList } from "./component/game/list.js";
import { Host } from "./component/host/index.js";
import { App } from "./api_bindings.js";
import { getLocalStreamSettings, setLocalStreamSettings, StreamSettingsComponent } from "./component/settings_menu.js";
import { setTouchContextMenuEnabled } from "./ios_right_click.js";

async function startApp() {
    setTouchContextMenuEnabled(true)

    const api = await getApi()

    const rootElement = document.getElementById("root");
    if (rootElement == null) {
        showErrorPopup("couldn't find root element", true)
        return;
    }

    const app = new MainApp(api)
    app.mount(rootElement)

    app.forceFetch()

    window.addEventListener("popstate", event => {
        app.setAppState(event.state)
    })
}

startApp()

type DisplayStates = "hosts" | "games" | "settings"

type AppState = { display: DisplayStates, hostId?: number }
function pushAppState(state: AppState) {
    history.pushState(state, "")
}

class MainApp implements Component {
    private api: Api
    private appContainer = document.createElement("div")
    private headerBar = document.createElement("div")
    private headerLeft = document.createElement("div")
    private headerCenter = document.createElement("div")
    private headerRight = document.createElement("div")
    private appContent = document.createElement("div")

    private moonlightTextElement = document.createElement("h1")

    private backToHostsButton: HTMLButtonElement = document.createElement("button")

    private hostAddButton: HTMLButtonElement = document.createElement("button")
    private settingsButton: HTMLButtonElement = document.createElement("button")

    private currentDisplay: DisplayStates | null = null

    private hostList: HostList
    private gameList: GameList | null = null
    private settings: StreamSettingsComponent

    constructor(api: Api) {
        this.api = api

        // Setup overall app structure
        this.appContainer.classList.add("app-container")
        this.headerBar.classList.add("header-bar")
        this.headerLeft.classList.add("header-left")
        this.headerCenter.classList.add("header-center")
        this.headerRight.classList.add("header-right")
        this.appContent.classList.add("app-content")

        this.appContainer.appendChild(this.headerBar)
        this.appContainer.appendChild(this.appContent)

        this.headerBar.appendChild(this.headerLeft)
        this.headerBar.appendChild(this.headerCenter)
        this.headerBar.appendChild(this.headerRight)

        // Moonlight title / Dynamic Header
        this.moonlightTextElement.innerHTML = "Moonlight Web"
        this.moonlightTextElement.classList.add("header-title")
        this.headerCenter.appendChild(this.moonlightTextElement)

        // Back button (left side)
        this.backToHostsButton.classList.add("back-button")
        this.backToHostsButton.innerHTML = "&larr;" // Left arrow icon
        this.backToHostsButton.style.display = "none"
        this.backToHostsButton.addEventListener("click", () => this.setCurrentDisplay("hosts"))
        this.headerLeft.appendChild(this.backToHostsButton)

        // Host add button (left side)
        this.hostAddButton.classList.add("host-add")
        this.hostAddButton.addEventListener("click", this.addHost.bind(this))
        this.headerLeft.appendChild(this.hostAddButton)

        // Settings Button (right side)
        this.settingsButton.classList.add("open-settings")
        this.settingsButton.addEventListener("click", () => this.setCurrentDisplay("settings"))
        this.headerRight.appendChild(this.settingsButton)

        // Initialize core components, they will be mounted to appContent
        this.hostList = new HostList(api)
        this.hostList.addHostOpenListener(this.onHostOpen.bind(this))

        this.settings = new StreamSettingsComponent(getLocalStreamSettings() ?? undefined)
        this.settings.addChangeListener(this.onSettingsChange.bind(this))

        this.setCurrentDisplay("hosts")

        // Context Menu
        document.body.addEventListener("contextmenu", this.onContextMenu.bind(this), { passive: false })
    }

    setAppState(state: AppState) {
        if (state.display == "hosts") {
            this.setCurrentDisplay("hosts")
        } else if (state.display == "games" && state.hostId != null) {
            this.setCurrentDisplay("games", state.hostId)
        } else if (state.display == "settings") {
            this.setCurrentDisplay("settings")
        }
    }

    private async addHost() {
        const modal = new AddHostModal()

        let host = await showModal(modal);

        if (host) {
            let newHost
            try {
                newHost = await apiPutHost(this.api, host)
            } catch (e) {
                if (e instanceof FetchError) {
                    const response = e.getResponse()
                    if (response && response.status == 400) {
                        showErrorPopup("couldn't add host: not found")
                        return
                    }
                }
                throw e
            }

            this.hostList.insertList(newHost.host_id, newHost)
        }
    }

    private onContextMenu(event: MouseEvent) {
        if (this.currentDisplay == "hosts" || this.currentDisplay == "games") {
            const elements = [
                {
                    name: "Reload",
                    callback: this.forceFetch.bind(this)
                }
            ]

            setContextMenu(event, {
                elements
            })
        }
    }

    private async onHostOpen(event: ComponentEvent<Host>) {
        const hostId = event.component.getHostId()

        this.setCurrentDisplay("games", hostId)
    }

    private onSettingsChange() {
        const newSettings = this.settings.getStreamSettings()

        setLocalStreamSettings(newSettings)
    }

    private setCurrentDisplay(display: "hosts"): void
    private setCurrentDisplay(display: "games", hostId: number, hostCache?: Array<App>): void
    private setCurrentDisplay(display: "settings"): void

    private setCurrentDisplay(display: "hosts" | "games" | "settings", hostId?: number | null, hostCache?: Array<App>) {
        if (display == "games" && hostId == null) {
            // invalid input state
            return
        }

        // Unmount the current display
        if (this.currentDisplay == "hosts") {
            this.hostList.unmount(this.appContent)
        } else if (this.currentDisplay == "games") {
            this.gameList?.unmount(this.appContent)
        } else if (this.currentDisplay == "settings") {
            this.settings.unmount(this.appContent)
        }

        // Mount the new display and update header
        if (display == "hosts") {
            this.moonlightTextElement.innerText = "Moonlight Web"
            this.backToHostsButton.style.display = "none"
            this.hostAddButton.style.display = "block"
            this.settingsButton.style.display = "block"

            this.hostList.mount(this.appContent)
            pushAppState({ display: "hosts" })
        } else if (display == "games" && hostId != null) {
            this.moonlightTextElement.innerText = "Games"
            this.backToHostsButton.style.display = "block"
            this.hostAddButton.style.display = "none"
            this.settingsButton.style.display = "none"

            if (this.gameList?.getHostId() != hostId) {
                this.gameList = new GameList(this.api, hostId, hostCache ?? null)
                this.gameList.addForceReloadListener(this.forceFetch.bind(this))
            }
            this.gameList.mount(this.appContent)
            this.refreshGameListActiveGame()
            pushAppState({ display: "games", hostId: this.gameList?.getHostId() })
        } else if (display == "settings") {
            this.moonlightTextElement.innerText = "Settings"
            this.backToHostsButton.style.display = "block"
            this.hostAddButton.style.display = "none"
            this.settingsButton.style.display = "none"

            this.settings.mount(this.appContent)
            pushAppState({ display: "settings" })
        }

        this.currentDisplay = display
    }

    async forceFetch() {
        await Promise.all([
            this.hostList.forceFetch(),
            this.gameList?.forceFetch(true)
        ])

        if (this.currentDisplay == "games"
            && this.gameList
            && !this.hostList.getHost(this.gameList.getHostId())) {
            // The newly fetched list doesn't contain the hosts game view we're in -> go to hosts
            this.setCurrentDisplay("hosts")
        }

        await this.refreshGameListActiveGame()
    }
    private async refreshGameListActiveGame() {
        const gameList = this.gameList
        const hostId = gameList?.getHostId()
        if (hostId == null) {
            return
        }

        const host = this.hostList.getHost(hostId)
        if (host == null) {
            return
        }

        const currentGame = await host.getCurrentGame()
        if (currentGame != null) {
            gameList?.setActiveGame(currentGame)
        } else {
            gameList?.setActiveGame(null)
        }
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.appContainer)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.appContainer)
    }
}