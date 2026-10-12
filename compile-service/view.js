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
const LLVM_METADATA = /^!(\d+) = (?:distinct )?!(\w+)\((.*)\)$/;

// The fields of a metadata node that name other nodes, as `name: !N`.
function metadataLinks(body) {
    const links = {};

    for (const [, name, id] of body.matchAll(/(\w+): !(\d+)/g)) links[name] = id;

    return links;
}

// Which debug locations of an LLVM module are in `file`, or inlined into code
// that is: a location's scope leads, through any lexical blocks, to a
// subprogram, and the subprogram names its file.
function locationsIn(ir, file) {
    const nodes = new Map();

    for (const line of ir.split('\n')) {
        const node = LLVM_METADATA.exec(line);

        if (node) nodes.set(node[1], { kind: node[2], body: node[3], links: metadataLinks(node[3]) });
    }

    const files = new Set([...nodes].filter(([, n]) => n.kind === 'DIFile' && n.body.includes(`filename: "${file}"`)).map(([id]) => id));
    const scopeFile = new Map();

    const fileOf = (id, depth = 0) => {
        if (scopeFile.has(id)) return scopeFile.get(id);

        const node = nodes.get(id);
        const result = !node || depth > 64 ? null
            : node.links.file ?? (node.links.scope ? fileOf(node.links.scope, depth + 1) : null);

        scopeFile.set(id, result);
        return result;
    };

    const inFile = new Map();

    const located = (id, depth = 0) => {
        if (inFile.has(id)) return inFile.get(id);

        const node = nodes.get(id);
        const result = !!node && node.kind === 'DILocation' && depth <= 64 && (
            files.has(fileOf(node.links.scope)) ||
            (node.links.inlinedAt ? located(node.links.inlinedAt, depth + 1) : false));

        inFile.set(id, result);
        return result;
    };

    const subprograms = new Set([...nodes].filter(([, n]) => n.kind === 'DISubprogram' && files.has(n.links.file)).map(([id]) => id));

    return { located, subprograms };
}

/// Turns LLVM IR into what the page shows. With `programOnly`, only the
/// functions of the program in `file` are kept: those whose debug subprogram
/// is in that file, and those holding code from it, as an optimised module
/// does once the program's functions are inlined. The IR carries no line
/// markers a listing line can be mapped by, so no line maps to the source.
///
/// - ir: LLVM IR with debug metadata, as the compiler or ghul-llvm writes it
/// - programOnly: whether to keep only the program's own functions
/// - file: the name the program was compiled from
///
/// Returns `{text, lines, truncated, omitted}`, where `omitted` is how many
/// functions were left out.
function shapeLlvm(ir, programOnly = false, file = 'main.ghul') {
    const text = ir.replace(/\r/g, '');

    if (!programOnly) {
        return { ...cut(text.split('\n').map(line => [line, null]), ';'), omitted: 0 };
    }

    const kept = [];
    let omitted = 0;

    for (const { block, program } of llvmFunctions(text, file)) {
        if (program) {
            if (kept.length > 0) kept.push(['', null]);
            for (const l of block) kept.push([l, null]);
        } else {
            omitted++;
        }
    }

    return { ...cut(kept, ';'), omitted };
}

/// The names of the functions an LLVM module holds the program's code in, by
/// the rule `shapeLlvm` keeps them by.
///
/// - ir: LLVM IR with debug metadata
/// - file: the name the program was compiled from
function programFunctions(ir, file = 'main.ghul') {
    return new Set(llvmFunctions(ir.replace(/\r/g, ''), file)
        .filter(f => f.program)
        .map(f => LLVM_DEFINE.exec(f.block[0])[2]));
}

// Each function an LLVM module defines, as its lines and whether it holds
// code from `file`.
function llvmFunctions(text, file) {
    const { located, subprograms } = locationsIn(text, file);
    const functions = [];
    let block = null;

    for (const line of text.split('\n')) {
        if (!block) {
            if (LLVM_DEFINE.test(line)) block = [line];
            continue;
        }

        block.push(line);

        if (line !== '}') continue;

        const own = /!dbg !(\d+)\s*\{$/.exec(block[0]);
        const program = (own && subprograms.has(own[1])) ||
            block.some(l => [...l.matchAll(/!dbg !(\d+)/g)].some(([, id]) => located(id)));

        functions.push({ block, program });
        block = null;
    }

    return functions;
}

const ASM_FILE = /^\s*\.file\s+(\d+)\s+(?:"[^"]*"\s+)?"([^"]*)"/;
const ASM_LOC = /^\s*\.loc\s+(\d+)\s+(\d+)/;
const ASM_TYPE_FUNCTION = /^\s*\.type\s+("?)(.+?)\1,@function/;
const ASM_LABEL = /^("?)([^\s"]+?)\1:/;

/// Turns the assembly ghul-llvm writes into what the page shows: the
/// functions and their instructions, each instruction with the source line
/// its `.loc` places it at, and none of the assembler's other directives or
/// its own internal labels. With `names`, only the functions named are kept:
/// an optimised function's `.loc` lines name only the innermost file, so
/// which functions hold the program's code is read from the IR instead.
///
/// - asm: the text `--emit=asm` wrote
/// - names: the functions to keep, or null for all of them
/// - file: the name the program was compiled from; a position in any other
///   file is a library's, and maps to no line
///
/// Returns `{text, lines, truncated, omitted}`, where `omitted` is how many
/// functions were left out.
function shapeAsm(asm, names = null, file = 'main.ghul') {
    const lines = asm.replace(/\r/g, '').split('\n');
    const indices = new Set();

    for (const line of lines) {
        const declared = ASM_FILE.exec(line);

        if (declared && (declared[2] === file || declared[2].endsWith(`/${file}`))) indices.add(declared[1]);
    }

    const functions = new Set();

    for (const line of lines) {
        const declared = ASM_TYPE_FUNCTION.exec(line);

        if (declared) functions.add(declared[2]);
    }

    const kept = [];
    let omitted = 0;
    let body = null;
    let name = null;
    let current = null;

    const finish = () => {
        if (!body) return;

        if (!names || names.has(name)) {
            if (kept.length > 0) kept.push(['', null]);
            kept.push(...body);
        } else {
            omitted++;
        }

        body = null;
    };

    for (const line of lines) {
        const label = ASM_LABEL.exec(line);

        if (label && functions.has(label[2])) {
            finish();
            body = [[line, null]];
            name = label[2];
            current = null;
            continue;
        }

        if (!body) continue;

        if (/^\s*\.size\s/.test(line) || /^\s*\.section\s/.test(line) || /^\s*\.(data|bss)\b/.test(line)) {
            finish();
            continue;
        }

        const loc = ASM_LOC.exec(line);

        if (loc) {
            current = indices.has(loc[1]) && loc[2] !== '0' ? Number(loc[2]) : null;
            continue;
        }

        if (label) {
            if (!/^\.L(tmp|func_begin|func_end)/.test(label[2])) body.push([line, null]);
            continue;
        }

        const trimmed = line.trim();

        if (trimmed === '' || trimmed.startsWith('.') || trimmed.startsWith('#')) continue;

        body.push([line, current]);
    }

    finish();

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
    disassemble, shapeListing, shapeWat, shapeLlvm, programFunctions, shapeAsm, MAX_VIEW_BYTES
};
