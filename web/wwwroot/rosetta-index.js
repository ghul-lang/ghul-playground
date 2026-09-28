// The Rosetta Code task index, and what to suggest running next.
//
// The index is ghul-rosetta-code's own `index.json`, generated from the tasks
// on each push to its main and published on a branch holding nothing else, so
// it cannot drift from what is there to run. It is fetched once, lazily, and a
// fetch that fails leaves the page exactly as it was: the strip is an
// offer, and an offer that cannot be made is not an error.
//
// Nothing here touches the document. What to suggest is a decision about data,
// and keeping it separate is what lets it be tested without a browser.

const INDEX_URL =
    'https://raw.githubusercontent.com/ghul-lang/ghul-rosetta-code/index/index.json';

// Tasks whose point is a picture. Derived rather than stored, so there is one
// fewer field to fall out of step with the tasks: a task that produces images,
// or that is tagged as graphics or fractal, is exactly the visual set.
const VISUAL_TAGS = new Set(['graphics', 'fractal']);

// Weighted up alongside the visual ones: a task somebody can play with holds
// attention for the same reason a picture does.
const ENGAGING_TAGS = new Set(['interactive', 'game', 'animation', 'simulation']);

export function isVisual(task) {
    return (task.images?.length ?? 0) > 0 || (task.tags ?? []).some(tag => VISUAL_TAGS.has(tag));
}

// A suggestion opens a task at its first part, so it is the first part's own
// flag that says whether it can run here - a task whose later parts run is no
// use if the one a reader lands on does not.
export function isRunnable(task) {
    const first = task.parts?.[0];

    return first ? first.playground === true : task.playground === true;
}

let pending = null;

// The index, fetched at most once per page. The promise is cached rather than
// the value, so two callers during the first fetch share it rather than making
// two requests, and a failure resolves to null rather than rejecting: every
// caller's answer to a missing index is the same, which is to show nothing.
export function loadIndex(fetchImpl = fetch) {
    pending ??= fetchImpl(INDEX_URL)
        .then(response => response.ok ? response.json() : null)
        .then(index => Array.isArray(index?.tasks) ? index : null)
        .catch(() => null);

    return pending;
}

// How alike two tasks are: shared tags, with the ones that make somebody stay
// counted twice. Tags come from the index's own vocabulary, so this compares
// terms the corpus actually uses rather than words found in a title.
//
// The weightiest shared tag comes back with the score, because it is what the
// strip says about the task: the index gives every tag a one-line description,
// so a suggestion can be labelled in the corpus's own words rather than in
// words invented here.
function relatedness(task, to) {
    const tags = new Set(to.tags ?? []);

    let score = 0;
    let best = null;
    let bestWeight = 0;

    for (const tag of task.tags ?? []) {
        if (!tags.has(tag)) continue;

        const weight = VISUAL_TAGS.has(tag) || ENGAGING_TAGS.has(tag) ? 2 : 1;

        score += weight;

        if (weight > bestWeight) {
            best = tag;
            bestWeight = weight;
        }
    }

    return { score, tag: best };
}

// The task the index holds for a slug, or null. The page reads a task's parts
// through this rather than reaching into the index itself.
export function taskFor(index, slug) {
    return index?.tasks.find(task => task.slug === slug) ?? null;
}

// Whether the solution here has changed since its section was last posted to
// the wiki, which the index works out from the ledger. A task the index does
// not hold, or an index from before the field existed, says no.
export function isAheadOfWiki(index, slug) {
    return taskFor(index, slug)?.ahead_of_wiki === true;
}

// A stable order for equally-related tasks, so the strip does not reshuffle on
// every render, with `turn` moving the window along so that a reader who runs
// several tasks is not offered the same two each time.
function rotate(list, turn) {
    return list.length ? list.slice(turn % list.length).concat(list.slice(0, turn % list.length)) : list;
}

// Three tasks to offer beside `slug`: two like it, and one from the hand-kept
// showcase. Returns fewer only when the index has fewer to give, and an empty
// list when it has none - the caller shows nothing rather than a short strip
// padded with whatever was left.
export function suggestions(index, slug, turn = 0) {
    if (!index) return [];

    const current = index.tasks.find(task => task.slug === slug) ?? null;
    const runnable = index.tasks.filter(task => task.slug !== slug && isRunnable(task));
    const bySlug = new Map(runnable.map(task => [task.slug, task]));

    // The showcase first, so a related pick cannot take the task it names. It
    // is a list of slugs in a deliberate order, so it is rotated rather than
    // scored: whoever wrote it has already said which is best.
    const showcase = rotate((index.showcase ?? []).filter(s => s !== slug && bySlug.has(s)), turn)
        .slice(0, 1)
        .map(s => ({ ...bySlug.get(s), kind: 'showcase', reason: 'worth seeing' }));

    const taken = new Set(showcase.map(task => task.slug));

    const related = current
        ? runnable
            .filter(task => !taken.has(task.slug))
            .map(task => ({ task, ...relatedness(task, current) }))
            .filter(entry => entry.score > 0)
            .sort((a, b) => b.score - a.score
                || Number(isVisual(b.task)) - Number(isVisual(a.task))
                || a.task.slug.localeCompare(b.task.slug))
        : [];

    // Rotated within each score, not across the whole list, so moving the
    // window changes which of the equally-related tasks is offered without
    // demoting a closer one below a distant one.
    const best = related.length ? related[0].score : 0;
    const top = rotate(related.filter(entry => entry.score === best), turn);
    const rest = related.filter(entry => entry.score !== best);

    return [...top, ...rest]
        .slice(0, 2)
        .map(entry => ({
            ...entry.task,
            kind: 'related',
            // The vocabulary's own description of the tag the two tasks share.
            // An index without the vocabulary leaves the card unlabelled rather
            // than labelled with the bare tag, which says less than nothing to
            // somebody who has not read the corpus.
            reason: index.tags?.[entry.tag] ?? null
        }))
        .concat(showcase);
}
