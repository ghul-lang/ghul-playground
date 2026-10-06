// The compiled code of a program as text, for the assembly view.
//
// A view is built only when a reader asks for one, by a compile of its own
// with debug information on, so a Run never pays for it. On .NET the compiler
// writes a binary assembly and a portable PDB; ilspycmd disassembles the
// assembly and marks each statement's IL with the source position the PDB
// gives it.

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
        execFile(command, ['--il-sequence-points', '--use-varnames-from-pdb', assembly],
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

module.exports = { disassemble, shapeListing, MAX_VIEW_BYTES };
