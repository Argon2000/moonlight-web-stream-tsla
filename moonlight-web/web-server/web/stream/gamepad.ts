import { StreamControllerButton } from "../api_bindings.js"

export type ControllerConfig = {
    invertXY: boolean
    invertAB: boolean
}

// https://w3c.github.io/gamepad/#remapping
// W3C standard mapping: index 0=bottom, 1=right, 2=left, 3=top face button.
// We map by POSITION so all controllers behave the same:
//   bottom=A, right=B, left=X, top=Y (Xbox/Moonlight convention)
const STANDARD_BUTTONS = [
    StreamControllerButton.BUTTON_A,    // 0: bottom face button
    StreamControllerButton.BUTTON_B,    // 1: right face button
    StreamControllerButton.BUTTON_X,    // 2: left face button (was Y)
    StreamControllerButton.BUTTON_Y,    // 3: top face button (was X)
    StreamControllerButton.BUTTON_LB,
    StreamControllerButton.BUTTON_RB,
    // These are triggers
    null,
    null,
    StreamControllerButton.BUTTON_BACK,
    StreamControllerButton.BUTTON_PLAY,
    StreamControllerButton.BUTTON_LS_CLK,
    StreamControllerButton.BUTTON_RS_CLK,
    StreamControllerButton.BUTTON_UP,
    StreamControllerButton.BUTTON_DOWN,
    StreamControllerButton.BUTTON_LEFT,
    StreamControllerButton.BUTTON_RIGHT,
    StreamControllerButton.BUTTON_SPECIAL,
]

export const SUPPORTED_BUTTONS =
    StreamControllerButton.BUTTON_A | StreamControllerButton.BUTTON_B | StreamControllerButton.BUTTON_X | StreamControllerButton.BUTTON_Y | StreamControllerButton.BUTTON_UP | StreamControllerButton.BUTTON_DOWN | StreamControllerButton.BUTTON_LEFT | StreamControllerButton.BUTTON_RIGHT | StreamControllerButton.BUTTON_LB | StreamControllerButton.BUTTON_RB | StreamControllerButton.BUTTON_PLAY | StreamControllerButton.BUTTON_BACK | StreamControllerButton.BUTTON_LS_CLK | StreamControllerButton.BUTTON_RS_CLK | StreamControllerButton.BUTTON_SPECIAL

function convertStandardButton(buttonIndex: number, config?: ControllerConfig): number | null {
    let button = STANDARD_BUTTONS[buttonIndex] ?? null

    if (config?.invertAB) {
        if (button == StreamControllerButton.BUTTON_A) {
            button = StreamControllerButton.BUTTON_B
        } else if (button == StreamControllerButton.BUTTON_B) {
            button = StreamControllerButton.BUTTON_A
        }
    }
    if (config?.invertXY) {
        if (button == StreamControllerButton.BUTTON_X) {
            button = StreamControllerButton.BUTTON_Y
        } else if (button == StreamControllerButton.BUTTON_Y) {
            button = StreamControllerButton.BUTTON_X
        }
    }

    return button
}

export type GamepadState = {
    buttonFlags: number
    leftTrigger: number
    rightTrigger: number
    leftStickX: number
    leftStickY: number
    rightStickX: number
    rightStickY: number
}

export function extractGamepadState(gamepad: Gamepad, config: ControllerConfig, out: GamepadState): GamepadState {
    // Tesla's virtual gamepad wraps Nintendo controllers and reports
    // mapping="standard", but maps buttons by LABEL not by POSITION.
    // Since Nintendo has A/B and X/Y in opposite positions vs Xbox,
    // we need to swap indices 0↔1 and 2↔3 to get position-based mapping.
    const needsTeslaSwap = /TESLA/i.test(gamepad.id)

    let buttonFlags = 0
    for (let buttonId = 0; buttonId < gamepad.buttons.length; buttonId++) {
        const button = gamepad.buttons[buttonId]
        if (!button) {
            continue
        }

        let mappedId = buttonId
        if (needsTeslaSwap) {
            if (buttonId === 0) mappedId = 1
            else if (buttonId === 1) mappedId = 0
            else if (buttonId === 2) mappedId = 3
            else if (buttonId === 3) mappedId = 2
        }

        const buttonFlag = convertStandardButton(mappedId, config)
        if (button.pressed && buttonFlag !== null) {
            buttonFlags |= buttonFlag
        }
    }

    out.buttonFlags = buttonFlags
    out.leftTrigger = gamepad.buttons[6]?.value ?? 0
    out.rightTrigger = gamepad.buttons[7]?.value ?? 0
    out.leftStickX = gamepad.axes[0] ?? 0
    out.leftStickY = gamepad.axes[1] ?? 0
    out.rightStickX = gamepad.axes[2] ?? 0
    out.rightStickY = gamepad.axes[3] ?? 0

    return out
}
