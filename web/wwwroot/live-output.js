// Turns what a program writes into what the page shows: its text, and the
// pictures it named with an image marker, as each marker arrives.
//
// ghul.raster's `show` writes the PNG to the runtime's filesystem and then
// prints `<<image name.png>>`. That filesystem lives on the page's own thread -
// the program's thread reaches it through calls the runtime forwards here - so
// the page can read the file the moment the marker appears, while the program
// is still running. Showing a name that is already on the page replaces that
// picture where it is, which is all an animation is: draw, show, sleep, repeat.
//
// Nothing here knows about the runtime. It is handed a way to read a file, so
// the same code serves the live output and the complete text the run answers
// with at the end, and a test can drive it with no runtime at all.

import { Terminal } from './terminal.js';

const ESC = '\x1b';

export const MARKER_OPEN = '<<image ';
export const MARKER_CLOSE = '>>';

// Nothing bounds what a program can draw, and every picture is held as a data
// URL and, when embedded, posted to the parent page. Past this a picture is
// not shown and the run says so. Replacing a picture gives its bytes back, so
// an animation is charged for one frame, not for every frame it has shown.
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// A file is written in several steps, and the page can look between two of
// them, so a picture the program is part way through writing is left for the
// next look rather than shown broken. A PNG says where it ends.
export function isCompletePng(bytes) {
    if (bytes.length < PNG_SIGNATURE.length + 12) return false;

    for (let at = 0; at < PNG_SIGNATURE.length; at++) {
        if (bytes[at] !== PNG_SIGNATURE[at]) return false;
    }

    // The last chunk is IEND: a zero length, the type, and a fixed CRC.
    const end = bytes.length - 12;

    return bytes[end] === 0 && bytes[end + 1] === 0 && bytes[end + 2] === 0 && bytes[end + 3] === 0
        && bytes[end + 4] === 0x49 && bytes[end + 5] === 0x45
        && bytes[end + 6] === 0x4e && bytes[end + 7] === 0x44;
}

// The path a marker line names, or null when the line is not one.
export function markedPath(line) {
    const trimmed = line.trim();

    if (!trimmed.startsWith(MARKER_OPEN) || !trimmed.endsWith(MARKER_CLOSE)) return null;

    const path = trimmed.slice(MARKER_OPEN.length, trimmed.length - MARKER_CLOSE.length).trim();

    return path.length ? path : null;
}

// What a terminal shows for a line containing carriage returns: each one goes
// back to the start of the line, and what follows writes over what was there.
// A `\r\n` line ending writes nothing over it, so it comes out unchanged.
export function overprint(line) {
    if (!line.includes('\r')) return line;

    let shown = '';

    for (const part of line.split('\r')) {
        shown = part + shown.slice(part.length);
    }

    return shown;
}

function baseName(path) {
    const at = path.lastIndexOf('/');

    return at < 0 ? path : path.slice(at + 1);
}

function dataUrl(bytes) {
    let binary = '';

    for (let at = 0; at < bytes.length; at += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(at, Math.min(at + 8192, bytes.length)));
    }

    return `data:image/png;base64,${btoa(binary)}`;
}

export class LiveOutput {
    // `readFile` answers the bytes at a path, or null when there is no such
    // file.
    constructor({ readFile, maxImageBytes = MAX_IMAGE_BYTES }) {
        this._readFile = readFile;
        this._maxImageBytes = maxImageBytes;

        // Lines already decided on, marker lines taken out.
        this._lines = [];

        // The start of a line whose end has not arrived yet.
        this._partial = '';

        // name -> { path, bytes, url }, in the order each name was first
        // shown, which is the order the pictures are laid out in.
        this._images = new Map();

        // Names whose marker has been seen but whose file was not yet
        // complete when looked at.
        this._pending = new Map();

        // Every path a marker named, so the run's files can be removed.
        this._paths = new Set();

        this._total = 0;
        this._dropped = 0;
        this._changed = false;

        // Made at the first escape sequence the output holds.
        this._terminal = null;
    }

