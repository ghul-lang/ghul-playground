// Embedded mode: the editor only, framed by another site.
//
// The frame owns nothing but the editor. Output, diagnostics and status are
// posted to the parent, which renders them in whatever it already has, so an
// embedding page does not end up with two differently-styled output panels.
//
// Origins are checked in both directions. The parent must be one of the sites
// allowed to embed this, and messages claiming to come from elsewhere are
// ignored.

// First, so that the runtime starts its workers from the constructor this
// module wraps; see errors.js.
import { countErrors } from './errors.js'
import { createPlayground, DEFAULT_SOURCE } from './playground.js'

countErrors('embed-error');

const ALLOWED_PARENTS = [
    'https://ghul.dev',
    'https://www.ghul.dev'
];

// Local development: a parent served from localhost is trusted so the
// integration can be worked on without deploying either side.
const LOCAL_PARENT = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function parentIsAllowed(origin) {
    return ALLOWED_PARENTS.includes(origin) || LOCAL_PARENT.test(origin);
}

// The marker field is `channel`, not `source`: `source` carries the program
// text, and using one name for both would set the editor to the marker.
const CHANNEL = 'ghul-playground';

// The parent's origin, learned from the first message it sends. Replies go
// only there, never to '*'.
// Whether the embedding page has ever answered a request for input. It cannot
// be asked in advance - an older page that knows nothing about this would not
// reply - so it is learned from the first answer, and a program reading before
// then gets end of stream.
let acceptsInput = false;

let parentOrigin = null;

function post(type, payload = {}) {
    if (!parentOrigin) return;

    parent.postMessage({ channel: CHANNEL, type, ...payload }, parentOrigin);
}

const container = document.getElementById('editor');

let playground = null;
let lastHeight = 0;

function reportHeight() {
    // Monaco knows what its content needs; the frame cannot size itself, so
    // the parent is told and sizes the iframe.
    const height = Math.max(playground?.contentHeight() ?? 0, 80);

    if (Math.abs(height - lastHeight) >= 4) {
        lastHeight = height;
        post('height', { height });
    }
}

window.addEventListener('message', async event => {
    if (!parentIsAllowed(event.origin)) return;
    if (event.data?.channel !== CHANNEL) return;

    parentOrigin = event.origin;

    const message = event.data;

    // An embedding page declaring it will supply lines, which it does by
    // answering an 'input-wanted' with an 'input' of its own. Until it has
    // said so once, a read ends the stream rather than waiting.
    if (message.type === 'input') {
        acceptsInput = true;

        if (typeof message.line === 'string') {
            playground?.sendInput(message.line);
        } else {
            playground?.endInput();
        }

        return;
    }

    if (message.type === 'init') {
        if (playground) {
            playground.setSource(message.source ?? DEFAULT_SOURCE);
            if (message.theme) playground.setTheme(message.theme);
            reportHeight();
            return;
        }

        playground = await createPlayground({
            container,
            source: message.source ?? DEFAULT_SOURCE,
            theme: message.theme ?? 'vs',

            onOutput: text => post('output', { text }),

            // A program that reads a line has nowhere to read it from here:
            // the box is part of the standalone page's chrome, and an
            // embedding page has to offer its own. Until one does, the honest
            // answer is that there is no more input, which a program sees as
            // the end of the stream and can act on - where waiting for a line
            // nothing will ever send would hang it with nothing on the page to
            // say why.
            //
            // The parent is told, so a page that does want to offer a box can
            // say so by answering with an 'input' message; the handler below
            // takes the line. Ignoring it is what leaves end-of-stream.
            onInput: wanted => {
                if (!wanted) return;

                post('input-wanted');

                if (!acceptsInput) playground.endInput();
            },
            // The pictures a drawing program produced, as data URLs. The
            // marker naming each one is taken out of the text, so a parent
            // that ignores this message shows the program's words and drops
            // its drawings silently.
            onImages: list => post('images', { images: list }),
            onDiagnostics: list => post('diagnostics', { diagnostics: list }),
            onStatus: (state, detail) => post('status', { state, detail: detail ?? null }),
            onAnalyser: state => post('analyser', { state })
        });

        playground.editor.onDidContentSizeChange(reportHeight);

        // The embedding page keeps the reader's edits, so that closing the
        // editor or opening another one does not throw their work away. It
        // cannot read across origins, so the source has to be handed to it.
        let reportTimer = null;
        playground.editor.onDidChangeModelContent(() => {
            clearTimeout(reportTimer);
            reportTimer = setTimeout(
                () => post('source', { source: playground.getSource() }), 400);
        });
        playground.editor.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => playground.run());

        reportHeight();
        post('ready');

        // The frame is only shown once a reader has asked to edit, so asking
        // for the token here is not an interruption - where one is wanted at
        // all. Where it is not, the reader is told nothing and simply edits.
        if (!await playground.tokenRequired()) {
            post('token', { held: true });
        } else if (playground.hasToken()) {
            post('token', { held: true });
        } else {
            const entered = await playground.askForToken();

            post('token', { held: Boolean(entered) });
        }

        return;
    }

    if (!playground) return;

    if (message.type === 'source') {
        playground.setSource(message.source ?? '');
        reportHeight();
        return;
    }

    if (message.type === 'theme') {
        playground.setTheme(message.theme ?? 'vs');
        return;
    }

    if (message.type === 'run') {
        playground.run();
    }
});

// A key pressed while the editor has focus never reaches the embedding page,
// so the one shortcut the page needs is forwarded. Without this a reader who
// has expanded the editor and is typing in it has no way out but the mouse.
window.addEventListener('keydown', event => {
    if (event.key === 'Escape') post('escape');
});

// The parent cannot know when the frame's script is ready, so the frame says
// so. It has no origin to reply to yet, hence the wildcard on this one
// message, which carries nothing.
parent.postMessage({ channel: CHANNEL, type: 'loaded' }, '*');
