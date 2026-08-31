# Real-Time Collaborative Code Editor

A browser-based collaborative code editor where multiple people can write and run code in the same room simultaneously. Built on WebSockets, with live cursor tracking, typing indicators, and sandboxed multi-language execution.

**Live demo:** [Collborative-Code-Editor](https://realtime-code-editor-blfs.onrender.com/)

---

## Features

- **Conflict-free concurrent editing** — a CRDT (Yjs) merges simultaneous edits, so two people typing on the same line both keep their work
- **Live cursors and selections** — see where each collaborator is typing, labelled by name and colour
- **Persistent rooms** — code survives a server restart or shutdown
- **Typing indicators** — know who is actively editing
- **Multi-language execution** — run JavaScript, Python, Java, and C++ with custom stdin
- **Per-language code persistence** — switching languages preserves what you wrote in each
- **GitHub integration** — browse a repository, open a file into the room, commit it back, and open a pull request
- **Optional room passwords** — protect a room at creation time
- **Monaco Editor** — the same editor engine that powers VS Code

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Monaco Editor |
| Realtime | Socket.IO (WebSockets) |
| Conflict resolution | Yjs (CRDT), y-monaco |
| Backend | Node.js, Express |
| Code execution | Wandbox API |
| Source control | GitHub REST API (browser-side) |
| Hosting | Render |

---

## Architecture

A single Express process serves both the built React app and the Socket.IO server, so the client connects back to its own origin with no cross-origin configuration.

Room state lives in an in-memory `Map` on the server, backed by snapshots on disk:

```
rooms: Map<roomId, {
  users:             Map<socketId, userName>,
  awarenessClients:  Map<socketId, yjsClientId>,
  ydoc:              Y.Doc,
  passwordHash:      string | null,
  dirty:             boolean,
}>
```

Each room's document is a `Y.Doc` containing:

```
files: Y.Map<string, Y.Text>   // keyed by language; will key by file path later
meta:  Y.Map                   // { language }
```

Clients exchange binary CRDT updates rather than whole documents. The server applies
every update to its own `Y.Doc` — so it stays the authoritative copy, and code
execution runs the server's text rather than anything a client supplies — then
relays the update to the rest of the room. Because Yjs guarantees convergence,
concurrent edits to the same position merge instead of overwriting each other.

Presence (cursors and selections) travels over a separate channel and is never
persisted. A client that disconnects cannot retract its own cursor, so the server
reaps it on that client's behalf.

Documents are snapshotted behind a two-function storage interface
(`loadRoom` / `saveRoom` in `backend/persistence.js`). Edits only mark a room dirty;
a single timer flushes all dirty rooms every 5 seconds, and again when a room empties
or the process receives `SIGTERM`. Writes go to a temp file and are renamed into
place, so a crash mid-write cannot corrupt an existing snapshot. Setting
`PERSISTENCE=none` runs the server fully in-memory.

### Socket events

| Event | Direction | Purpose |
|---|---|---|
| `join` | client → server | Join or create a room |
| `joinError` | server → client | Rejected join (bad password) |
| `userJoined` | server → room | Updated participant list |
| `ySync` | server → client | Full CRDT state for a newly joined client |
| `yUpdate` | both | Incremental binary CRDT update |
| `awareness` | both | Cursor and selection state (ephemeral) |
| `awarenessLeave` | server → room | Reap a dropped client's cursor |
| `typing` / `userTyping` | both | Typing indicators |
| `compileCode` / `codeResponse` | both | Execute code, return output |
| `leaveRoom` | client → server | Leave and update the room |

The active language is stored in the CRDT rather than broadcast separately, so it
persists with the snapshot and a late joiner receives the right language along with
the right code.

Code execution is delegated to the [Wandbox](https://wandbox.org) API, which compiles and runs submissions in its own sandbox. No untrusted code executes on this server, and no API key is required.

Wandbox writes every submission to a fixed filename (`prog.java` for Java), which
`javac` rejects for a `public` class whose name doesn't match. `backend/languages.js`
strips the modifier from top-level declarations before submitting — valid Java that
leaves the user's code semantically unchanged.

---

## GitHub integration

Browse any repository, open a file into the room, commit changes back, open a pull
request, and load an earlier version from the file's commit history.

Authentication is a **personal access token pasted into the UI**, not OAuth. The
token needs `Contents: read and write` to commit and `Pull requests: write` to open
a PR. Public repositories can be browsed and opened with no token at all.

### Where the token lives

Requests go straight from the browser to `api.github.com`, which permits
cross-origin calls and exposes its rate-limit headers, so no proxy is needed. The
token therefore never reaches this app's server. Three rules keep it that way:

- held in component state, optionally mirrored to `sessionStorage` so it dies with the tab — never `localStorage`
- **never written into the `Y.Doc`**, which is broadcast to every participant and snapshotted to disk
- never logged, and rendered masked

OAuth was considered and rejected: it needs a callback route and somewhere to keep
tokens at rest, which would make this server responsible for third-party
credentials it currently never sees.

### Opening a file

`GET /git/trees/{ref}?recursive=1` returns a flat list of paths, which
`buildTree` folds into a nested structure for the sidebar. Monaco is only a text
editor — it has no file explorer — so the tree is a component in this repo, written
to be reusable for the room's own documents later.

Opening a file replaces the active buffer inside a single Yjs transaction, so the
room receives one CRDT update rather than a burst, and every participant sees it.

### Committing

Commits use the contents API (`PUT /contents/{path}`), which needs the current blob
`sha` to update a file and none to create one. A stale `sha` returns 409 and is
surfaced as a readable conflict. Pull requests create a branch from the current ref,
commit onto it, and then `POST /pulls`.

---

## Running locally

Requires Node.js 22.x.

```bash
git clone https://github.com/saikishoreMSK/realtime-code-editor.git
cd realtime-code-editor
```

### Development (hot reload)

Two terminals — the Vite dev server proxies `/socket.io` to the backend.

```bash
# terminal 1 — backend on :5000
npm install
npm run dev

# terminal 2 — frontend on :5173
cd frontend
npm install
npm run dev
```

Open http://localhost:5173

### Production build

```bash
npm run build   # installs both workspaces and builds the frontend
npm start
```

Open http://localhost:5000

> **Note:** `npm start` serves the compiled bundle from `frontend/dist`. After changing frontend code you must re-run `npm run build`, or use the development flow above.

---

## Deployment (Render)

Create a **Web Service** pointing at this repo:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Start command | `npm start` |
| Environment | `NODE_ENV=production` |

The server binds to `process.env.PORT`, which Render injects automatically.

`NODE_ENV=production` matters: it enables full TLS certificate verification for outbound requests. In development the app relaxes verification so it can reach the execution API from behind TLS-intercepting corporate proxies.

---

## Testing

```bash
npm test
```

Integration tests spawn a real server on an ephemeral port and drive multiple
Socket.IO clients against it, asserting that concurrent edits to the same offset
converge with both users' input intact, that presence is cleaned up when a client
drops, that a room's contents survive a restart, and that room passwords are
enforced. Unit tests cover the Java source adaptation, and the GitHub client is
tested against a stubbed `fetch` — including the UTF-8 base64 round trip, which is
where a naive `btoa` implementation corrupts non-ASCII source.

---

## Known limitations

- **Single instance only.** Room state is held per-process, so running more than one instance would place users in different `Map`s and silently break sync. Horizontal scaling would require the Socket.IO Redis adapter and a shared store.
- **Snapshots are local to the disk they were written on.** The `fs` adapter is fine for a single instance, but Render's free tier uses an ephemeral disk, so rooms still reset on spin-down there. Swapping in a hosted adapter is a single new file behind the existing interface.
- **Execution depends on a third-party service.** Wandbox is a free community API with no uptime guarantee. Failures surface in the output console rather than crashing the server.
- **Single file per language.** A room holds one buffer per language rather than a project tree, so a repository is browsed in full but opened one file at a time.
- **Base64 through the contents API.** Files above roughly 1 MB cannot be opened, and binary files are filtered out of the tree.
- **No rate limiting on execution.** Nothing throttles how often a room can invoke the execution API.

---

## Possible improvements

- Redis-backed room state and pub/sub adapter for multi-instance scaling
- Multi-file projects with a file tree, backed by the existing `Y.Map` of documents
- Self-hosted container runtime to remove the third-party execution dependency
- Version history and diffing, using the snapshots already being written
- Per-user rate limiting and a bounded execution queue
