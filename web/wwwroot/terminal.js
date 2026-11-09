// Plays a program's output onto a grid of character cells, as a terminal
// would, for the programs that draw with escape sequences: colored text,
// inverse video, cursor positioning, clearing, and the alternate screen.
//
// It understands the same sequences as the Rosetta Code tools' terminal, and
// treats them the same way: carriage return and line feed; cursor positioning
// (ESC[r;cH, ESC[r;cf, ESC[cG) and movement (ESC[nA/B/C/D); clearing the
// screen and the line (ESC[nJ, ESC[nK); the alternate screen (ESC[?1049h/l);
// and the attributes of SGR - reset, bold, inverse, the eight colors and their
// bright forms, foreground and background, and the defaults. Any other
// sequence is read and dropped, so it changes nothing rather than appearing
// as text.
//
// Output arrives in pieces, and a piece can end part way through a sequence:
// the unfinished part is held until the rest arrives.

export const ROWS = 24;
export const COLUMNS = 80;

// Rows scrolled off the top are kept above the screen, up to this many.
export const MAX_SCROLLBACK = 5000;

const ESC = '\x1b';

function blank() {
    return { text: ' ', foreground: -1, background: -1, bold: false, inverse: false };
}

function blankRow(columns) {
    const row = new Array(columns);

    for (let column = 0; column < columns; column++) row[column] = blank();

    return row;
}

function blankScreen(rows, columns) {
    const screen = new Array(rows);

    for (let row = 0; row < rows; row++) screen[row] = blankRow(columns);

    return screen;
}

function sameStyle(a, b) {
    return a.foreground === b.foreground && a.background === b.background
        && a.bold === b.bold && a.inverse === b.inverse;
}

function isBlank(row) {
    return row.every(cell => cell.text === ' ' && cell.background === -1 && !cell.inverse);
}

// A row as runs of text drawn in one style, trailing blanks dropped.
function runs(row) {
    let end = row.length;

    while (end > 0 && row[end - 1].text === ' ' && row[end - 1].background === -1 && !row[end - 1].inverse) end--;

    const result = [];

    for (let column = 0; column < end; column++) {
        const cell = row[column];
        const last = result[result.length - 1];

        if (last && sameStyle(last, cell)) {
            last.text += cell.text;
        } else {
            result.push({ text: cell.text, foreground: cell.foreground, background: cell.background, bold: cell.bold, inverse: cell.inverse });
        }
    }

    return result;
}

export class Terminal {
    constructor({ rows = ROWS, columns = COLUMNS, maxScrollback = MAX_SCROLLBACK } = {}) {
        this.rows = rows;
        this.columns = columns;
        this._maxScrollback = maxScrollback;

        this._cells = blankScreen(rows, columns);
        this._saved = null;
        this._scrollback = [];
        this._row = 0;
        this._column = 0;
        this._foreground = -1;
        this._background = -1;
        this._bold = false;
        this._inverse = false;

        // The start of a sequence whose end has not arrived yet.
        this._pending = '';
    }

    // Plays the next piece of output.
    feed(text) {
        text = this._pending + text;
        this._pending = '';

        let at = 0;

        while (at < text.length) {
            const c = text[at];

            if (c === ESC) {
                if (at + 1 >= text.length) {
                    this._pending = text.slice(at);
                    return;
                }

                if (text[at + 1] === '[') {
                    const next = this._escape(text, at + 2);

                    if (next < 0) {
                        this._pending = text.slice(at);
                        return;
                    }

                    at = next;
                    continue;
                }
            }

            if (c === '\r') {
                this._column = 0;
            } else if (c === '\n') {
                this._column = 0;
                this._lineFeed();
            } else if (c === '\b') {
                this._column = Math.max(0, this._column - 1);
            } else if (c === '\t') {
                this._column = Math.min(this.columns - 1, (Math.floor(this._column / 8) + 1) * 8);
            } else if (c >= ' ') {
                this._put(c);
            }

            at++;
        }
    }

    // The output has ended: a sequence it stopped part way through is dropped.
    finish() {
        this._pending = '';
    }

    // The screen's rows, each as runs of text drawn in one style. Blank rows
    // below the last one written are left out.
    get screen() {
        let end = this.rows;

        while (end > 0 && isBlank(this._cells[end - 1])) end--;

        return this._cells.slice(0, end).map(runs);
    }

    // Every row shown: the rows scrolled off the screen, then the screen.
    get lines() {
        return [...this._scrollback.map(runs), ...this.screen];
    }

