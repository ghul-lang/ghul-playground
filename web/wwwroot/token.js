// The access token, and asking for one.
//
// Stored per origin, so a reader who enters it once has it for every embedded
// example on every page: the frame is always served from the playground's own
// origin, whoever is framing it.
//
// This is a shared key, not an identity. It keeps a passer-by out of services
// that run the compiler on whatever they are sent; it is not a login.

const STORAGE_KEY = 'ghul-playground-token';

export function getToken() {
    try {
        return localStorage.getItem(STORAGE_KEY) || null;
    } catch {
        // Storage can be unavailable in a third-party frame with cookies
        // blocked. The token then lasts for the page rather than for ever,
        // which is worth having rather than failing outright.
        return memoryToken;
    }
}

let memoryToken = null;

export function setToken(token) {
    memoryToken = token || null;

    try {
        if (token) {
            localStorage.setItem(STORAGE_KEY, token);
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
    } catch { /* held in memory only */ }
}

// A small overlay over whatever it is given. Resolves with the token once one
// is entered, or with null if the reader dismisses it.
export function askForToken(container, { message } = {}) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'ghul-token-overlay';
        overlay.innerHTML = `
            <form class="ghul-token-form">
                <p class="ghul-token-title">Editing and running is in preview</p>
                <p class="ghul-token-message"></p>
                <input type="password" class="ghul-token-input"
                       placeholder="access token" autocomplete="off" spellcheck="false">
                <div class="ghul-token-buttons">
                    <button type="submit">use it</button>
                    <button type="button" class="ghul-token-cancel">not now</button>
                </div>
                <p class="ghul-token-ask">
                    Don't have one?
                    <a href="https://github.com/ghul-lang/ghul-playground/issues"
                       target="_blank" rel="noopener">Ask on GitHub</a>.
                </p>
            </form>`;

        // Says what this is and how to get in. Without that a reader meets a
        // password box with no way of knowing whether they are supposed to have
        // one, which reads as something being broken.
        overlay.querySelector('.ghul-token-message').textContent =
            message ?? 'If you have an access token, enter it to edit and run this example.';

        const input = overlay.querySelector('.ghul-token-input');

        const done = value => {
            overlay.remove();
            resolve(value);
        };

        overlay.querySelector('.ghul-token-form').addEventListener('submit', event => {
            event.preventDefault();

            const value = input.value.trim();
            if (!value) return;

            setToken(value);
            done(value);
        });

        overlay.querySelector('.ghul-token-cancel')
            .addEventListener('click', () => done(null));

        // `inset: 0` needs a positioned ancestor, and the container it is
        // handed may well be static.
        if (getComputedStyle(container).position === 'static') {
            container.style.position = 'relative';
        }

        container.appendChild(overlay);
        input.focus();
    });
}

// Injected rather than kept in a stylesheet, so both the standalone page and
// the embedded one get it without either having to remember to include it.
const STYLE = `
.ghul-token-overlay {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.92);
    font-family: system-ui, sans-serif;
}
.ghul-token-form {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 1.25rem;
    max-width: 22rem;
    border: 1px solid #ccc;
    border-radius: 8px;
    background: #fff;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12);
}
.ghul-token-title { margin: 0; font-size: 0.95rem; font-weight: 600; color: #111; }
.ghul-token-message { margin: 0; font-size: 0.9rem; color: #333; }
.ghul-token-ask { margin: 0; font-size: 0.8rem; color: #666; }
.ghul-token-ask a { color: #0b6bcb; }
.ghul-token-input { font: inherit; padding: 0.4rem 0.5rem; }
.ghul-token-buttons { display: flex; gap: 0.5rem; justify-content: flex-end; }
.ghul-token-buttons button { font: inherit; padding: 0.3rem 0.9rem; cursor: pointer; }
`;

if (typeof document !== 'undefined' && !document.getElementById('ghul-token-style')) {
    const style = document.createElement('style');
    style.id = 'ghul-token-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
}
