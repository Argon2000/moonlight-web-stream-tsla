import { App, DeleteHostQuery, DetailedHost, GetAppImageQuery, GetAppsQuery, GetAppsResponse, GetHostQuery, GetHostResponse, GetHostsResponse, PostCancelRequest, PostCancelResponse, PostPairRequest, PostPairResponse1, PostPairResponse2, PostWakeUpRequest, PutHostRequest, PutHostResponse, UndetailedHost } from "./api_bindings.js";
import { showErrorPopup } from "./component/error.js";
import { InputComponent } from "./component/input.js";
import { FormModal } from "./component/modal/form.js";
import { showMessage, showModal } from "./component/modal/index.js";
import { buildUrl, isCredentialAuthenticationEnabled } from "./config_.js";

// IMPORTANT: this should be a bit bigger than the moonlight-common reqwest backend timeout if some hosts are offline!
const API_TIMEOUT = 6000

/** Sessions persist for 90 days in localStorage. */
const SESSION_DURATION_MS = 90 * 24 * 60 * 60 * 1000
const SESSION_STORAGE_KEY = "mlSession"

type StoredSession = { token: string; expires_at_ms: number }

function getStoredSession(): StoredSession | null {
    try {
        const raw = localStorage.getItem(SESSION_STORAGE_KEY)
        if (!raw) return null
        const session = JSON.parse(raw) as StoredSession
        if (session.expires_at_ms <= Date.now()) {
            localStorage.removeItem(SESSION_STORAGE_KEY)
            return null
        }
        return session
    } catch {
        localStorage.removeItem(SESSION_STORAGE_KEY)
        return null
    }
}

function storeSession(token: string, expires_at_ms: number) {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token, expires_at_ms } satisfies StoredSession))
}

// ---------------------------------------------------------------------------
// Login API helpers
// ---------------------------------------------------------------------------

type LoginResult =
    | { session_token: string; expires_at_ms: number }
    | { requires_totp: boolean }
    | { error: "invalid_credentials" | "server_error" }