    // The same rows as plain text.
    get text() {
        const lines = this.lines.map(line => line.map(run => run.text).join(''));

        return lines.length ? `${lines.join('\n')}\n` : '';
    }

    // Reads one sequence from `start`, just after its ESC[, and answers where
    // the text goes on, or -1 when the text ends before the sequence does.
    _escape(text, start) {
        let at = start;
        const privateMode = at < text.length && text[at] === '?';

        if (privateMode) at++;

        const parameters = [];
        let current = -1;

        while (at < text.length && ((text[at] >= '0' && text[at] <= '9') || text[at] === ';')) {
            if (text[at] === ';') {
                parameters.push(current);
                current = -1;
            } else {
                current = (current < 0 ? 0 : current) * 10 + (text.charCodeAt(at) - 48);
            }

            at++;
        }

        parameters.push(current);

        if (at >= text.length) return -1;

        const final = text[at];
        const first = parameters[0] < 0 ? 1 : parameters[0];

        if (privateMode) {
            if (parameters[0] === 1049) {
                if (final === 'h') {
                    this._saved = this._cells;
                    this._cells = blankScreen(this.rows, this.columns);
                } else if (final === 'l' && this._saved) {
                    this._cells = this._saved;
                    this._saved = null;
                }
            }

            return at + 1;
        }

        switch (final) {
            case 'H':
            case 'f': {
                const row = parameters.length > 0 && parameters[0] > 0 ? parameters[0] : 1;
                const column = parameters.length > 1 && parameters[1] > 0 ? parameters[1] : 1;

                this._row = Math.min(this.rows - 1, row - 1);
                this._column = Math.min(this.columns - 1, column - 1);
                break;
            }
            case 'A':
                this._row = Math.max(0, this._row - first);
                break;
            case 'B':
                this._row = Math.min(this.rows - 1, this._row + first);
                break;
            case 'C':
                this._column = Math.min(this.columns - 1, this._column + first);
                break;
            case 'D':
                this._column = Math.max(0, this._column - first);
                break;
            case 'G':
                this._column = Math.min(this.columns - 1, first - 1);
                break;
            case 'J': {
                const mode = parameters[0] < 0 ? 0 : parameters[0];

                if (mode === 2 || mode === 3) {
                    this._cells = blankScreen(this.rows, this.columns);
                } else {
                    for (let column = this._column; column < this.columns; column++) this._cells[this._row][column] = blank();
                    for (let row = this._row + 1; row < this.rows; row++) this._cells[row] = blankRow(this.columns);
                }
                break;
            }
            case 'K': {
                const mode = parameters[0] < 0 ? 0 : parameters[0];
                const from = mode === 0 ? this._column : 0;
                const to = mode === 1 ? this._column + 1 : this.columns;

                for (let column = from; column < to; column++) this._cells[this._row][column] = blank();
                break;
            }
            case 'm':
                this._attributes(parameters);
                break;
        }

        return at + 1;
    }

    _attributes(parameters) {
        for (const p of parameters) {
            const code = p < 0 ? 0 : p;

            if (code === 0) {
                this._foreground = -1;
                this._background = -1;
                this._bold = false;
                this._inverse = false;
            } else if (code === 1) {
                this._bold = true;
            } else if (code === 22) {
                this._bold = false;
            } else if (code === 7) {
                this._inverse = true;
            } else if (code === 27) {
                this._inverse = false;
            } else if (code >= 30 && code <= 37) {
                this._foreground = code - 30;
            } else if (code === 39) {
                this._foreground = -1;
            } else if (code >= 40 && code <= 47) {
                this._background = code - 40;
            } else if (code === 49) {
                this._background = -1;
            } else if (code >= 90 && code <= 97) {
                this._foreground = code - 90 + 8;
            } else if (code >= 100 && code <= 107) {
                this._background = code - 100 + 8;
            }
        }
    }

    _put(c) {
        if (this._column >= this.columns) {
            this._column = 0;
            this._lineFeed();
        }

        this._cells[this._row][this._column] = {
            text: c, foreground: this._foreground, background: this._background, bold: this._bold, inverse: this._inverse
        };

        this._column++;
    }

    _lineFeed() {
        if (this._row < this.rows - 1) {
            this._row++;
            return;
        }

        // The bottom line scrolls the screen up by one. What scrolls off the
        // main screen is kept above it; the alternate screen keeps nothing.
        const top = this._cells.shift();

        if (!this._saved) {
            this._scrollback.push(top);

            if (this._scrollback.length > this._maxScrollback) this._scrollback.shift();
        }

        this._cells.push(blankRow(this.columns));
    }
}
