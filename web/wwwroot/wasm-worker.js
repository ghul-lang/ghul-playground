// Runs one program compiled for the wasm target, in a worker of its own so
// that stopping it is terminating the worker.
//
// The page sends one message: the module, the loader the compiler wrote for
// it, the program's arguments, the files it starts with, and a shared buffer
// standard input arrives through. The worker answers with each piece the program writes, each file
// it writes, a request whenever the program waits for input, and the exit
// status once it ends. Messages arrive in the order they were sent, so a
// file always reaches the page before the output that names it.
//
// Standard input is synchronous from the program's side - the loader pulls
// the next piece when the program reads - so the worker blocks on the shared
// buffer until the page has written a line or ended the input. Only a worker
// can block like that; the page's own thread cannot.
//
// The page starts the worker from this function's own source, as a blob,
// rather than from this file's URL: a worker started from a blob takes the
// page's cross-origin isolation, where one started from a URL needs its
// server to send the isolation headers on the script too. So the function
// names nothing outside itself but the worker's globals, and the slots of the
// input buffer are written out here rather than imported from wasm-input.js,
// whose constants they have to match.
export function wasmWorker() {
    const INPUT_TURN = 0;
    const INPUT_READY = 1;
    const INPUT_LENGTH = 2;
    const INPUT_SLOTS = 4;

    self.onmessage = async ({ data }) => {
        const { module, loader, args, files, input } = data;

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

        // The loader is imported from a data URL, which browsers and Node
        // import alike. The module is handed to it as bytes, so the loader
        // never resolves anything against its own URL.
        const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(loader)}`;

        try {
            const { run } = await import(url);

            const code = await run({
                module,
                args,
                files,
                env: {},
                stdin,
                stdout: piece => postMessage({ type: 'output', stream: 'stdout', text: piece }),
                stderr: piece => postMessage({ type: 'output', stream: 'stderr', text: piece }),
                onfile: (path, bytes) => postMessage({ type: 'file', path, bytes })
            });

            postMessage({ type: 'exit', code });
        } catch (e) {
            postMessage({ type: 'failed', message: e?.message ?? String(e) });
        }
    };
}
