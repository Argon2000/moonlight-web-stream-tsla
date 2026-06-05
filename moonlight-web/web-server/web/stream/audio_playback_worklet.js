/**
 * AudioWorkletProcessor for stutter-free audio playback.
 * 
 * Unlike ScriptProcessorNode (main-thread callback), this runs on the
 * dedicated audio rendering thread at real-time priority. It cannot be
 * blocked by main-thread activity (DataChannel bursts, GC, rAF, etc.).
 * 
 * Architecture:
 *   Main thread posts decoded PCM Float32Arrays to this processor's port.
 *   process() pulls samples from an internal ring buffer and outputs them.
 *   If buffer is empty, it outputs silence (no stutter, just brief quiet).
 */
class PcmPlaybackProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // Ring buffer: 2 seconds at 48kHz — generous to absorb jitter/bursts
        this.ringSize = 96000;
        this.ringL = new Float32Array(this.ringSize);
        this.ringR = new Float32Array(this.ringSize);
        this.writePos = 0;
        this.readPos = 0;
        this.underruns = 0;
        this.framesWritten = 0;
        this.lastStatsAt = 0;
        this.drops = 0;
        // Latency control thresholds (in samples at 48kHz):
        // Target: 120ms = 5760 samples (initial buffer — absorbs network jitter)
        // Soft overrun: 200ms = 9600 samples → speed up playback
        // Hard overrun: 350ms = 16800 samples → skip ahead
        this.targetSamples = 5760;
        this.softOverrunSamples = 9600;
        this.hardOverrunSamples = 16800;
        // Direct PCM port from decode worker (bypasses main thread entirely)
        this.pcmPort = null;

        this.port.onmessage = (event) => {
            const data = event.data;
            if (!data) return;

            if (data.type === 'pcm') {
                this._handlePcm(data);
            } else if (data.type === 'enable-stats') {
                this.statsEnabled = true;
            } else if (data.type === 'disable-stats') {
                this.statsEnabled = false;
            } else if (data.type === 'pcm-port') {
                // Receive dedicated port from main thread; decode worker sends directly here
                this.pcmPort = data.port;
                this.pcmPort.onmessage = (e) => {
                    if (e.data && e.data.type === 'pcm') {
                        this._handlePcm(e.data);
                    }
                };
            } else if (data.type === 'get-stats') {
                this._sendStats();
            }
        };
    }

    _handlePcm(data) {
        const left = data.left instanceof Float32Array ? data.left : new Float32Array(data.left);
        const right = data.right instanceof Float32Array ? data.right : new Float32Array(data.right);
        this._writeToRing(left, right);
        this.framesWritten++;
    }

    _writeToRing(left, right) {
        const len = left.length;
        const available = (this.writePos - this.readPos + this.ringSize) % this.ringSize;
        const freeSpace = this.ringSize - 1 - available;

        // Drop if ring buffer full (should never happen with 2sec capacity)
        if (freeSpace < len) return;

        const firstPart = Math.min(len, this.ringSize - this.writePos);
        this.ringL.set(left.subarray(0, firstPart), this.writePos);
        this.ringR.set(right.subarray(0, firstPart), this.writePos);
        if (firstPart < len) {
            this.ringL.set(left.subarray(firstPart), 0);
            this.ringR.set(right.subarray(firstPart), 0);
        }
        this.writePos = (this.writePos + len) % this.ringSize;
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0];
        if (!output || output.length < 2) return true;

        const outL = output[0];
        const outR = output[1];
        const needed = outL.length; // typically 128 samples

        const available = (this.writePos - this.readPos + this.ringSize) % this.ringSize;

        if (available === 0) {
            // Buffer empty — output silence
            this.underruns++;
            return true;
        }

        // --- Latency control (mirrors original AudioBufferSourceNode logic) ---
        // Hard overrun: buffer > 300ms → skip ahead to target level.
        // This is equivalent to the original's "drop frame" at HARD_OVERRUN.
        if (available > this.hardOverrunSamples) {
            const excess = available - this.targetSamples;
            this.readPos = (this.readPos + excess) % this.ringSize;
            this.drops++;
            // Recalculate after skip
            const newAvail = (this.writePos - this.readPos + this.ringSize) % this.ringSize;
            const toRead = Math.min(needed, newAvail);
            this._readFromRing(outL, outR, toRead, needed);
            this._maybeStats();
            return true;
        }

        // Soft overrun: buffer 150-300ms → read slightly more than needed (catch-up).
        // Equivalent to original's playbackRate 1.0-1.06.
        // We read extra samples and discard them (inaudible at 1-4 extra per 128).
        let toRead = Math.min(needed, available);
        if (available > this.softOverrunSamples) {
            // Scale extra read: 0→4 samples between softOverrun and hardOverrun
            const t = Math.min(1, (available - this.softOverrunSamples) / (this.hardOverrunSamples - this.softOverrunSamples));
            const extra = Math.round(4 * t);
            const catchupRead = Math.min(needed + extra, available);
            // Read catchupRead samples but only output 'needed' of them
            // (effectively speeds up playback by skipping 'extra' samples)
            this._readFromRing(outL, outR, needed, needed);
            // Skip the extra samples
            if (extra > 0 && available > needed + extra) {
                this.readPos = (this.readPos + extra) % this.ringSize;
            }
            this._maybeStats();
            return true;
        }

        // Normal: read exactly what's needed
        this._readFromRing(outL, outR, toRead, needed);
        this._maybeStats();
        return true;
    }

    _readFromRing(outL, outR, toRead, needed) {
        const firstPart = Math.min(toRead, this.ringSize - this.readPos);
        outL.set(this.ringL.subarray(this.readPos, this.readPos + firstPart));
        outR.set(this.ringR.subarray(this.readPos, this.readPos + firstPart));
        if (firstPart < toRead) {
            const secondPart = toRead - firstPart;
            outL.set(this.ringL.subarray(0, secondPart), firstPart);
            outR.set(this.ringR.subarray(0, secondPart), firstPart);
        }
        this.readPos = (this.readPos + toRead) % this.ringSize;

        // Zero remaining if partial read (underrun mid-frame)
        if (toRead < needed) {
            for (let i = toRead; i < needed; i++) {
                outL[i] = 0;
                outR[i] = 0;
            }
        }
    }

    _maybeStats() {
        if (!this.statsEnabled) return;
        // Send stats every ~1 second (375 process calls at 128 samples / 48kHz)
        if (++this.lastStatsAt >= 375) {
            this.lastStatsAt = 0;
            this._sendStats();
        }
    }

    _sendStats() {
        const available = (this.writePos - this.readPos + this.ringSize) % this.ringSize;
        this.port.postMessage({
            type: 'stats',
            bufferSamples: available,
            bufferMs: (available / 48) | 0,
            underruns: this.underruns,
            drops: this.drops,
            framesWritten: this.framesWritten,
        });
    }
}

registerProcessor('pcm-playback-processor', PcmPlaybackProcessor);
