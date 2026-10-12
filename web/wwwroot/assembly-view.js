// The compiled code of the program in the editor, shown in a tab of its own.
//
// Nothing here runs until the tab is opened: the listing comes from its own
// request to the compile service, which builds it apart from a Run, so a
// reader who never looks at it never pays for it. The answer is cached on the
// service by the source and the listing, so a second look is quick.

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

// Enough of LLVM IR for the listing to read: comments, metadata, globals and
// locals, keywords, types, numbers and strings.
let llvmRegistered = false;

function registerLlvm() {
    if (llvmRegistered || monaco.languages.getLanguages().some(l => l.id === 'llvm-ir')) {
        llvmRegistered = true;
        return;
    }

    llvmRegistered = true;

    monaco.languages.register({ id: 'llvm-ir' });
    monaco.languages.setMonarchTokensProvider('llvm-ir', {
        tokenizer: {
            root: [
                [/;.*$/, 'comment'],
                [/c?"([^"\\]|\\.)*"/, 'string'],
                [/![\w.]+/, 'annotation'],
                [/[@%][-\w.$]+|[@%]"[^"]*"/, 'variable'],
                [/\b(define|declare|ret|br|switch|call|invoke|load|store|alloca|getelementptr|phi|select|icmp|fcmp|add|sub|mul|sdiv|udiv|srem|urem|fadd|fsub|fmul|fdiv|and|or|xor|shl|lshr|ashr|zext|sext|trunc|bitcast|ptrtoint|inttoptr|unreachable|landingpad|resume|global|constant|private|internal|external|type|to|label|nuw|nsw|inbounds|align)\b/, 'keyword'],
                [/\b(void|ptr|i\d+|half|float|double|opaque)\b/, 'type'],
                [/-?\b(0x[0-9a-fA-F]+|\d+(\.\d+)?([eE][-+]?\d+)?)\b/, 'number']
            ]
        }
    });
    monaco.languages.setLanguageConfiguration('llvm-ir', {
        comments: { lineComment: ';' },
        brackets: [['{', '}'], ['(', ')'], ['[', ']']]
    });
}

// Enough of objdump's AT&T listing for it to read: comments, function
// headers, addresses, registers and immediates.
let asmRegistered = false;

