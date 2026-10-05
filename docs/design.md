# Design notes

How the playground is put together, and why. The [README](../README.md) covers
running and embedding it.

## where things run

| | runs where | handles untrusted source | executes untrusted code |
| --- | --- | --- | --- |
| editor | browser | yes | no |
| analyse service | server | yes | no |
| compile service | server | yes | no |
| the compiled program | **browser** | yes | yes, in the browser's sandbox |

The server compiles the source and sends the assembly back to the browser. The
browser loads and runs it. The server never runs what it compiles.

This is the main design decision. A .NET runtime in the browser has no host
filesystem, and no network beyond what the page already has. What it has in
place of a filesystem is one of its own, in the page's memory, which is emptied
with the tab: `IO.File.write_all_bytes` writes there and reads back, and
nothing a program writes exists anywhere but the tab that ran it. A program
that loops forever makes a tab stop responding; the server is not involved. The
program runs inside the browser's own sandbox, so escaping it would need a
browser vulnerability, which is not something this project can add to or take
away.

That in-memory filesystem is how a drawing reaches the page. `ghul.raster`
writes a PNG to it and prints `<<image plot.png>>`. The filesystem lives on the
page's thread - the program's thread reaches it through calls the runtime
forwards there - so the page reads the file as soon as the marker line appears
in the output, while the program is still running, and takes the line out.
Showing a name that is already on the page replaces that picture in place,
which is how a program animates: draw, show, sleep, and show the same name
again. See `web/wwwroot/live-output.js`.

The runner sets `GHUL_LIVE_IMAGES=1` in the program's environment, saying that
pictures are seen as they are shown. A program that animates takes its frame
delay from it, so the same program run under test or on a terminal does not
wait between frames nobody is watching.

Analysing as you type and compiling on demand are different jobs. The same
compiler binary does both, in different modes, so they are two services. The
analyse service holds one session open per editor. The compile service takes a
source file and returns an assembly.

The browser fetches the .NET runtime on the first run, not at page load. A
documentation page can embed several editors, and downloading the runtime for
each one on every visit would be several megabytes per page.

## running a program

The program runs on a worker thread, not on the browser's main thread, and that
is load-bearing rather than a tuning choice. `Console.ReadLine` is synchronous:
it cannot suspend and hand control back. A program that reads a line therefore
blocks the thread it is on until somebody types one, and if that thread were
the main thread the page could not collect the keystroke, so the program would
wait for something that could never arrive. The same fact makes output live:
the main thread is free to repaint while the program runs, where a synchronous
call across it shows nothing until the run has finished.

Two consequences follow. The page has to be cross-origin isolated, because
threading makes the wasm heap a `SharedArrayBuffer` - which is why both this
site and the documentation site that frames it send the isolation headers, and
why the documentation site moved off GitHub Pages, which cannot send them. And
nothing the page calls can reach a blocked thread, so the line cannot be
delivered by calling in: everything crossing that boundary crosses through
shared memory, described in `runner/src/channel.ghul`.

A program that reads and is never answered waits indefinitely. That is visible
rather than fatal - the page stays responsive, and Ctrl+D in the input box ends
the stream - where before the same program froze the tab.

## sessions

Each editor gets one WebSocket, one private workspace directory, and one
language server process. Processes are not shared between clients. The process
is the isolation boundary, so a session ends by ending its process.

A session closes after five minutes idle, and after an hour in any case. The
client reconnects and resends the document. There is only one file, so this is
cheap.

The client refers to its document by a fixed virtual path. The service maps
that path to the real workspace directory. The client never sees the real path
and cannot name any other.

Sessions are capped, not queued. A warm analyser uses tens of megabytes, so the
cap is what bounds the service's memory. `/health` still answers when every
slot is taken, so an embedding page can tell that the service is up.

## limits

Anyone can send source to the services, so the limits are on cost, not on who
is sending.

The compile service runs a fixed number of compiles at once and queues a few
more behind them. Past the queue it answers 503. Each compile gets ten seconds
and 32 KB of source. The compile cap is what keeps the container inside its
memory limit: a compile peaks near 200 MB, and without the cap thirty
simultaneous requests were enough to hit the limit, at which point the kernel
killed compilers and every request in flight failed.

