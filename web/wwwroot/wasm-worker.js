// Runs one program compiled for the wasm target, in a worker of its own so
// that stopping it is terminating the worker.
//
// The page sends one message: the module, the loader the compiler wrote for
// it, the program's arguments, and a shared buffer standard input arrives
// through. The worker answers with each piece the program writes, a request
// whenever the program waits for input, and the exit status once it ends.
//
// Standard input is synchronous from the program's side - the loader pulls
// the next piece when the program reads - so the worker blocks on the shared
// buffer until the page has written a line or ended the input. Only a worker
// can block like that; the page's own thread cannot.

import { INPUT_TURN, INPUT_READY, INPUT_LENGTH, INPUT_SLOTS } from './wasm-input.js';

self.onmessage = async ({ data }) => {
    const { module, loader, args, input } = data;

    const control = new Int32Array(input, 0, INPUT_SLOTS);
    const text = new Uint16Array(input, INPUT_SLOTS * 4);

    // The next piece of standard input, or null at its end.
    const stdin = () => {
        Atomics.store(control, INPUT_READY, 0);
        Atomics.add(control, INPUT_TURN, 1);

        postMessage({ type: 'input' });

        Atomics.wait(control, INPUT_READY, 0);

        const length = Atomics.load(control, INPUT_LENGTH);

        if (length < 0) return null;

        let line = '';

        for (let at = 0; at < length; at += 8192) {
            line += String.fromCharCode.apply(null, text.subarray(at, Math.min(at + 8192, length)));
        }

        return line;
    };

    // The loader is imported from a data URL, which browsers and Node import
    // alike. The module is handed to it as bytes, so the loader never resolves
    // anything against its own URL.
    const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(loader)}`;

    try {
        const { run } = await import(url);

        const code = await run({
            module,
            args,
            env: {},
            stdin,
            stdout: piece => postMessage({ type: 'output', stream: 'stdout', text: piece }),
            stderr: piece => postMessage({ type: 'output', stream: 'stderr', text: piece })
        });

        postMessage({ type: 'exit', code });
    } catch (e) {
        postMessage({ type: 'failed', message: e?.message ?? String(e) });
    }
};