    // Takes the next piece of output. Only whole lines are decided on, since a
    // marker is only a marker once its line has ended.
    //
    // Called with nothing, it looks again at the pictures whose files were not
    // yet complete.
    feed(text = '') {
        if (text && !this._terminal && text.includes(ESC)) this._startTerminal();

        if (text) {
            this._terminal?.feed(text);

            const lines = (this._partial + text).split('\n');

            this._partial = lines.pop();

            for (const line of lines) this._line(line);
        }

        this._retry();
    }

    // The output has ended: the last line is decided on whether or not it was
    // terminated, and every picture still waiting is read one final time.
    finish() {
        const last = this._partial;

        this._partial = '';

        if (last) this._line(last, true);

        this._terminal?.finish();

        this._retry(true);
    }

    // The output drawn on a terminal's screen, as rows of styled runs, once
    // the output has used an escape sequence; null for output that has not,
    // which is shown as the text it is.
    get screen() {
        return this._terminal ? this._terminal.lines : null;
    }

    // The text as it stands, marker lines taken out and carriage returns
    // applied, or once there is a screen, the screen as plain text.
    get text() {
        let text;

        if (this._terminal) {
            text = this._terminal.text;
        } else {
            const lines = this._lines.map(overprint);

            text = lines.join('\n');

            if (this._lines.length) text += '\n';

            text += overprint(this._partial);
        }

        if (this._dropped > 0) {
            text += `[${this._dropped} image(s) not shown: this run drew more than ` +
                `${Math.round(this._maxImageBytes / (1024 * 1024))} MB]\n`;
        }

        return text;
    }

    get images() {
        return [...this._images].map(([name, image]) => ({ name, url: image.url }));
    }

    get paths() {
        return [...this._paths];
    }

    // Whether the pictures have changed since this was last asked.
    takeChanged() {
        const changed = this._changed;

        this._changed = false;

        return changed;
    }

    // The terminal starts with what was shown before it, so the screen picks
    // up where the text left off.
    _startTerminal() {
        this._terminal = new Terminal();

        const before = this._lines.join('\n');

        this._terminal.feed(this._lines.length ? `${before}\n${this._partial}` : this._partial);
    }

    _line(line, last = false) {
        const path = markedPath(line);

        if (!path) {
            this._lines.push(line);
            return;
        }

        const bytes = this._readFile(path);

        // A marker naming a file that is not there is left as the program
        // wrote it: a program can print one itself, and a reader who sees the
        // line they wrote is better served than one whose output quietly
        // loses a line.
        if (!bytes) {
            this._lines.push(line);
            return;
        }

        this._paths.add(path);

        const name = baseName(path);

        if (isCompletePng(bytes) || last) {
            this._show(name, path, bytes);
        } else {
            this._pending.set(name, path);
        }
    }

    _retry(last = false) {
        for (const [name, path] of this._pending) {
            const bytes = this._readFile(path);

            if (bytes && (isCompletePng(bytes) || last)) {
                this._pending.delete(name);
                this._show(name, path, bytes);
            } else if (last) {
                this._pending.delete(name);
            }
        }
    }

    _show(name, path, bytes) {
        const previous = this._images.get(name);

        // The same picture again changes nothing on the page, and a program
        // that redraws an unchanged frame should not make it flicker.
        if (previous && previous.path === path && sameBytes(previous.bytes, bytes)) {
            this._pending.delete(name);
            return;
        }

        const freed = previous ? previous.bytes.length : 0;

        if (this._total - freed + bytes.length > this._maxImageBytes) {
            this._dropped++;
            return;
        }

        this._total += bytes.length - freed;

        // Copied, since what the runtime hands back can be a view over memory
        // it goes on to reuse.
        const copy = bytes.slice();

        this._images.set(name, { path, bytes: copy, url: dataUrl(copy) });
        this._changed = true;
    }
}

function sameBytes(a, b) {
    if (a.length !== b.length) return false;

    for (let at = 0; at < a.length; at++) {
        if (a[at] !== b[at]) return false;
    }

    return true;
}