function registerAsm() {
    if (asmRegistered || monaco.languages.getLanguages().some(l => l.id === 'x86-asm')) {
        asmRegistered = true;
        return;
    }

    asmRegistered = true;

    monaco.languages.register({ id: 'x86-asm' });
    monaco.languages.setMonarchTokensProvider('x86-asm', {
        tokenizer: {
            root: [
                [/#.*$/, 'comment'],
                [/^[0-9a-f]+ <[^>]+>:$/, 'type'],
                [/^\s*[0-9a-f]+:/, 'number'],
                [/<[^>]+>/, 'type'],
                [/%\w+/, 'variable'],
                [/\$-?(0x[0-9a-fA-F]+|\d+)/, 'number'],
                [/\b(0x[0-9a-fA-F]+|\d+)\b/, 'number'],
                [/^\s+[a-z][\w.]*/, 'keyword']
            ]
        }
    });
    monaco.languages.setLanguageConfiguration('x86-asm', {
        comments: { lineComment: '#' }
    });
}

// The listings, in the order the tab always offers them, and what each is
// called. Each is what the compiler generates for one target, whatever the
// program runs on.
const KINDS = ['il', 'wat', 'llvm-ir', 'x86-asm'];
const KIND_LABELS = { 'il': 'IL', 'wat': 'WAT', 'llvm-ir': 'LLVM IR', 'x86-asm': 'x86-64' };

// The listing of what a run on `target` executes.
const runKind = target => target === 'wasm' ? 'wat' : 'il';

// Remembered for the session, so a reader looking at IR sees IR on the next
// program too. The storage can be absent or refuse, which leaves the default.
const KIND_KEY = 'mini-ide-listing';

function rememberedKind() {
    try {
        const kind = sessionStorage.getItem(KIND_KEY);
        return KINDS.includes(kind) ? kind : null;
    } catch {
        return null;
    }
}

function rememberKind(kind) {
    try {
        sessionStorage.setItem(KIND_KEY, kind);
    } catch { }
}

/// The tab's label for the listing a run on `target` executes.
export const viewLabel = target => KIND_LABELS[runKind(target)];

/// The assembly view in `panel`, fed by `fetchView`.
///
/// - panel: the element the view fills
/// - fetchView: `(scope, kind, optimise) => Promise<{status, result}>`, the
///   playground's request to the compile service for the current source
/// - getSource: the source the editor holds now
/// - getTarget: the target a run would use now, `wasm` or `dotnet`
/// - getKinds: `() => Promise<string[]>`, the listings the compile service
///   offers, in tab order
/// - onLabel: called with the label the tab should carry
export function createAssemblyView({ panel, fetchView, getSource, getTarget, getKinds, onLabel }) {
    let editor = null;
    let shown = null;
    let request = 0;

    // The listing the reader last chose, or null to show what a run executes,
    // which follows the target until a choice is made.
    let chosen = rememberedKind();
    const kind = () => chosen ?? runKind(getTarget());

    // Whether a listing shows the program's own functions or everything the
    // build holds. IL has nothing to leave out, so it is always the whole.
    let scope = 'program';

    // The level the x86-64 listing is built at: 2, what `ghul build` makes, or
    // 0, one function per method with every line marked.
    let optimise = 2;

    const label = () => KIND_LABELS[kind()];

    const kinds = document.createElement('div');
    kinds.className = 'view-kinds';
    kinds.hidden = true;

    const choice = document.createElement('div');
    choice.className = 'target';
    choice.setAttribute('role', 'group');
    choice.setAttribute('aria-label', 'Which compiled code to show');
    kinds.append(choice);

    // What applies to the listing chosen: how much of it, and for x86-64 the
    // level it was built at.
    const options = document.createElement('div');
    options.className = 'view-options';
    options.hidden = true;

    const status = document.createElement('div');
    status.className = 'view-status';

    const host = document.createElement('div');
    host.className = 'view-listing';
    host.hidden = true;

    // Under a native listing, where to go to build and run the program
    // natively: the question the listing raises.
    const caption = document.createElement('div');
    caption.className = 'view-caption';
    caption.hidden = true;

    panel.replaceChildren(kinds, options, status, host, caption);

    function offer(available) {
        const offered = KINDS.filter(k => available.includes(k));

        if (chosen && !offered.includes(chosen)) chosen = null;

        if (offered.length < 2) return;

        choice.replaceChildren(...offered.map(k => {
            const button = document.createElement('button');
            button.dataset.kind = k;
            button.textContent = KIND_LABELS[k];
            button.addEventListener('click', () => {
                if (kind() === k) return;
                chosen = k;
                scope = 'program';
                rememberKind(k);
                refresh();
            });
            return button;
        }));

        pressed();
        kinds.hidden = false;
    }

    // Which entry is chosen, and which is what a run executes: that one
    // carries a dot.
    function pressed() {
        const runs = runKind(getTarget());

        for (const button of choice.querySelectorAll('button')) {
            const k = button.dataset.kind;

            button.setAttribute('aria-pressed', String(k === kind()));
            button.classList.toggle('runs', k === runs);
            button.title = k === runs ? 'this is what runs in your browser' : '';
        }
    }

    function toggle(text, on, run) {
        const button = document.createElement('button');
        button.className = 'view-option';
        button.textContent = text;
        button.setAttribute('aria-pressed', String(on));
        button.addEventListener('click', run);
        return button;
    }

    // The secondary controls for the listing chosen. IL has none.
    function controls() {
        const parts = [];

        if (kind() !== 'il') {
            parts.push(
                toggle('program only', scope === 'program', () => { if (scope !== 'program') { scope = 'program'; refresh(); } }),
                toggle('show all', scope === 'all', () => { if (scope !== 'all') { scope = 'all'; refresh(); } }));
        }

        if (kind() === 'x86-asm') {
            const framing = document.createElement('span');
            framing.className = 'view-framing';
            framing.textContent = optimise === 2
                ? '-O2, what ghul build produces'
                : '-O0, one function per method, each line marked';

            parts.push(
                toggle('-O2', optimise === 2, () => { if (optimise !== 2) { optimise = 2; refresh(); } }),
                toggle('-O0', optimise === 0, () => { if (optimise !== 0) { optimise = 0; refresh(); } }),
                framing);
        }

        options.replaceChildren(...parts);
        options.hidden = parts.length === 0;
    }

    getKinds?.().then(offer, () => {});

    // What a listing was made from, so a look at an unchanged program asks
    // for nothing at all.
    const current = () => ({ source: getSource(), scope, kind: kind(), optimise });
    const same = (a, b) => a && b && a.source === b.source && a.scope === b.scope
        && a.kind === b.kind && a.optimise === b.optimise;

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
        if (language === 'llvm-ir') registerLlvm();
        if (language === 'x86-asm') registerAsm();

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

    function native(result) {
        const isNative = result.language === 'llvm-ir' || result.language === 'x86-asm';

        caption.hidden = !isNative;

        if (!isNative) return;

        const link = document.createElement('a');
        link.href = 'https://ghul.dev/native';
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Native executables';

        const built = result.toolchain ? `Built with ghul-llvm ${result.toolchain} for x86-64 Linux` : 'Built for x86-64 Linux';

        caption.replaceChildren(`${built}; to build and run it yourself, see `, link, '.');
    }

    // Asks for the listing of what the editor holds now, unless that is what
    // is already shown.
    async function refresh({ force = false } = {}) {
        const wanted = current();
        const name = label();

        onLabel(name);
        pressed();
        controls();

        if (!force && same(wanted, shown)) {
            say('');
            return;
        }

        const mine = ++request;

        say(`compiling for the ${name} listing`, { spinning: true });

        let answer;

        try {
            answer = await fetchView(wanted.scope, wanted.kind, wanted.optimise);
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
                : `Fix the problems to see the ${name}.`);
            host.hidden = true;
            caption.hidden = true;
            shown = null;
            return;
        }

        listing(result.text, result.language ?? 'plaintext');
        shown = wanted;
        native(result);

        const cut = result.truncated ? ' The listing is long, so only its start is shown.' : '';
        const hidden = result.omitted ?? 0;

        say(hidden > 0
            ? `${hidden} library function${hidden === 1 ? '' : 's'} hidden.${cut}`
            : cut.trim());
    }

    return {
        /// The label the tab carries for the listing chosen now.
        label,
        /// Shows the listing for what the editor holds now, asking for one
        /// only if it has changed since the last look.
        show: () => refresh(),
        /// Called when the source or target changes while the tab is open: the
        /// listing shown is no longer the program's, which the reader is told
        /// rather than having a compile started on every keystroke. A change of
        /// target moves only the dot.
        changed: () => {
            pressed();

            if (same(current(), shown)) {
                say('');
                return;
            }

            onLabel(label());

            if (shown) {
                say('The program has changed since this listing.',
                    { action: { label: 'Update', run: () => refresh() } });
            }
        }
    };
}
