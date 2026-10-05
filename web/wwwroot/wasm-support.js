// What running a program compiled for the wasm target needs from the browser,
// and how what the program prints is told apart from how it ended.
//
// A wasm build uses the GC proposal, exception handling with exnref and the
// JS String Builtins, and each has to be present or the module will not load:
// Chrome 137, Firefox 134 and Safari 26.2 have all three. The check is done on
// tiny modules rather than by version, so a browser that gains a feature is
// used as soon as it has it.

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

const section = (id, bytes) => [id, bytes.length, ...bytes];
const name = text => [text.length, ...[...text].map(c => c.charCodeAt(0))];

// A struct type, which only the GC proposal can declare.
const GC = new Uint8Array([...HEADER, ...section(1, [1, 0x5f, 1, 0x7f, 0])]);

// A function holding a try_table, which is exception handling with exnref.
const EXCEPTIONS = new Uint8Array([
    ...HEADER,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(3, [1, 0]),
    ...section(10, [1, 6, 0, 0x1f, 0x40, 0, 0x0b, 0x0b])
]);

// An import only the string builtins can satisfy: with them it instantiates
// from nothing, and without them the import is missing.
const STRINGS = new Uint8Array([
    ...HEADER,
    ...section(1, [1, 0x60, 1, 0x6f, 1, 0x7f]),
    ...section(2, [1, ...name('wasm:js-string'), ...name('length'), 0, 0])
]);

let supported = null;

// Whether this browser can run a program built for the wasm target. Asked
// once and remembered, since the answer cannot change while the page is open.
export function wasmSupported() {
    supported ??= (async () => {
        try {
            if (typeof WebAssembly !== 'object') return false;
            if (!WebAssembly.validate(GC) || !WebAssembly.validate(EXCEPTIONS)) return false;

            await WebAssembly.instantiate(STRINGS, {}, { builtins: ['js-string'] });

            return true;
        } catch {
            return false;
        }
    })();

    return supported;
}

// The line the wasm loader writes to standard error when a program ends on an
// exception it did not handle, and the way the .NET runner shows the same
// thing, which the page shows for both: the type's own name and the message.
const UNHANDLED = /^Unhandled exception\. ([^:\n]+): ?([\s\S]*?)\n?$/;

export function unhandledException(text) {
    const match = UNHANDLED.exec(text);

    if (!match) return null;

    const type = match[1].split('.').pop();

    return `[unhandled: ${type}: ${match[2]}]`;
}

// Whether a compile failed only because the program uses something the wasm
// target lacks, which is when the page compiles it for .NET instead: a
// construct it cannot compile yet, or a .NET API the core library does not
// declare, which reads as a name not found. A name the program got wrong
// reads the same way, and .NET then reports it as well, so the cost of
// mistaking one for the other is a second compile.
export function needsDotnet(diagnostics) {
    const errors = (diagnostics ?? []).filter(d => d.severity === 'error');

    return errors.length > 0 && errors.every(d => /not supported on the wasm target|not found in|symbol not found/.test(d.message));
}
