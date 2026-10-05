// The slots of the buffer standard input crosses from the page to a wasm
// program's worker: a count the worker bumps each time it waits for input, a
// flag the page sets once a line is there, and the line's length, -1 for the
// end of the input. The line's UTF-16 follows the slots.

export const INPUT_TURN = 0;
export const INPUT_READY = 1;
export const INPUT_LENGTH = 2;
export const INPUT_SLOTS = 4;

export const INPUT_CHARS = 4 * 1024;

export function inputBuffer() {
    return new SharedArrayBuffer(INPUT_SLOTS * 4 + INPUT_CHARS * 2);
}

// Hands the worker a line, or the end of the input when `line` is null. The
// length is written before the flag, so the worker never sees a flag without
// the line it announces.
export function supplyInput(buffer, line) {
    const control = new Int32Array(buffer, 0, INPUT_SLOTS);
    const text = new Uint16Array(buffer, INPUT_SLOTS * 4);

    if (line === null) {
        Atomics.store(control, INPUT_LENGTH, -1);
    } else {
        const length = Math.min(line.length, INPUT_CHARS);

        for (let at = 0; at < length; at++) {
            text[at] = line.charCodeAt(at);
        }

        Atomics.store(control, INPUT_LENGTH, length);
    }

    Atomics.store(control, INPUT_READY, 1);
    Atomics.notify(control, INPUT_READY);
}
