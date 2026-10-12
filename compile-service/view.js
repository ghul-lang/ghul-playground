// The compiled code of a program as text, for the assembly view.
//
// A view is built only when a reader asks for one, by a compile of its own
// with debug information on, so a Run never pays for it. On .NET the compiler
// writes a binary assembly and a portable PDB; ilspycmd disassembles the
// assembly and marks each statement's IL with the source position the PDB
// gives it. On wasm the compiler prints the module as WAT itself, marking
// each statement with the source line it came from, and can leave out the
// library functions the program does not define.

const { execFile } = require('child_process');

// A listing past this many bytes is cut at a line boundary, with a marker
// saying so: a page has no use for megabytes of text it cannot scroll to.
const MAX_VIEW_BYTES = Number(process.env.MAX_VIEW_BYTES ?? 256 * 1024);

const SEQUENCE_POINT = /^(\s*)\/\/ sequence point: \(line (\d+), col (\d+)\) to \(line (\d+), col (\d+)\) in .*$/;
const HIDDEN_POINT = /^\s*\/\/ sequence point: hidden\b/;
const METHOD_END = /^\s*\} \/\/ end of method /;

/// Runs ilspycmd over `assembly`, which has its PDB beside it.
///
/// - command: the ilspycmd executable
/// - assembly: path to the compiled assembly
/// - timeout: milliseconds before the disassembler is killed
function disassemble(command, assembly, timeout) {
    return new Promise((resolve, reject) => {
        // The update check reaches out to the network, which the compile
        // container cannot, and waits for a connection that never comes.
        execFile(command, ['--disable-updatecheck', '--il-sequence-points', '--use-varnames-from-pdb', assembly],
            { timeout, maxBuffer: 16 << 20 },
            (error, stdout, stderr) => error
                ? reject(new Error(`disassembly failed: ${(stderr || error.message).trim().split('\n')[0]}`))
                : resolve(stdout));
    });
}

/// Turns ilspycmd's listing into what the page shows: the temporary
/// directory taken out of type names and positions, and the source line each
/// listing line belongs to.
///
/// - listing: ilspycmd's output
/// - marker: a string unique to the compile's directory, which the compiler
///   folds into the namespace of a file that declares none
///
/// Returns `{text, lines, truncated}`, where `lines[i]` is the 1-based source
/// line of the statement listing line `i` is part of, or null.
function shapeListing(listing, marker) {
    const mangled = new RegExp(`[\\w\`]*${marker.replace(/[^\w]/g, '_')}__`, 'g');

    const out = [];
    const lines = [];
    let current = null;
    let bytes = 0;
    let truncated = false;

    for (const raw of listing.replace(/\r/g, '').split('\n')) {
        let line = raw.replace(mangled, '');
        let source = current;

        const point = SEQUENCE_POINT.exec(line);

        if (point) {
            const [, indent, startLine, startColumn, endLine, endColumn] = point;

            line = startLine === endLine
                ? `${indent}// line ${startLine}, columns ${startColumn}-${endColumn}`
                : `${indent}// lines ${startLine}-${endLine}`;
            current = Number(startLine);
            source = current;
        } else if (HIDDEN_POINT.test(line)) {
            current = null;
            source = null;
        } else if (METHOD_END.test(line)) {
            current = null;
            source = null;
        }

        bytes += Buffer.byteLength(line) + 1;

        if (bytes > MAX_VIEW_BYTES) {
            truncated = true;
            break;
        }

        out.push(line);
        lines.push(source);
    }

    while (out.length > 0 && out[out.length - 1].trim() === '') {
        out.pop();
        lines.pop();
    }

    if (truncated) {
        out.push(`// ... the listing is cut here, at ${Math.floor(MAX_VIEW_BYTES / 1024)} KB`);
        lines.push(null);
    }

    return { text: out.join('\n'), lines, truncated };
}

