// What happened to a page's analysis session, reduced to the few moments a
// reader notices: completion, diagnostics and hover coming up, going dark, and
// coming back.
//
// Counted once per episode rather than once per attempt. A page that has lost
// its analyser retries on a timer, so counting every refused or failed attempt
// would measure how long a tab stayed open, not how many readers lost analysis.
//
//   connected     the page's first session became ready
//   refused       turned away because the address already holds its sessions
//   unavailable   the service could not be reached, and nothing said why
//   dropped       a ready session ended without the service or the page
//                 choosing to end it
//   reconnected   ready again after any of the three above
//
// A session given back for idleness, or by a page out of sight, is not an
// episode: the next thing the reader does brings it back, as intended.
export class AnalyserOutcomes {
    constructor(report) {
        this.report = report;
        this.everReady = false;
        this.trouble = null;
    }

    ready() {
        if (!this.everReady) {
            this.everReady = true;
            this.trouble = null;
            this.report('connected');
            return;
        }

        if (this.trouble) {
            this.trouble = null;
            this.report('reconnected');
        }
    }

    // `kind` is one of refused, unavailable or dropped. The same kind again,
    // before the session is back, is the same episode.
    failed(kind) {
        if (this.trouble === kind) return;

        this.trouble = kind;
        this.report(kind);
    }
}
