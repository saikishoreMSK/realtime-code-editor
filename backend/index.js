// Corporate networks intercept TLS with their own CA, which Node doesn't trust.
// Only relax verification in local dev — never in production.
if (process.env.NODE_ENV !== 'production') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import axios from 'axios';
import path from 'path';
import * as Y from 'yjs';
import bcrypt from 'bcryptjs';
import { loadRoom, saveRoom, persistenceMode } from './persistence.js';
import {
    WANDBOX_COMPILERS,
    DEFAULT_FILES,
    LEGACY_LANGUAGE_PATHS,
    languageForPath,
    prepareSource,
} from './languages.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    // Yjs updates are binary; keep the default parser but allow larger frames
    // for the initial full-state sync of a long document.
    maxHttpBufferSize: 5e6,
});

// Overridable so tests don't have to wait out the production interval.
const FLUSH_INTERVAL_MS = Number(process.env.FLUSH_INTERVAL_MS) || 5000;

// Bumped when the document layout changes, so old snapshots can be migrated.
const SCHEMA_VERSION = 2;

/**
 * rooms: Map<roomId, {
 *   users: Map<socketId, userName>,
 *   ydoc: Y.Doc,
 *   passwordHash: string | null,
 *   dirty: boolean,
 *   isNew: boolean,
 * }>
 *
 * The Y.Doc holds:
 *   files: Y.Map<path, Y.Text>   one document per file, keyed by path
 *   meta:  Y.Map                 { schema }
 *
 * Which file a user is looking at is deliberately NOT in here: it is per-user
 * state, so that two people can work in different files at once.
 */
const rooms = new Map();

// Loading a cold room is async, so two simultaneous joins could each build their
// own Y.Doc and one would silently win. In-flight loads are memoised to prevent that.
const pendingRooms = new Map();

// Rooms created before multi-file keyed their buffers by language name. Without
// this an existing snapshot would look empty and get re-seeded, losing the code.
function migrateLanguageKeys(ydoc) {
    const files = ydoc.getMap('files');

    for (const [language, filePath] of Object.entries(LEGACY_LANGUAGE_PATHS)) {
        const legacy = files.get(language);
        if (!legacy || files.has(filePath)) continue;

        // Yjs has no move, so the text is copied to the new key and the old one dropped.
        const text = legacy.toString();
        files.delete(language);
        files.set(filePath, new Y.Text());
        files.get(filePath).insert(0, text);
    }
    ydoc.getMap('meta').delete('language');
}

function seedRoom(ydoc) {
    const files = ydoc.getMap('files');
    const meta = ydoc.getMap('meta');

    ydoc.transact(() => {
        if (meta.get('schema') !== SCHEMA_VERSION) {
            migrateLanguageKeys(ydoc);
            meta.set('schema', SCHEMA_VERSION);
        }

        // Only a genuinely empty room gets defaults. Re-seeding a room whose files
        // were all deleted would resurrect them on every load.
        if (files.size === 0) {
            for (const [filePath, code] of Object.entries(DEFAULT_FILES)) {
                files.set(filePath, new Y.Text());
                files.get(filePath).insert(0, code);
            }
        }
    });
}

function getRoom(roomId) {
    if (rooms.has(roomId)) return Promise.resolve(rooms.get(roomId));
    if (pendingRooms.has(roomId)) return pendingRooms.get(roomId);

    const loading = (async () => {
        const saved = await loadRoom(roomId);

        const ydoc = new Y.Doc();
        if (saved?.state) Y.applyUpdate(ydoc, saved.state);
        seedRoom(ydoc);

        const room = {
            users: new Map(),
            // socketId -> Yjs client id, so a dropped socket's cursor can be reaped.
            awarenessClients: new Map(),
            ydoc,
            passwordHash: saved?.passwordHash ?? null,
            dirty: !saved,
            isNew: !saved,
        };

        // Any change to the document — local seed or relayed edit — queues a flush.
        ydoc.on('update', () => { room.dirty = true; });

        rooms.set(roomId, room);
        pendingRooms.delete(roomId);
        return room;
    })();

    pendingRooms.set(roomId, loading);
    return loading;
}

