// Which analyser events the client itself reports when its socket closes: a
// socket the page closed to move to another address is no failure, and one
// the service never answered is. The socket is a stand-in.
//
//   node test/analyser-reconnect.mjs

import { GhulLanguageClient } from '../web/wwwroot/lsp.js';

let failures = 0;

const check = (what, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${ok || !detail ? '' : `: ${detail}`}`);
};

const sockets = [];

class StandInSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url) {
        this.url = url;
        this.readyState = StandInSocket.CONNECTING;
        this.listeners = {};
        sockets.push(this);
    }

    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }

    // A close always arrives later, as a browser's does.
    close(reason = '') {
        setTimeout(() => {
            this.readyState = StandInSocket.CLOSED;
            (this.listeners.close ?? []).forEach(fn => fn({ reason }));
        }, 0);
    }
}

globalThis.WebSocket = StandInSocket;
globalThis.document = { hidden: false, addEventListener() { }, removeEventListener() { } };
globalThis.window = { addEventListener() { }, removeEventListener() { } };
globalThis.fetch = async () => ({ status: 404 });

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

const outcomes = [];
const client = new GhulLanguageClient('wss://example/analyse', { onOutcome: event => outcomes.push(event) });

client.connect();
client.setUrl('wss://example/analyse?target=wasm');
await settle();

check('moving to another target closes the socket and opens one at the new address',
    sockets.length === 2 && sockets[1].url === 'wss://example/analyse?target=wasm',
    sockets.map(s => s.url).join(', '));
check('the page closing its own socket is not counted', outcomes.length === 0, outcomes.join());

sockets[1].close();
await settle();

check('a handshake the service never answered is still unavailable', outcomes.join() === 'unavailable', outcomes.join());

client.dispose();
process.exit(failures ? 1 : 0);
