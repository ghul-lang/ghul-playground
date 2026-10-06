// The compiled code of the program in the editor, shown in a tab of its own.
//
// Nothing here runs until the tab is opened: the listing comes from its own
// request to the compile service, which builds it apart from a Run, so a
// reader who never looks at it never pays for it. The answer is cached on the
// service by the source and the target, so a second look is quick.

const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Enough of CIL for the listing to read: comments, directives, labels,
// strings and type names. Registered once, the first time a listing is shown.
let ilRegistered = false;

function registerIl() {
    if (ilRegistered || monaco.languages.getLanguages().some(l => l.id === 'il')) {
        ilRegistered = true;
        return;
    }

    ilRegistered = true;

    monaco.languages.register({ id: 'il' });
    monaco.languages.setMonarchTokensProvider('il', {
        tokenizer: {
            root: [
                [/\/\/.*$/, 'comment'],
                [/\.[a-z][\w.]*/, 'keyword'],
                [/IL_[0-9a-f]+:?/, 'number'],
                [/"([^"\\]|\\.)*"/, 'string'],
                [/\[[^\]\s]+\]/, 'type'],
                [/\b(class|valuetype|instance|static|public|private|assembly|hidebysig|specialname|rtspecialname|cil|managed|void|bool|int32|int64|string|object|float64|float32|native|int)\b/, 'keyword'],
                [/\b0x[0-9a-fA-F]+\b|\b\d+\b/, 'number']
            ]
        }
    });
    monaco.languages.setLanguageConfiguration('il', {
        comments: { lineComment: '//' },
        brackets: [['{', '}'], ['(', ')']],
        folding: { markers: { start: /^\s*\{/, end: /^\s*\}/ } }
    });
}

// Enough of WAT for the listing to read: comments, the source-line markers
// among them, keywords and instructions, names, numbers and strings.
let watRegistered = false;

function registerWat() {
    if (watRegistered || monaco.languages.getLanguages().some(l => l.id === 'wat')) {
        watRegistered = true;
        return;
    }

    watRegistered = true;

    monaco.languages.register({ id: 'wat' });
    monaco.languages.setMonarchTokensProvider('wat', {
        tokenizer: {
            root: [
                [/;;.*$/, 'comment'],
                [/\(;/, 'comment', '@block'],
                [/"([^"\\]|\\.)*"/, 'string'],
                [/\$[^\s()]+/, 'variable'],
                [/\b(module|func|param|result|local|type|import|export|global|table|memory|elem|data|start|mut|rec|sub|final|struct|array|field|ref|null|tag)\b/, 'keyword'],
                [/\b[a-z][a-z0-9]*\.[a-z0-9_.]+\b/, 'type'],
                [/\b(block|loop|if|then|else|end|br|br_if|br_table|return|call|call_ref|call_indirect|drop|select|unreachable|nop|throw|try_table|catch)\b/, 'keyword'],
                [/-?\b(0x[0-9a-fA-F_]+|\d[\d_]*(\.\d+)?([eE][-+]?\d+)?)\b/, 'number']
            ],
            block: [
                [/;\)/, 'comment', '@pop'],
                [/./, 'comment']
            ]
        }
    });
    monaco.languages.setLanguageConfiguration('wat', {
        comments: { lineComment: ';;', blockComment: ['(;', ';)'] },
        brackets: [['(', ')']]
    });
}

/// The tab's label for a target, before an answer names the language itself.
export const viewLabel = target => target === 'wasm' ? 'WAT' : 'IL';