async function flushRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room || !room.dirty) return;

    room.dirty = false;
    await saveRoom(roomId, {
        state: Y.encodeStateAsUpdate(room.ydoc),
        passwordHash: room.passwordHash,
    });
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    let currentRoom = null;

    const broadcastUsers = (roomId) => {
        const room = rooms.get(roomId);
        if (room) io.to(roomId).emit('userJoined', Array.from(room.users.values()));
    };

    const detach = () => {
        if (!currentRoom) return;

        const roomId = currentRoom;
        const room = rooms.get(roomId);
        currentRoom = null;

        if (!room) return;
        room.users.delete(socket.id);

        // A disconnected client can't clear its own awareness state, so its cursor
        // would linger in every other editor. Reap it on its behalf.
        const clientId = room.awarenessClients.get(socket.id);
        if (clientId !== undefined) {
            room.awarenessClients.delete(socket.id);
            io.to(roomId).emit('awarenessLeave', clientId);
        }

        socket.leave(roomId);
        broadcastUsers(roomId);

        // An empty room may never be touched again, so persist it now rather than
        // waiting for the next interval.
        if (room.users.size === 0) flushRoom(roomId);
    };

    socket.on('join', async ({ roomId, userName, password, clientId }) => {
        if (!roomId || !userName) return;
        detach();

        const room = await getRoom(roomId);

        // Only the room's creator sets its password; later joiners are checked
        // against it and can't take over an unprotected room.
        const isCreator = room.isNew;
        room.isNew = false;

        if (isCreator) {
            if (password) {
                room.passwordHash = await bcrypt.hash(password, 10);
                room.dirty = true;
            }
        } else if (room.passwordHash) {
            const ok = await bcrypt.compare(password || '', room.passwordHash);
            if (!ok) {
                socket.emit('joinError', 'Invalid room password ❌');
                return;
            }
        }

        currentRoom = roomId;
        socket.join(roomId);
        room.users.set(socket.id, userName);
        if (clientId !== undefined) room.awarenessClients.set(socket.id, clientId);

        // Full document state for the newcomer, then incremental updates from here on.
        socket.emit('ySync', Y.encodeStateAsUpdate(room.ydoc));
        broadcastUsers(roomId);
    });

    socket.on('yUpdate', (update) => {
        const room = rooms.get(currentRoom);
        if (!room) return;

        // Socket.IO hands us a Buffer/ArrayBuffer; Yjs needs a Uint8Array.
        const bytes = new Uint8Array(update);
        // Tagging the origin marks this as a relayed edit rather than a server-local one.
        Y.applyUpdate(room.ydoc, bytes, 'remote');
        socket.to(currentRoom).emit('yUpdate', bytes);
    });

    socket.on('awareness', (update) => {
        if (!currentRoom) return;
        // Cursors and selections are ephemeral — relayed to the room, never persisted.
        socket.to(currentRoom).emit('awareness', new Uint8Array(update));
    });

    socket.on('typing', ({ roomId, userName }) => {
        socket.to(roomId).emit('userTyping', userName);
    });

    socket.on('leaveRoom', detach);

    // Wandbox pins its own runtime versions, so no client-supplied version is used.
    socket.on('compileCode', async ({ roomId, path: entryPath, input }) => {
        const room = rooms.get(roomId);
        if (!room) return;

        // Output goes only to the requester. Now that each user picks their own
        // file, broadcasting would let one person's run overwrite another's console
        // while they were still reading it.
        const sendOutput = (output) => {
            socket.emit('codeResponse', { run: { output, path: entryPath } });
        };

        const files = room.ydoc.getMap('files');
        const entry = files.get(entryPath);
        if (!entry) {
            sendOutput(`No such file: ${entryPath}`);
            return;
        }

        const language = languageForPath(entryPath);
        const target = language && WANDBOX_COMPILERS[language];
        if (!target) {
            sendOutput(`Cannot run ${entryPath} — no runtime for this file type.`);
            return;
        }

        // Execute the server's authoritative copy, not text supplied by the client.
        const code = prepareSource(language, entry.toString());

        // Same-language siblings ride along so includes and imports can resolve.
        // Wandbox's filesystem is flat, so paths collapse to their basename; the
        // first file to claim a name wins.
        const siblings = new Map();
        files.forEach((text, filePath) => {
            if (filePath === entryPath) return;
            if (languageForPath(filePath) !== language) return;

            const name = filePath.split('/').pop();
            if (!siblings.has(name)) siblings.set(name, text.toString());
        });

        try {
            const response = await axios.post(
                'https://wandbox.org/api/compile.json',
                {
                    code,
                    compiler: target.compiler,
                    options: target.options || '',
                    stdin: input || '',
                    ...(siblings.size > 0
                        ? { codes: [...siblings].map(([file, body]) => ({ file, code: body })) }
                        : {}),
                },
                { timeout: 30000 }
            );

            const d = response.data;
            // Compile errors live in compiler_error; runtime output in program_output/error.
            const output = [d.compiler_error, d.program_output, d.program_error]
                .filter(Boolean).join('').trim();
            sendOutput(output || '(no output)');
        } catch (err) {
            const status = err.response?.status;
            console.error('Compile failed:', status, err.message);

            // A failure in the execution service and a failure in the user's code
            // call for completely different reactions, so say which one happened.
            if (status >= 500) {
                sendOutput(
                    `The execution service is currently failing (HTTP ${status}).
`
                    + `This is not a problem with your code — try again later.`
                );
            } else if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) {
                sendOutput('Execution timed out after 30 seconds.');
            } else if (status) {
                sendOutput(`The execution service rejected the request (HTTP ${status}).`);
            } else {
                sendOutput(`Could not reach the execution service: ${err.message}`);
            }
        }
    });

    socket.on('disconnect', () => {
        detach();
        console.log('User disconnected:', socket.id);
    });
});

// Debounced flush: edits only mark a room dirty, and one timer persists them all.
// Writing per keystroke would hammer the disk for no benefit.
setInterval(async () => {
    for (const [roomId, room] of rooms) {
        await flushRoom(roomId);
        // Empty, fully-persisted rooms are dropped from memory; they reload on demand.
        // Skipped when persistence is off, since memory is then the only copy.
        if (persistenceMode !== 'none' && room.users.size === 0 && !room.dirty) {
            rooms.delete(roomId);
        }
    }
}, FLUSH_INTERVAL_MS).unref();

const port = process.env.PORT || 5000;
const __dirname = path.resolve();

app.use(express.static(path.join(__dirname, '/frontend/dist')));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'dist', 'index.html'));
});

server.listen(port, () => {
    // Report the bound port rather than the requested one, so PORT=0 (used by the
    // tests to grab any free port) still tells callers where to connect.
    const bound = server.address().port;
    console.log(`Server is running on port ${bound} (persistence: ${persistenceMode})`);
});

// Render sends SIGTERM on spin-down; flushing here is what lets rooms survive it.
let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    io.close();
    await Promise.all([...rooms.keys()].map(flushRoom));
    server.close(() => process.exit(0));
    // Don't hang forever if a socket refuses to close.
    setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
