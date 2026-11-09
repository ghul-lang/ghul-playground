// Draws a terminal screen into an element: each row a line of spans, one per
// run of text drawn in one style. Colors are the --terminal-<n> tokens of the
// 16-color palette, and the default foreground and background are the
// element's own.

function color(index, fallback) {
    return index < 0 ? fallback : `var(--terminal-${index})`;
}

function span(run) {
    const element = document.createElement('span');

    element.textContent = run.text;

    // Inverse swaps the two colors, the defaults included.
    const foreground = run.inverse
        ? color(run.background, 'var(--terminal-background)')
        : color(run.foreground, '');
    const background = run.inverse
        ? color(run.foreground, 'var(--terminal-foreground)')
        : color(run.background, '');

    if (foreground) element.style.color = foreground;
    if (background) element.style.backgroundColor = background;
    if (run.bold) element.style.fontWeight = 'bold';

    return element;
}

// Replaces what `element` shows with `screen`: the text before it, its rows,
// and the text after them.
export function showScreen(element, { before = '', lines, after = '' }) {
    const fragment = document.createDocumentFragment();

    if (before) fragment.append(before);

    for (const line of lines) {
        for (const run of line) {
            fragment.append(run.inverse || run.foreground >= 0 || run.background >= 0 || run.bold ? span(run) : run.text);
        }

        fragment.append('\n');
    }

    if (after) fragment.append(after);

    element.classList.add('terminal-screen');
    element.replaceChildren(fragment);
}

// Replaces what `element` shows with plain `text`, in the element's own face.
export function showText(element, text) {
    element.classList.remove('terminal-screen');
    element.textContent = text;
}
