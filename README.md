# Real-Time Collaborative Code Editor

A browser-based collaborative code editor where multiple people can write and run code in the same room simultaneously. Built on WebSockets, with live cursor tracking, typing indicators, and sandboxed multi-language execution.

**Live demo:** _add your Render URL here_

---

## Features

- **Real-time collaboration** — code changes propagate to every user in the room instantly over WebSockets
- **Live cursors** — see where each collaborator is typing, labelled by name
- **Typing indicators** — know who is actively editing
- **Multi-language execution** — run JavaScript, Python, Java, and C++ with custom stdin
- **Per-language code persistence** — switching languages preserves what you wrote in each
- **Optional room passwords** — protect a room at creation time
- **Monaco Editor** — the same editor engine that powers VS Code

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Monaco Editor |
| Realtime | Socket.IO (WebSockets) |
| Backend | Node.js, Express |
| Code execution | Wandbox API |
| Hosting | Render |

---

## Architecture

A single Express process serves both the built React app and the Socket.IO server, so the client connects back to its own origin with no cross-origin configuration.

Room state lives in an in-memory `Map` on the server:

```
rooms: Map<roomId, { users: Set<userName>, code: string, password: string|null }>
```

The server is the single source of truth for each room's code. Clients emit deltas, the server persists them and rebroadcasts to everyone else in the room.

### Socket events

| Event | Direction | Purpose |
|---|---|---|
| `join` | client → server | Join or create a room |
| `joinError` | server → client | Rejected join (bad password) |
| `userJoined` | server → room | Updated participant list |
| `codeChange` | client → server | Broadcast an edit |
| `codeUpdate` | server → room | Apply a remote edit |
| `cursorChange` / `cursorUpdate` | both | Live cursor positions |
| `typing` / `userTyping` | both | Typing indicators |
| `languageChange` / `languageUpdate` | both | Sync the active language |
| `compileCode` / `codeResponse` | both | Execute code, return output |
| `leaveRoom` | client → server | Leave and update the room |

Code execution is delegated to the [Wandbox](https://wandbox.org) API, which compiles and runs submissions in its own sandbox. No untrusted code executes on this server, and no API key is required.

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

## Known limitations

- **Room state is in-memory.** Restarting the server clears all rooms and their code. On a free hosting tier that sleeps when idle, active sessions are lost on spin-down.
- **Single instance only.** Because room state is not shared externally, running more than one instance would place users in different `Map`s and silently break sync. Horizontal scaling would require the Socket.IO Redis adapter.
- **Execution depends on a third-party service.** Wandbox is a free community API with no uptime guarantee. Failures surface in the output console rather than crashing the server.
- **No last-write-wins conflict resolution.** Simultaneous edits to the same line resolve by whichever message arrives last; there is no CRDT or OT layer.

---

## Possible improvements

- Redis-backed room state for multi-instance scaling
- CRDT (Yjs / Automerge) for true conflict-free concurrent editing
- Self-hosted execution runtime to remove the third-party dependency
- Persistent rooms with authentication and saved sessions