async function postLogin(
    host_url: string,
    password: string,
    totp_code?: string,
): Promise<LoginResult> {
    try {
        const body: Record<string, string> = { password }
        if (totp_code) body["totp_code"] = totp_code

        const response = await fetch(`${host_url}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(API_TIMEOUT),
        })

        if (response.status === 401) return { error: "invalid_credentials" }
        if (!response.ok) return { error: "server_error" }

        return await response.json() as LoginResult
    } catch {
        return { error: "server_error" }
    }
}

export type AuthInfo = { totp_enabled: boolean; credential_authentication_enabled: boolean }

export async function apiGetAuthInfo(api: Api): Promise<AuthInfo | null> {
    try {
        const response = await fetch(`${api.host_url}/auth/info`, {
            signal: AbortSignal.timeout(API_TIMEOUT),
        })
        if (!response.ok) return null
        return await response.json() as AuthInfo
    } catch {
        return null
    }
}

export async function apiGetTotpSetup(api: Api): Promise<{ secret: string; uri: string } | null> {
    try {
        return await fetchApi(api, "/auth/totp/setup", "get")
    } catch {
        return null
    }
}

export async function apiEnableTotp(api: Api, code: string): Promise<"ok" | "invalid_code" | "error"> {
    try {
        const response = await fetchApi(api, "/auth/totp/enable", "post", {
            json: { code },
            response: "ignore",
        }) as Response
        if (response.status === 400) return "invalid_code"
        return "ok"
    } catch (e) {
        if (e instanceof FetchError) {
            const r = e.getResponse()
            if (r && r.status === 400) return "invalid_code"
        }
        return "error"
    }
}

export async function apiDisableTotp(api: Api): Promise<boolean> {
    try {
        await fetchApi(api, "/auth/totp", "delete", { response: "ignore" })
        return true
    } catch {
        return false
    }
}

// ---------------------------------------------------------------------------
// getApi — main entry point
// ---------------------------------------------------------------------------

let currentApi: Api | null = null

export async function getApi(host_url?: string): Promise<Api> {
    if (currentApi) {
        return currentApi
    }

    if (!host_url) {
        host_url = buildUrl("/api")
    }

    if (!isCredentialAuthenticationEnabled()) {
        currentApi = { host_url, credentials: null }
        return currentApi
    }

    // Try to reuse a stored session
    const stored = getStoredSession()
    if (stored) {
        const candidate: Api = { host_url, credentials: stored.token }
        if (await apiAuthenticate(candidate)) {
            currentApi = candidate
            return currentApi
        }
        // Token rejected — server may have restarted; clear and re-login
        localStorage.removeItem(SESSION_STORAGE_KEY)
    }

    // Interactive login loop
    while (true) {
        const loginModal = new LoginModal()
        const creds = await showModal(loginModal)

        if (creds == null) {
            // User cancelled; keep showing the modal
            continue
        }

        const { password, totp_code } = creds

        // Step 1: password (+ optional TOTP if user already entered one)
        let result = await postLogin(host_url, password, totp_code || undefined)

        if ("error" in result) {
            if (result.error === "invalid_credentials") {
                await showMessage("Invalid credentials")
            } else {
                await showMessage("Server error — could not log in")
            }
            continue
        }

        // Server needs TOTP code
        if ("requires_totp" in result && result.requires_totp) {
            const totpModal = new TotpModal()
            const code = await showModal(totpModal)
            if (code == null) continue

            result = await postLogin(host_url, password, code)

            if ("error" in result) {
                if (result.error === "invalid_credentials") {
                    await showMessage("Invalid authenticator code")
                } else {
                    await showMessage("Server error — could not log in")
                }
                continue
            }
        }

        if ("session_token" in result) {
            storeSession(result.session_token, result.expires_at_ms)
            currentApi = { host_url, credentials: result.session_token }
            return currentApi
        }
    }
}

// ---------------------------------------------------------------------------
// Login modal — password field (+ optional inline TOTP field)
// ---------------------------------------------------------------------------

class LoginModal extends FormModal<{ password: string; totp_code: string }> {
    private passwordInput: InputComponent
    private totpInput: InputComponent

    constructor() {
        super()
        this.passwordInput = new InputComponent("ml-login-password", "password", "Password")
        this.totpInput = new InputComponent("ml-login-totp", "text", "2FA Code (if enabled)", {
            inputMode: "numeric",
        })
    }

    reset(): void {
        this.passwordInput.reset()
        this.totpInput.reset()
    }

    submit(): { password: string; totp_code: string } | null {
        const password = this.passwordInput.getValue()
        if (!password) return null
        return { password, totp_code: this.totpInput.getValue() }
    }

    mountForm(form: HTMLFormElement): void {
        const title = document.createElement("h3")
        title.innerText = "Sign In"
        form.appendChild(title)
        this.passwordInput.mount(form)
        this.totpInput.mount(form)
    }
}

// ---------------------------------------------------------------------------
// TOTP modal — for the 2-step login flow when server says requires_totp
// ---------------------------------------------------------------------------

class TotpModal extends FormModal<string> {
    private codeInput: InputComponent

    constructor() {
        super()
        this.codeInput = new InputComponent("ml-totp-code", "text", "Authenticator Code", {
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
        title.innerText = "Two-Factor Authentication"
        const hint = document.createElement("p")
        hint.innerText = "Enter the 6-digit code from your authenticator app."
        form.appendChild(title)
        form.appendChild(hint)
        this.codeInput.mount(form)
    }
}

export type Api = {
    host_url: string
    credentials: string | null,
}

export type ApiFetchInit = {
    json?: any,
    query?: any,
    noTimeout?: boolean,
}

export function isDetailedHost(host: UndetailedHost | DetailedHost): host is DetailedHost {
    return (host as DetailedHost).https_port !== undefined
}

function buildRequest(api: Api, endpoint: string, method: string, init?: { response?: "json" | "ignore" } & ApiFetchInit): [string, RequestInit] {
    const query = new URLSearchParams(init?.query)
    const queryString = query.size > 0 ? `?${query.toString()}` : "";
    const url = `${api.host_url}${endpoint}${queryString}`

    const headers: any = {
    };

    if (isCredentialAuthenticationEnabled()) {
        headers["Authorization"] = `Bearer ${api.credentials}`;
    }

    if (init?.json) {
        headers["Content-Type"] = "application/json";
    }

    const request = {
        method: method,
        headers,
        body: init?.json && JSON.stringify(init.json)
    }

    return [url, request]
}

export class FetchError extends Error {
    private response?: Response
    private _errorType: "timeout" | "failed"

    constructor(type: "timeout", endpoint: string, method: string)
    constructor(type: "failed", endpoint: string, method: string, response: Response)

    constructor(type: "timeout" | "failed", endpoint: string, method: string, response?: Response) {
        if (type == "timeout") {
            super(`Request timed out: ${method.toUpperCase()} ${endpoint}`)
        } else {
            super(`Request failed (${response?.status}): ${method.toUpperCase()} ${endpoint}`)
        }

        this._errorType = type
        this.response = response
    }

    get errorType(): "timeout" | "failed" { return this._errorType }

    getResponse(): Response | null {
        return this.response ?? null
    }

    /** Return a user-friendly description of the error. */
    toUserMessage(): string {
        if (this._errorType === "timeout") {
            return "Request timed out — check your network connection"
        }
        const status = this.response?.status
        if (status === 404) return "Host not found or unreachable"
        if (status === 400) return "Invalid request — check the address and port"
        if (status === 401) return "Authentication required"
        if (status === 403) return "Access denied"
        if (status && status >= 500) return "Server error — try again later"
        return this.message
    }
}

export async function fetchApi(api: Api, endpoint: string, method: string, init?: { response?: "json" } & ApiFetchInit): Promise<any>
export async function fetchApi(api: Api, endpoint: string, method: string, init: { response: "ignore" } & ApiFetchInit): Promise<Response>

export async function fetchApi(api: Api, endpoint: string, method: string = "get", init?: { response?: "json" | "ignore" } & ApiFetchInit) {
    const [url, request] = buildRequest(api, endpoint, method, init)

    const timeoutAbort = new AbortController()
    request.signal = timeoutAbort.signal
    if (!init?.noTimeout) {
        setTimeout(() => timeoutAbort.abort(
            new FetchError("timeout", endpoint, method)
        ), API_TIMEOUT)
    }

    let response: Response
    try {
        response = await fetch(url, request)
    } catch (e) {
        // Translate AbortError into the FetchError stored as the abort reason
        if (timeoutAbort.signal.aborted && timeoutAbort.signal.reason instanceof FetchError) {
            throw timeoutAbort.signal.reason
        }
        throw e
    }

    if (!response.ok) {
        throw new FetchError("failed", endpoint, method, response)
    }

    if (init?.response == "ignore") {
        return response
    }

    if (init?.response == undefined || init.response == "json") {
        const json = await response.json()

        return json
    }
}

// ---------------------------------------------------------------------------
// Retry wrapper — retries on timeout/network errors with exponential backoff.
// Does NOT retry on 4xx (client errors).
// ---------------------------------------------------------------------------

async function fetchApiWithRetry(
    api: Api,
    endpoint: string,
    method: string,
    init?: { response?: "json" | "ignore" } & ApiFetchInit,
    maxRetries: number = 2,
): Promise<any> {
    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fetchApi(api, endpoint, method, init as any)
        } catch (e) {
            lastError = e
            // Don't retry on client errors (4xx)
            if (e instanceof FetchError) {
                const r = e.getResponse()
                if (r && r.status >= 400 && r.status < 500) {
                    throw e
                }
            }
            if (attempt < maxRetries) {
                const delay = 1000 * Math.pow(2, attempt) // 1s, 2s
                await new Promise(resolve => setTimeout(resolve, delay))
            }
        }
    }
    throw lastError
}

export async function apiAuthenticate(api: Api): Promise<boolean> {
    let response
    try {
        response = await fetchApi(api, "/authenticate", "get", { response: "ignore" })
    } catch (e) {
        if (e instanceof FetchError) {
            const response = e.getResponse()
            if (response && response.status == 401) {
                return false
            } else {
                showErrorPopup(e.message)
                return false
            }
        }
        throw e
    }

    return response != null
}

export async function apiGetHosts(api: Api): Promise<Array<UndetailedHost>> {
    const response = await fetchApiWithRetry(api, "/hosts", "get")

    return (response as GetHostsResponse).hosts
}
export async function apiGetHost(api: Api, query: GetHostQuery): Promise<DetailedHost> {
    const response = await fetchApiWithRetry(api, "/host", "get", { query })

    return (response as GetHostResponse).host
}
export async function apiPutHost(api: Api, data: PutHostRequest): Promise<DetailedHost> {
    const response = await fetchApi(api, "/host", "put", { json: data })

    return (response as PutHostResponse).host
}
export async function apiDeleteHost(api: Api, query: DeleteHostQuery): Promise<boolean> {
    try {
        await fetchApi(api, "/host", "delete", { query, response: "ignore" })
    } catch (e) {
        return false
    }

    return true
}

export async function apiPostPair(api: Api, request: PostPairRequest): Promise<{ pin: string, result: Promise<DetailedHost> }> {
    const response = await fetchApi(api, "/pair", "post", {
        json: request,
        response: "ignore",
        noTimeout: true
    })
    if (!response.body) {
        throw "no response body in pair response"
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    const read1 = await reader.read();
    const response1 = JSON.parse(decoder.decode(read1.value)) as PostPairResponse1

    if (typeof response1 == "string") {
        throw `failed to pair: ${response1}`
    }
    if (read1.done) {
        throw "failed to pair: InternalServerError"
    }

    return {
        pin: response1.Pin,
        result: (async () => {
            const read2 = await reader.read();
            const response2 = JSON.parse(decoder.decode(read2.value)) as PostPairResponse2

            if (response2 == "PairError") {
                throw "failed to pair"
            } else {
                return response2.Paired
            }
        })()
    }
}

export async function apiWakeUp(api: Api, request: PostWakeUpRequest): Promise<void> {
    await fetchApi(api, "/host/wake", "post", {
        json: request,
        response: "ignore"
    })
}

export async function apiGetApps(api: Api, query: GetAppsQuery): Promise<Array<App>> {
    const response = await fetchApi(api, "/apps", "get", { query }) as GetAppsResponse

    return response.apps
}

export async function apiGetAppImage(api: Api, query: GetAppImageQuery): Promise<Blob> {
    const response = await fetchApi(api, "/app/image", "get", {
        query,
        response: "ignore"
    })

    return await response.blob()
}

export async function apiHostCancel(api: Api, request: PostCancelRequest): Promise<PostCancelResponse> {
    const response = await fetchApi(api, "/host/cancel", "POST", {
        json: request
    })

    return response as PostCancelResponse
}

/** Clear the stored session and force a fresh login on next load. */
export function logout() {
    localStorage.removeItem(SESSION_STORAGE_KEY)
    currentApi = null
}