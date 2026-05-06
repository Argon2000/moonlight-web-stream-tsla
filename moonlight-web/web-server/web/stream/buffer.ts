
export const U8_MAX = 255

export const U16_MAX = 65535
export const I16_MAX = 32767

const sharedTextEncoder = new TextEncoder()

export class ByteBuffer {
    private position: number = 0
    private limit: number = 0
    private littleEndian: boolean
    private buffer: Uint8Array
    private view: DataView

    constructor(length?: number, littleEndian?: boolean)
    constructor(buffer: Uint8Array, littleEndian?: boolean)
    constructor(value?: number | Uint8Array, littleEndian?: boolean) {
        this.littleEndian = littleEndian ?? false

        if (value instanceof Uint8Array) {
            this.buffer = value
            this.limit = value.length
        } else {
            this.buffer = new Uint8Array(value ?? 0)
        }
        this.view = new DataView(this.buffer.buffer)
    }

    private bytesUsed(amount: number, reading: boolean) {
        this.position += amount
        if (reading && this.position > this.limit) {
            throw "failed to read over the limit"
        }
    }

    putU8Array(data: Array<number> | Uint8Array) {
        this.buffer.set(data, this.position)
        this.bytesUsed(data.length, false)
    }

    putU8(data: number) {
        this.view.setUint8(this.position, data)
        this.bytesUsed(1, false)
    }
    putBool(data: boolean) {
        this.putU8(data ? 1 : 0)
    }

    putI8(data: number) {
        this.view.setInt8(this.position, data)
        this.bytesUsed(1, false)
    }

    putU16(data: number) {
        this.view.setUint16(this.position, data, this.littleEndian)
        this.bytesUsed(2, false)
    }
    putI16(data: number) {
        this.view.setInt16(this.position, data, this.littleEndian)
        this.bytesUsed(2, false)
    }

    putU32(data: number) {
        this.view.setUint32(this.position, data, this.littleEndian)
        this.bytesUsed(4, false)
    }

    putUtf8(text: string) {
        const result = sharedTextEncoder.encodeInto(text, this.buffer.subarray(this.position))

        this.bytesUsed(result.written, false)
        if (result.read != text.length) {
            throw "failed to put utf8 text"
        }
    }

    putF32(data: number) {
        this.view.setFloat32(this.position, data, this.littleEndian)
        this.bytesUsed(4, false)
    }

    get(buffer: Uint8Array, offset: number, length: number) {
        buffer.set(this.buffer.subarray(this.position, this.position + length), offset)
        this.bytesUsed(length, true)
    }

    getU8(): number {
        const byte = this.view.getUint8(this.position)
        this.bytesUsed(1, true)
        return byte
    }
    getU16(): number {
        const byte = this.view.getUint16(this.position)
        this.bytesUsed(2, true)
        return byte
    }
    getBool(): boolean {
        return this.getU8() != 0
    }

    reset() {
        this.position = 0
        this.limit = 0
    }
    flip() {
        this.limit = this.position
        this.position = 0
    }
    isLittleEndian() {
        return this.littleEndian
    }
    getPosition() {
        return this.position
    }

    getReadBuffer(): Uint8Array {
        return this.buffer.slice(0, this.limit)
    }

    /** Returns a zero-copy view of the written data. Use with RTCDataChannel.send() which accepts ArrayBufferView. */
    getReadView(): Uint8Array {
        return this.buffer.subarray(0, this.limit)
    }
}