The compiler is single threaded, so the cap is a count of cores as much as a
concurrency limit, and a host with more of them serves more clients at once
rather than serving any one of them faster. The same holds for an analyser, but
a session is idle between keystrokes rather than busy for its whole life, so
the analyse service deliberately allows more sessions than it has cores.

The analyse service caps the number of open sessions, with the idle timeout and
lifetime above. The cap bounds memory directly.

It also caps the sessions one address may hold, four by default, using the
address nginx passes in `X-Real-IP`. An address at that cap that connects again
takes the slot of its own session quiet longest, once that one has been quiet
for twenty seconds; with nothing quiet enough, the connection is refused. The
evicted editor goes dormant and reconnects when its reader next uses it.

nginx adds per-address limits in `deploy/nginx/playground-limits.conf`: a
compile rate limit, and a connection limit on the analyser set above the
service's own cap as a backstop. A proxy can only see addresses, so these bound
one client; the service caps above bound the total.

`ALLOWED_ORIGINS` lists the sites allowed to call the services from a browser.
It is not access control, because a non-browser client can send any origin
header or none. It stops another site from using this CPU through its own
visitors' browsers. Unset, any origin is accepted, which is right for local
development.

The containers run as a non-root user with a read-only root filesystem, all
capabilities dropped, `no-new-privileges`, a tmpfs for scratch space, and
memory, CPU and process limits. Outbound traffic is blocked by the host
firewall. Compose cannot do this, because a container needs a network for
inbound traffic and Docker does not offer inbound without outbound.

## session cells

An interactive session - a REPL - compiles one cell at a time, each against
the cells before it, and runs each in the page as a program is run. It is off
unless the compile service has `REPL_ENABLED=1`; unset, `/compile/cell` does
not exist.

The REPL page (`repl.html`, and `/repl/` on ghul.dev) offers a session whenever
`GET compile/cell` answers, and says whether sessions are switched off or the
service cannot be reached when it does not. The playground page links to it
when the analyse service's `/health` reports `repl: true`, which it does under
the same setting; asking there costs nothing, where `/compile/cell` is rate
limited. `REPL_ENABLED` is the one switch.

The page holds the session. Each request posts the source of every cell the
session has accepted, in order, with the new cell last, so only source ever
reaches the service, as for a whole program. The reply is the new cell's
assembly.

The service keeps the cell assemblies it builds in a cache on a disk volume, keyed by
a hash it computes over the toolchain and the ordered chain of cells up to and
including each one, and evicts the least recently used past 64 MB. A request
whose earlier cells are all cached compiles one cell; any that are missing are
compiled again first, in the same compiler process. A key never comes from a
request, so what a request can reach is decided by the sources it posts, and
only a cell that compiled is cached. A cell assembly carries nothing about who
asked for it, so the cache is shared.

A request holds one compile slot for as long as it takes, and is limited to 50
cells and 256 KB of source between them. A session whose earlier cells no
longer compile - the toolchain changed under it - is answered 409, and has to
be started again.

The page runs each cell with `CellRuntime` (`web/wwwroot/cell-runtime.js`), in a
hidden frame of its own holding the .NET runtime for the session. A cell of
definitions only has nothing to run and answers with no output. Managed code on
another thread cannot be interrupted from the browser, so stopping a cell that
will not finish removes the frame, and the next cell starts a new session in a
fresh one; the page around it is untouched. The frame is written as `srcdoc`
from `cell-host.html` rather than loaded by URL, because a document written
that way inherits the page's origin and its cross-origin isolation, which the
threaded runtime needs, whatever headers the server sends for the host page.

The input is analysed as the next cell would be compiled: the session's
prelude, then what has been typed, which the page gets from the frame. A
connection to `/analyse?repl` gets an analyser of its own, started in
submission mode, and is refused unless the analyse service also has
`REPL_ENABLED=1`. The earlier cells reach it by cache key: the page sends
`playground/addCells` with the key and name of each cell the compile service
answered for, and the analyse service copies the cached assembly into the
analyser's workspace under the cell's name and adds it to the reference set.
The cache is a volume the compile service writes and the analyse service
mounts read-only, and a key the cache does not hold is refused. The page
shifts positions by the prelude's length each way, and leaves semantic tokens
and inlay hints off the input, since those would cover the prelude too.

