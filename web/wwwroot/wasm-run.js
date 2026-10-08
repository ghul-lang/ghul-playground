// The page's side of running a program compiled for the wasm target: a worker
// per run (see wasm-worker.js), what it prints gathered for the page, standard
// input handed to it a line at a time, and stopping it by terminating the
// worker, which works whatever the program is doing.

import { inputBuffer, supplyInput } from './wasm-input.js';
import { unhandledException } from './wasm-support.js';
import { wasmWorker } from './wasm-worker.js';

// The worker's script, made once from the function's own source. See
// wasm-worker.js for why it is a blob rather than the file.
let workerUrl = null;

function workerScript() {
    workerUrl ??= URL.createObjectURL(new Blob([`(${wasmWorker.toString()})();\n`], { type: 'text/javascript' }));

    return workerUrl;
}

// As much output as the .NET runner keeps, so a program that prints without
// end is cut off at the same point on either target.
export const OUTPUT_CHARS = 512 * 1024;

const base64Bytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

// A file is kept under the path the program named, less any leading `./`,
// so a marker naming `./fern.png` finds the file written as `fern.png`.
const filePath = path => path.replace(/^(\.\/)+/, '');

// Starts the program. `files` are the files it starts with, each a name and
// its bytes, which it opens by that name. `onOutput` is called with everything
// printed so far each time more arrives, and `onInput` with true when the
// program waits for a line and false once it has one.
//
// Answers the run: `done` settles with { text, error, truncated, code } when
// the program ends or is stopped, `send(line)` and `end()` answer a program
// waiting for input, `stop()` ends it, and `readFile(path)` answers the
// bytes the program last wrote to a file, or null when it wrote none there.
export function runWasm({ module, loader, args = [], files: inputFiles = [], onOutput = () => { }, onInput = () => { } }) {
    const worker = new Worker(workerScript());
    const input = inputBuffer();

    const files = new Map();

    let text = '';
    let truncated = false;
    let error = null;
    let waiting = false;
    let settle;

    const done = new Promise(resolve => { settle = resolve; });

    const finish = result => {
        worker.terminate();

        if (waiting) {
            waiting = false;
            onInput(false);
        }

        settle({ text, error, truncated, ...result });
    };

    const append = piece => {
        if (truncated) return;

        if (text.length + piece.length > OUTPUT_CHARS) {
            text += piece.slice(0, OUTPUT_CHARS - text.length);
            truncated = true;
        } else {
            text += piece;
        }

        onOutput(text);
    };

    worker.onmessage = ({ data }) => {
        switch (data.type) {
            case 'output': {
                const unhandled = data.stream === 'stderr' ? unhandledException(data.text) : null;

                if (unhandled) {
                    error = unhandled;
                    append(`${unhandled}\n`);
                } else {
                    append(data.text);
                }

                break;
            }

            case 'file':
                files.set(filePath(data.path), data.bytes);
                break;

            case 'input':
                waiting = true;
                onInput(true);
                break;

            case 'exit':
                finish({ code: data.code });
                break;

            case 'failed':
                error = `[unhandled: ${data.message}]`;
                append(`${error}\n`);
                finish({ code: null });
                break;
        }
    };

    worker.onerror = event => {
        error = `[unhandled: ${event.message ?? 'the program could not be started'}]`;
        append(`${error}\n`);
        finish({ code: null });
    };

    worker.postMessage({
        module: base64Bytes(module),
        loader,
        args,
        files: Object.fromEntries(inputFiles.map(({ name, bytes }) => [name, bytes])),
        input
    });

    const answer = line => {
        if (!waiting) return;

        waiting = false;
        onInput(false);
        supplyInput(input, line);
    };

    return {
        done,
        // What was typed is echoed into the transcript, where a terminal
        // would have shown it, as the .NET runner does.
        send: line => {
            if (!waiting) return;

            append(`${line}\n`);
            answer(`${line}\n`);
        },
        end: () => answer(null),
        stop: () => finish({ code: null, stopped: true }),
        readFile: path => files.get(filePath(path)) ?? null,
        get waiting() { return waiting; }
    };
}