/// The assembly view in `panel`, fed by `fetchView`.
///
/// - panel: the element the view fills
/// - fetchView: `(scope) => Promise<{status, result}>`, the playground's
///   request to the compile service for the current source and target
/// - getSource: the source the editor holds now
/// - getTarget: the target a run would use now
/// - onLabel: called with the label the tab should carry
export function createAssemblyView({ panel, fetchView, getSource, getTarget, onLabel }) {
    let editor = null;
    let shown = null;
    let request = 0;

    // Whether a wasm listing shows the program's own functions or the whole
    // module. IL has nothing to leave out, so it is always the whole listing.
    let scope = 'program';

    const status = document.createElement('div');
    status.className = 'view-status';

    const host = document.createElement('div');
    host.className = 'view-listing';
    host.hidden = true;

    panel.replaceChildren(status, host);

    // The source and target a listing was made from, so a look at an
    // unchanged program asks for nothing at all.
    const current = () => ({ source: getSource(), target: getTarget(), scope });
    const same = (a, b) => a && b && a.source === b.source && a.target === b.target && a.scope === b.scope;

    function say(text, { spinning = false, action = null } = {}) {
        status.replaceChildren();
        status.hidden = !text;

        const words = document.createElement('span');
        words.textContent = text;
        status.append(words);

        if (spinning) {
            const spin = document.createElement('span');
            spin.className = 'spin';
            let frame = 0;
            spin.textContent = SPIN_FRAMES[0];
            const timer = setInterval(() => {
                if (!spin.isConnected) return clearInterval(timer);
                frame = (frame + 1) % SPIN_FRAMES.length;
                spin.textContent = SPIN_FRAMES[frame];
            }, 80);
            status.prepend(spin);
        }

        if (action) {
            const button = document.createElement('button');
            button.className = 'view-action';
            button.textContent = action.label;
            button.addEventListener('click', action.run);
            status.append(button);
        }
    }

    function listing(text, language) {
        if (language === 'il') registerIl();
        if (language === 'wat') registerWat();

        host.hidden = false;

        if (!editor) {
            editor = monaco.editor.create(host, {
                value: text,
                language,
                readOnly: true,
                domReadOnly: true,
                minimap: { enabled: false },
                lineNumbers: 'off',
                folding: true,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                renderLineHighlight: 'none',
                fontSize: 13
            });
        } else {
            monaco.editor.setModelLanguage(editor.getModel(), language);
            editor.setValue(text);
            editor.setScrollTop(0);
        }
    }

    // Asks for the listing of what the editor holds now, unless that is what
    // is already shown.
    async function refresh({ force = false } = {}) {
        const wanted = current();

        onLabel(viewLabel(wanted.target));

        if (!force && same(wanted, shown)) {
            say('');
            return;
        }

        const mine = ++request;

        say(`compiling for the ${viewLabel(wanted.target)} listing`, { spinning: true });

        let answer;

        try {
            answer = await fetchView(wanted.scope);
        } catch {
            answer = null;
        }

        if (mine !== request) return;

        const result = answer?.result;

        if (!answer || answer.status === 429 || answer.status === 503) {
            say('The compile service is busy. Try again in a moment.',
                { action: { label: 'Try again', run: () => refresh({ force: true }) } });
            return;
        }

        if (answer.status !== 200 || !result) {
            say(result?.error ?? `the compile service returned HTTP ${answer.status}`);
            return;
        }

        if (!result.ok) {
            say(result.timedOut
                ? 'The compile timed out, so there is no listing.'
                : `Fix the problems to see the ${viewLabel(wanted.target)}.`);
            host.hidden = true;
            shown = null;
            return;
        }

        onLabel(result.language === 'wat' ? 'WAT' : 'IL');
        listing(result.text, result.language ?? 'plaintext');
        shown = wanted;

        const cut = result.truncated ? ' The listing is long, so only its start is shown.' : '';
        const hidden = result.omitted ?? 0;

        if (hidden > 0) {
            say(`The program's own functions. ${hidden} library function${hidden === 1 ? '' : 's'} hidden.${cut}`,
                { action: { label: 'Show all', run: () => { scope = 'all'; refresh(); } } });
        } else if (wanted.scope === 'all' && result.language === 'wat') {
            say(`The whole module.${cut}`,
                { action: { label: 'Program only', run: () => { scope = 'program'; refresh(); } } });
        } else {
            say(cut.trim());
        }
    }

    return {
        /// Shows the listing for what the editor holds now, asking for one
        /// only if it has changed since the last look.
        show: () => refresh(),
        /// Called when the source or target changes while the tab is open: the
        /// listing shown is no longer the program's, which the reader is told
        /// rather than having a compile started on every keystroke.
        changed: () => {
            if (same(current(), shown)) {
                say('');
                return;
            }

            onLabel(viewLabel(getTarget()));

            if (shown) {
                say('The program has changed since this listing.',
                    { action: { label: 'Update', run: () => refresh() } });
            }
        }
    };
}