## the reference set

`REFERENCES` in `shared/toolchain.js` lists the framework assemblies user code
can use, alongside the two ghūl ones: the runtime, and `ghul.raster` for
drawing. Both are resolved to the exact assembly the web app ships, because
what a program is compiled against is what the browser binds it to. An assembly is on the list if what it offers runs in the browser. The
list is not a security boundary: the server only compiles, so the list does not
change what the server is exposed to.

Two things are left out. `System.Runtime.InteropServices.JavaScript` would let
a program script the page that hosts it. `System.Net.Http` maps to the
browser's `fetch`, which would let a program make requests from every visitor's
browser under this origin.

The list does not exclude the filesystem. `System.Runtime` forwards the
`System.IO` types and cannot be left out, so `IO.File` always compiles. This is
fine because the program runs in the browser, where the only filesystem is the
page's own memory and there is no host one to reach.

The list includes each assembly's transitive references. The compiler cannot
load a type whose members mention an assembly it does not have, and reports the
type's members as missing. Some entries are there only for this reason.

Both services read the same list. If they differed, the editor would show
errors the build does not, or miss errors the build reports.

## access tokens

The playground on ghul.dev runs without access tokens. Anyone can use it. Its
audience is everyone who reads ghul.dev, and a shared token cannot be given to
everyone without being public. The limits above bound the cost instead.
`/health` reports `tokensRequired: false` there.

The token mechanism is kept for a deployment with a smaller audience.
`PLAYGROUND_TOKENS` is a comma-separated list of shared tokens. Anyone with one
can use the services. There is no per-user identity, no expiry, and no
revocation except editing the list and restarting. With the variable unset the
services are open, and both print a warning at startup saying so.

The compile service takes the token as `Authorization: Bearer <token>` and
answers 401 without it. The analyse service takes it as a WebSocket
subprotocol, because a browser cannot set headers on a WebSocket and a query
parameter would appear in access logs. It is checked at the upgrade, so a bad
token means the socket never opens.

`/health` needs no token and reports `tokensRequired`, so an embedding page can
find out whether the service is up and whether to ask for a token before it has
one. If `/health` is unreachable the page assumes no token is needed, because
a token prompt is the wrong way to say the service is down. The browser keeps
the token in `localStorage` for the playground's origin, so it is entered once
and used by every embedded editor on every page.

An IP address allow list was tried first and removed. It cannot work when the
audience is the readers of a public site.

## no LSP client library

Monaco's own API is enough: `setModelMarkers` for diagnostics,
`registerHoverProvider`, `registerCompletionItemProvider`, and the same pattern
for semantic tokens and inlay hints. Each takes a callback, so
`web/wwwroot/lsp.js` speaks LSP directly in a few hundred lines. This avoids
`monaco-languageclient` and its `@codingame/monaco-vscode-*` dependency chain.

## why there is any C#

`web/Program.cs` exists because `[JSExport]`, which is how JavaScript calls into
.NET, is implemented by a Roslyn source generator. The generator emits a module
initializer that registers the method, and an unsafe wrapper that marshals
arguments through a `JSMarshalerArgument*` buffer. ghūl can emit the attribute,
but without the generated code the attribute does nothing.

Everything else the host does is in `runner/src/runner.ghul`: loading the
program, running it, and capturing its output.

The C# reaches it through `Assembly.Load` and `MethodInfo.Invoke` rather than by
naming `Playground.RUNNER`, and that is not a style choice. Every assembly the
ghūl compiler emits records a reference to `System.Runtime 8.0.0.0`, which is
not a version that exists, and Roslyn rejects the reference with `CS0012` as
soon as C# names a type from the assembly. Reflection is resolved by the runtime
rather than by Roslyn, so it is unaffected. When
[degory/ghul#2709](https://github.com/degory/ghul/issues/2709) is fixed, the
reflection can become a direct call.

This is also why `web.csproj` can reference `ghul.runtime` and `ghul.raster`
without trouble: nothing in the C# names a type from either. The browser binds
the user's program against them at run time, where the recorded version is
ignored.
