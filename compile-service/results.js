// What a compile answered, kept so the same source is not compiled again.
//
// Most of what this service is asked for is the same few hundred programs: a
// link from Rosetta Code opens the task's own page, the page runs it, and every
// visitor to that task sends the identical source. The result is a function of
// the source and the toolchain, so it can be answered from what the last
// visitor's compile produced.
//
// Keyed like the cells cache, on the toolchain identity - which hashes the
// compiler and the reference bytes, so an upgrade invalidates everything
// without being told - followed by the source. Bounded by bytes and evicted
// oldest-used first, so a reader making one-off edits cannot fill the disk.

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

// The key for one source under one toolchain. Length-prefixed, so no two
// different pairs can hash the same bytes.
function resultKey(toolchainId, source) {
    const hash = crypto.createHash('sha256');

    for (const part of [toolchainId, source]) {
        const bytes = Buffer.from(part, 'utf8');

        hash.update(`${bytes.length}:`);
        hash.update(bytes);
    }

    return hash.digest('hex');
}

// Whether a result says anything a later request can be given.
//
// A compile that failed is still an answer about the source and is worth
// keeping: a crawler rendering a page whose program does not compile asks for
// the same failure every time. A timeout is not - it says the service was
// busy, not that the source cannot be compiled, so caching one would answer
// every later request for that program with a failure it invented under load.
function isCacheable(result) {
    return !!result && !result.timedOut;
}

class ResultCache {
    constructor(directory, maxBytes) {
        this.directory = directory;
        this.maxBytes = maxBytes;
        this.entries = new Map();
        this.bytes = 0;
        this.hits = 0;
        this.misses = 0;

        // Identical sources arriving together, which is what a burst of
        // renders of one page is: the first compiles and the rest wait for
        // it rather than each compiling the same program.
        this.inFlight = new Map();
    }

    async init() {
        await fs.mkdir(this.directory, { recursive: true });

        for (const file of await fs.readdir(this.directory)) {
            const full = path.join(this.directory, file);

            if (!file.endsWith('.json')) {
                await fs.rm(full, { force: true });
                continue;
            }

            const stat = await fs.stat(full);

            this.entries.set(file.slice(0, -5), { size: stat.size, used: stat.mtimeMs });
            this.bytes += stat.size;
        }

        return this;
    }

    _file(key) {
        return path.join(this.directory, `${key}.json`);
    }

    // The result this key stands for, or null. A file that has gone or cannot
    // be read is a miss rather than a failure: the compile that follows is the
    // right answer either way.
    async get(key) {
        const entry = this.entries.get(key);

        if (!entry) {
            this.misses++;
            return null;
        }

        try {
            const text = await fs.readFile(this._file(key), 'utf8');

            this.hits++;
            entry.used = Date.now();

            return JSON.parse(text);
        } catch {
            this.entries.delete(key);
            this.bytes -= entry.size;
            this.misses++;

            return null;
        }
    }

    async put(key, result) {
        if (this.entries.has(key) || !isCacheable(result)) return;

        const text = JSON.stringify(result);
        const bytes = Buffer.byteLength(text);

        // Written beside and renamed, so a reader never sees half a result and
        // two services sharing a directory cannot interleave one.
        const temporary = `${this._file(key)}.${process.pid}.${crypto.randomUUID()}.tmp`;

        await fs.writeFile(temporary, text, 'utf8');
        await fs.rename(temporary, this._file(key));

        this.entries.set(key, { size: bytes, used: Date.now() });
        this.bytes += bytes;

        await this._evict();
    }

    async _evict() {
        if (this.bytes <= this.maxBytes) return;

        const oldest = [...this.entries].sort((a, b) => a[1].used - b[1].used);

        for (const [key, { size }] of oldest) {
            if (this.bytes <= this.maxBytes) break;

            this.entries.delete(key);
            this.bytes -= size;

            await fs.rm(this._file(key), { force: true });
        }
    }

    // Answer `key` from the cache, or from `compile()` once, however many
    // callers ask for it at the same time.
    async answer(key, compile) {
        const cached = await this.get(key);

        if (cached) return { ...cached, cached: true };

        const running = this.inFlight.get(key);

        if (running) return { ...await running, cached: true };

        const work = (async () => {
            const result = await compile();

            await this.put(key, result);

            return result;
        })();

        this.inFlight.set(key, work);

        try {
            return await work;
        } finally {
            this.inFlight.delete(key);
        }
    }

    describe() {
        return {
            entries: this.entries.size,
            bytes: this.bytes,
            maxBytes: this.maxBytes,
            hits: this.hits,
            misses: this.misses
        };
    }
}

module.exports = { ResultCache, resultKey, isCacheable };
