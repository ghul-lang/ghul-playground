const { ResultCache, resultKey, isCacheable } =
    await import('../compile-service/results.js');
const { mkdtempSync, rmSync } = await import('fs');
const { tmpdir } = await import('os');
const path = await import('path');

let failures = 0;
const check = (what, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : ' - ' + detail}`);
    if (!ok) failures++;
};

const dir = mkdtempSync(path.join(tmpdir(), 'rc-test-'));
const cache = await new ResultCache(dir, 1024 * 1024).init();

check('a key depends on the source', resultKey('t', 'a') !== resultKey('t', 'b'));
check('a key depends on the toolchain', resultKey('t1', 'a') !== resultKey('t2', 'a'));
check('a timeout is not cacheable', !isCacheable({ ok: false, timedOut: true }));
check('a compile failure is cacheable', isCacheable({ ok: false, diagnostics: [{}] }));

let compiles = 0;
const compile = async () => { compiles++; await new Promise(r => setTimeout(r, 50));
    return { ok: true, diagnostics: [], assembly: 'AAA' }; };

const key = resultKey('t', 'source');
const [a, b] = await Promise.all([cache.answer(key, compile), cache.answer(key, compile)]);

check('two identical requests compile once', compiles === 1, `compiled ${compiles} times`);
check('both get the assembly', a.assembly === 'AAA' && b.assembly === 'AAA');

const c = await cache.answer(key, compile);
check('a later request is answered from the cache', compiles === 1 && c.cached === true);

let timeouts = 0;
const timeout = async () => { timeouts++; return { ok: false, diagnostics: [], assembly: null, timedOut: true }; };
const tkey = resultKey('t', 'slow');
await cache.answer(tkey, timeout);
await cache.answer(tkey, timeout);
check('a timeout is compiled again rather than remembered', timeouts === 2, `compiled ${timeouts} times`);

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
