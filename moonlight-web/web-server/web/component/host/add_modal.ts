import { PutHostRequest } from "../../api_bindings.js"
import { InputComponent } from "../input.js"
import { FormModal } from "../modal/form.js"

export class AddHostModal extends FormModal<PutHostRequest> {

    private header: HTMLElement = document.createElement("h2")
    private errorText: HTMLElement = document.createElement("p")

    private address: InputComponent
    private httpPort: InputComponent

    constructor() {
        super()

        this.header.innerText = "Host"

        this.errorText.style.cssText = "color:#ff6b6b;font-size:0.85em;margin:0;min-height:1.2em;"
        this.errorText.innerText = ""

        this.address = new InputComponent("address", "text", "Address")

        this.httpPort = new InputComponent("httpPort", "text", "Port", {
            inputMode: "numeric"
        })
    }

    reset(): void {
        this.address.reset()
        this.httpPort.reset()
        this.errorText.innerText = ""
    }
    submit(): PutHostRequest | null {
        this.errorText.innerText = ""

        const address = this.address.getValue().trim()
        const portStr = this.httpPort.getValue().trim()

        if (!address) {
            this.errorText.innerText = "Address is required"
            return null
        }

        // Basic address sanity: reject obviously invalid characters
        if (/[^a-zA-Z0-9.\-:\[\]]/.test(address)) {
            this.errorText.innerText = "Address contains invalid characters"
            return null
        }

        let httpPort: number | undefined
        if (portStr) {
            httpPort = parseInt(portStr, 10)
            if (isNaN(httpPort) || httpPort < 1 || httpPort > 65535) {
                this.errorText.innerText = "Port must be a number between 1 and 65535"
                return null
            }
        }

        return {
            address,
            http_port: httpPort ?? null
        }
    }

    mountForm(form: HTMLFormElement): void {
        form.appendChild(this.header)
        
        const inputGroup = document.createElement("div")
        inputGroup.classList.add("add-host-input-group")

        this.address.mount(inputGroup)
        this.httpPort.mount(inputGroup)

        form.appendChild(inputGroup)
        form.appendChild(this.errorText)
    }
}