const WAT_POSITION = /^\s*;; (.+):(\d+)$/;
const WAT_FUNCTION = /^\s*\(func\b/;
const WAT_OMITTED = /^\s*;; (\d+) more functions? not shown$/;

/// Turns the compiler's WAT into what the page shows, with the source line
/// each listing line belongs to.
///
/// - wat: the text `--wat` wrote, with `--wat-lines`
/// - file: the path the program was compiled from, as the compiler was given
///   it; a position in any other file is a library's, and maps to no line
///
/// Returns `{text, lines, truncated, omitted}`, where `omitted` is how many
/// functions `--wat-program-only` left out.
function shapeWat(wat, file) {
    const out = [];
    const lines = [];
    let current = null;
    let omitted = 0;
    let bytes = 0;
    let truncated = false;

    for (const line of wat.replace(/\r/g, '').split('\n')) {
        const position = WAT_POSITION.exec(line);
        const left = WAT_OMITTED.exec(line);

        if (left) {
            omitted = Number(left[1]);
        } else if (position) {
            current = position[1] === file ? Number(position[2]) : null;
        } else if (WAT_FUNCTION.test(line)) {
            current = null;
        }

        bytes += Buffer.byteLength(line) + 1;

        if (bytes > MAX_VIEW_BYTES) {
            truncated = true;
            break;
        }

        out.push(line);
        lines.push(position || left ? null : current);
    }

    while (out.length > 0 && out[out.length - 1].trim() === '') {
        out.pop();
        lines.pop();
    }

    if (truncated) {
        out.push(`;; ... the listing is cut here, at ${Math.floor(MAX_VIEW_BYTES / 1024)} KB`);
        lines.push(null);
    }

    return { text: out.join('\n'), lines, truncated, omitted };
}

const LLVM_DEFINE = /^define [^@]*@("?)(.+?)\1\(/;

/// The names of the functions an LLVM IR text defines, in its order.
///
/// - ir: the text `--llvm-output` wrote
function llvmFunctionNames(ir) {
    const names = [];

    for (const line of ir.replace(/\r/g, '').split('\n')) {
        const define = LLVM_DEFINE.exec(line);

        if (define) names.push(define[2]);
    }

    return names;
}

/// Turns the compiler's LLVM IR into what the page shows. The IR carries no
/// line markers a listing line can be mapped by, so no line maps to the
/// source.
///
/// - ir: the text `--llvm-output` wrote
///
/// Returns `{text, lines, truncated}`.
function shapeLlvm(ir) {
    return cut(ir.replace(/\r/g, '').split('\n').map(line => [line, null]), ';');
}

const OBJDUMP_FUNCTION = /^(?:[0-9a-f]+ )?<(.+)>:$/;
const OBJDUMP_POSITION = /^(\S+):(\d+)( \(discriminator \d+\))?$/;
const OBJDUMP_FUNCTION_NAME = /^\S.*\(\):$/;

/// Runs objdump over `executable`, disassembling it with each run of
/// instructions marked by the source line it came from.
///
/// - command: the objdump executable
/// - executable: the linked program, built with debug information
/// - timeout: milliseconds before objdump is killed
function objdump(command, executable, timeout) {
    return new Promise((resolve, reject) => {
        execFile(command, ['-d', '-l', '-S', '--no-show-raw-insn', executable],
            { timeout, maxBuffer: 16 << 20 },
            (error, stdout) => error ? reject(error) : resolve(stdout));
    });
}

/// Turns objdump's listing into what the page shows: the functions `names`
/// holds, or every function where `names` is null, with the source line each
/// listing line belongs to.
///
/// - listing: what `objdump` wrote
/// - names: the functions to keep, or null for all of them
/// - file: the name the program was compiled from; a position in any other
///   file is a library's, and maps to no line
///
/// Returns `{text, lines, truncated, omitted}`, where `omitted` is how many
/// functions were left out.
function shapeObjdump(listing, names, file) {
    const wanted = names ? new Set(names) : null;
    const kept = [];
    let keeping = false;
    let current = null;
    let omitted = 0;

    for (const line of listing.replace(/\r/g, '').split('\n')) {
        const header = OBJDUMP_FUNCTION.exec(line);

        if (header) {
            keeping = !wanted || wanted.has(header[1]);
            current = null;

            if (!keeping) omitted++;
            if (keeping && kept.length > 0) kept.push(['', null]);
        }

        if (!keeping) continue;

        const position = OBJDUMP_POSITION.exec(line);

        if (position) {
            current = position[1] === file || position[1].endsWith(`/${file}`) ? Number(position[2]) : null;
            continue;
        }

        // The function's own name, which objdump -l repeats under the header.
        if (!header && OBJDUMP_FUNCTION_NAME.test(line)) continue;

        kept.push([line, header ? null : current]);
    }

    return { ...cut(kept, '#'), omitted };
}

// The listing lines `pairs` holds, each with its source line, cut at
// MAX_VIEW_BYTES with a marker written as a `comment`.
function cut(pairs, comment) {
    const out = [];
    const lines = [];
    let bytes = 0;
    let truncated = false;

    for (const [line, at] of pairs) {
        bytes += Buffer.byteLength(line) + 1;

        if (bytes > MAX_VIEW_BYTES) {
            truncated = true;
            break;
        }

        out.push(line);
        lines.push(at);
    }

    while (out.length > 0 && out[out.length - 1].trim() === '') {
        out.pop();
        lines.pop();
    }

    if (truncated) {
        out.push(`${comment} ... the listing is cut here, at ${Math.floor(MAX_VIEW_BYTES / 1024)} KB`);
        lines.push(null);
    }

    return { text: out.join('\n'), lines, truncated };
}

module.exports = {
    disassemble, shapeListing, shapeWat, llvmFunctionNames, shapeLlvm, objdump, shapeObjdump, MAX_VIEW_BYTES
};
