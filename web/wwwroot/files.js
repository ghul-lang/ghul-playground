// Opening and saving a program as a file on the reader's own machine.
//
// Two mechanisms, because only some browsers have the good one. The File
// System Access API opens a file and writes back to that same file, which is
// what "save" has to mean; Firefox and Safari have neither half of it, so
// there opening is an <input type="file"> and saving is a download, which can
// only ever be "save a copy". The menu says which of the two it is doing
// rather than offering a Save that quietly means something else.
//
// This is not where the editor's contents are kept safe. The buffer is written
// to local storage on every edit and restored on load, so closing the tab
// without saving loses nothing; a file is for taking the program somewhere
// else.

// Whether this browser can write back to a file it opened. Both halves are
// checked: a browser with only the picker would offer a Save that cannot save.
export const canWriteFiles =
    typeof window.showOpenFilePicker === 'function'
    && typeof window.showSaveFilePicker === 'function';

const EXTENSION = '.ghul';

// What the picker offers. `description` is what the file-type dropdown shows,
// so it is worth being the language's name rather than "Custom Files".
const FILE_TYPES = [{
    description: 'ghūl source',
    accept: { 'text/plain': [EXTENSION] }
}];

// The handle of the file last opened or saved, so Save can write back to it
// across a reload. Handles are structured-cloneable but not serializable, so
// IndexedDB is the only place one can be kept - local storage cannot hold it.
const DB_NAME = 'ghul-playground';
const STORE = 'files';
const HANDLE_KEY = 'current';

// The name alone, which every browser can remember and which is what Save As
// offers as its default next time.
const NAME_KEY = 'ghul-playground-filename';

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);

        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Every call is wrapped: storage is unavailable in a private window and can be
// blocked outright, and a playground that will not load because it could not
// remember a filename would be a poor trade.
async function inStore(mode, work) {
    try {
        const db = await openDatabase();

        return await new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE, mode);
            const request = work(transaction.objectStore(STORE));

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch {
        return null;
    }
}

const rememberedName = () => {
    try { return localStorage.getItem(NAME_KEY); } catch { return null; }
};

const rememberName = name => {
    try { localStorage.setItem(NAME_KEY, name); } catch { }
};

// A name fit to offer in the save dialog, most deliberate first: the file this
// editor is already holding, then the program the page was asked for -
// /rosetta-code/100-doors saves as 100-doors.ghul - then whatever was saved
// last, then something neutral.
export function defaultName({ current, requested } = {}) {
    if (current) return current;

    const slug = requested?.name?.split('/').pop();

    return slug ? `${slug}${EXTENSION}` : (rememberedName() ?? `program${EXTENSION}`);
}

// The file Save writes back to, if this browser can and one has been opened.
// The permission is re-requested rather than assumed: it is not carried across
// a reload, and a handle whose permission has lapsed would fail at the write,
// which is the worst moment to find out.
async function currentHandle() {
    if (!canWriteFiles) return null;

    const handle = await inStore('readonly', store => store.get(HANDLE_KEY));

    if (!handle) return null;

    try {
        if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') return handle;
        if (await handle.requestPermission({ mode: 'readwrite' }) === 'granted') return handle;
    } catch {
        return null;
    }

    return null;
}

async function remember(handle) {
    rememberName(handle.name);
    await inStore('readwrite', store => store.put(handle, HANDLE_KEY));
}

// The name Save would write to, for the menu to show, or null when Save would
// have to ask. Read on opening the menu rather than kept in step, so it is
// right after a reload without anything having to restore it.
export async function savesTo() {
    return (await currentHandle())?.name ?? null;
}

// Gives up the file the editor is holding, as New does: the next Save falls
// through to Save as rather than writing the new program into the old file.
export async function forget() {
    try { localStorage.removeItem(NAME_KEY); } catch { }
    await inStore('readwrite', store => store.delete(HANDLE_KEY));
}

// Reads a file the reader picks. Returns its name and text, or null if they
// dismissed the dialog.
export async function open() {
    if (canWriteFiles) {
        let handle;

        try {
            [handle] = await window.showOpenFilePicker({ types: FILE_TYPES, multiple: false });
        } catch {
            // Dismissing the dialog throws AbortError, which is not a failure.
            return null;
        }

        await remember(handle);

        return { name: handle.name, text: await (await handle.getFile()).text() };
    }

    // Without the API, a hidden input is the only way to a file. It yields the
    // contents and the name but no handle, so a later Save can only download.
    return new Promise(resolve => {
        const input = document.createElement('input');

        input.type = 'file';
        input.accept = EXTENSION;

        input.addEventListener('change', async () => {
            const file = input.files?.[0];

            if (!file) {
                resolve(null);
                return;
            }

            rememberName(file.name);
            resolve({ name: file.name, text: await file.text() });
        });

        // Chosen or dismissed, the input has served its purpose. `cancel` does
        // not fire everywhere, so this is a courtesy rather than the cleanup.
        input.addEventListener('cancel', () => resolve(null));

        input.click();
    });
}

// Writes to the file already open. Answers false when there is none, which is
// the caller's cue to run saveAs instead.
export async function save(text) {
    const handle = await currentHandle();

    if (!handle) return false;

    const writable = await handle.createWritable();

    await writable.write(text);
    await writable.close();

    rememberName(handle.name);

    return handle.name;
}

// Asks where to put it. With the API this becomes the file Save writes to from
// now on; without it, this is a download and there is nothing to write back to.
export async function saveAs(text, suggestedName) {
    if (canWriteFiles) {
        let handle;

        try {
            handle = await window.showSaveFilePicker({ suggestedName, types: FILE_TYPES });
        } catch {
            return null;
        }

        const writable = await handle.createWritable();

        await writable.write(text);
        await writable.close();

        await remember(handle);

        return handle.name;
    }

    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a');

    link.href = url;
    link.download = suggestedName;
    link.click();

    // Revoked on the next turn rather than immediately: the download has not
    // necessarily started by the time click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    rememberName(suggestedName);

    return suggestedName;
}

// Saves a picture the program drew. It exists only in the page, so without
// this there is no way to get one out.
export function saveImage(url, name) {
    const link = document.createElement('a');

    link.href = url;
    link.download = name;
    link.click();
}
