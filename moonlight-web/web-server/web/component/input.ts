import { Component, ComponentEvent } from "./index.js"

export class ElementWithLabel implements Component {
    protected div: HTMLDivElement = document.createElement("div")
    protected label: HTMLLabelElement = document.createElement("label")

    constructor(internalName: string, displayName?: string) {
        if (displayName) {
            this.label.htmlFor = internalName
            this.label.innerText = displayName
            this.div.appendChild(this.label)
        }
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.div)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.div)
    }
}

export type InputInit = {
    defaultValue?: string
    value?: string
    checked?: boolean
    step?: string
    accept?: string
    inputMode?: string
}

export type InputChangeListener = (event: ComponentEvent<InputComponent>) => void

export class InputComponent extends ElementWithLabel {

    private fileLabel: HTMLDivElement | null = null
    private input: HTMLInputElement = document.createElement("input")

    constructor(internalName: string, type: string, displayName?: string, init?: InputInit) {
        super(internalName, displayName)

        this.div.classList.add("input-div")
        this.div.classList.add(`input-type-${type}`)

        this.input.id = internalName
        this.input.type = type
        if (init?.defaultValue != null) {
            this.input.defaultValue = init.defaultValue
        }
        if (init?.value != null) {
            this.input.value = init.value
        }
        if (init && init.checked != null) {
            this.input.checked = init.checked
        }
        if (init && init.step != null) {
            this.input.step = init.step
        }
        if (init && init.accept != null) {
            this.input.accept = init.accept
        }
        if (init && init.inputMode != null) {
            this.input.inputMode = init.inputMode
        }

        if (type == "file") {
            this.fileLabel = document.createElement("div")
            this.fileLabel.innerText = this.label.innerText
            this.fileLabel.classList.add("file-label")

            this.label.innerText = "Open File"
            this.label.classList.add("file-button")

            this.div.insertBefore(this.fileLabel, this.label)
        }

        this.div.appendChild(this.input)

        this.input.addEventListener("change", () => {
            this.div.dispatchEvent(new ComponentEvent("ml-change", this))
        })
    }

    reset() {
        this.input.value = ""
    }

    getValue(): string {
        return this.input.value
    }

    isChecked(): boolean {
        return this.input.checked
    }

    getFiles(): FileList | null {
        return this.input.files
    }

    setEnabled(enabled: boolean) {
        this.input.disabled = !enabled
    }

    addChangeListener(listener: InputChangeListener, options?: AddEventListenerOptions) {
        this.div.addEventListener("ml-change", listener as any, options)
    }
    removeChangeListener(listener: InputChangeListener) {
        this.div.removeEventListener("ml-change", listener as any)
    }
}

export type SelectInit = {
    // Only uses datalist if supported
    hasSearch?: boolean
    preSelectedOption?: string
    displayName?: string,
}

export class SelectComponent extends ElementWithLabel {

    private strategy: "buttons" | "datalist"

    private preSelectedOption: string = ""
    private options: Array<{ value: string, name: string }>

    private inputElement: null | HTMLInputElement
    private optionRoot: HTMLDivElement | HTMLDataListElement

    constructor(internalName: string, options: Array<{ value: string, name: string }>, init?: SelectInit) {
        super(internalName, init?.displayName)

        if (init && init.preSelectedOption) {
            this.preSelectedOption = init.preSelectedOption
        }
        this.options = options

        if (init && init.hasSearch && isElementSupported("datalist")) {
            this.strategy = "datalist"

            this.optionRoot = document.createElement("datalist")
            this.optionRoot.id = `${internalName}-list`

            this.inputElement = document.createElement("input")
            this.inputElement.type = "text"
            this.inputElement.id = internalName
            this.inputElement.setAttribute("list", this.optionRoot.id)

            if (init && init.preSelectedOption) {
                this.inputElement.defaultValue = init.preSelectedOption
            }

            this.div.appendChild(this.inputElement)
            this.div.appendChild(this.optionRoot)

            for (const option of options) {
                const optionElement = document.createElement("option")
                optionElement.value = option.name
                this.optionRoot.appendChild(optionElement)
            }

            this.inputElement.addEventListener("change", () => {
                this.div.dispatchEvent(new ComponentEvent("ml-change", this))
            })

        } else {
            this.strategy = "buttons"

            this.inputElement = null

            this.optionRoot = document.createElement("div")
            this.optionRoot.id = internalName
            this.optionRoot.classList.add("select-button-group")

            this.div.appendChild(this.optionRoot)

            for (const option of options) {
                const button = document.createElement("button")
                button.innerText = option.name
                button.dataset.value = option.value
                button.type = "button"
                button.classList.add("select-button")

                if (this.preSelectedOption == option.value) {
                    button.classList.add("selected")
                }

                button.addEventListener("click", () => {
                    const buttons = (this.optionRoot as HTMLDivElement).querySelectorAll(".select-button")
                    buttons.forEach(b => b.classList.remove("selected"))
                    button.classList.add("selected")
                    this.div.dispatchEvent(new ComponentEvent("ml-change", this))
                })

                this.optionRoot.appendChild(button)
            }
        }
    }

    reset() {
        if (this.strategy == "datalist") {
            const inputElement = (this.inputElement as HTMLInputElement)
            inputElement.value = ""
        } else {
            const buttons = (this.optionRoot as HTMLDivElement).querySelectorAll(".select-button")
            buttons.forEach(b => b.classList.remove("selected"))
        }
    }

    getValue(): string | null {
        if (this.strategy == "datalist") {
            const name = (this.inputElement as HTMLInputElement).value

            return this.options.find(option => option.name == name)?.value ?? ""
        } else if (this.strategy == "buttons") {
            const selected = (this.optionRoot as HTMLDivElement).querySelector(".select-button.selected") as HTMLButtonElement
            return selected ? selected.dataset.value! : null
        }

        throw "Invalid strategy for select input field"
    }

    setOptionEnabled(value: string, enabled: boolean) {
        if (this.strategy == "buttons") {
            const buttons = (this.optionRoot as HTMLDivElement).querySelectorAll(".select-button") as NodeListOf<HTMLButtonElement>
            for (const button of buttons) {
                if (button.dataset.value == value) {
                    button.disabled = !enabled
                }
            }
        }
    }

    addChangeListener(listener: InputChangeListener, options?: AddEventListenerOptions) {
        this.div.addEventListener("ml-change", listener as any, options)
    }
    removeChangeListener(listener: InputChangeListener) {
        this.div.removeEventListener("ml-change", listener as any)
    }
}

export function isElementSupported(tag: string) {
    // Create a test element for the tag
    const element = document.createElement(tag);

    // Check for support of custom elements registered via
    // `document.registerElement`
    if (tag.indexOf('-') > -1) {
        // Registered elements have their own constructor, while unregistered
        // ones use the `HTMLElement` or `HTMLUnknownElement` (if invalid name)
        // constructor (http://stackoverflow.com/a/28210364/1070244)
        return (
            element.constructor !== window.HTMLUnknownElement &&
            element.constructor !== window.HTMLElement
        );
    }

    // Obtain the element's internal [[Class]] property, if it doesn't 
    // match the `HTMLUnknownElement` interface than it must be supported
    return toString.call(element) !== '[object HTMLUnknownElement]';
};