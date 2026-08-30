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
import { WANDBOX_COMPILERS, DEFAULT_SNIPPETS, prepareSource } from './languages.js';

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
 *   files: Y.Map<string, Y.Text>   keyed by language today, by file path in future
 *   meta:  Y.Map                   { language }
 */
const rooms = new Map();

// Loading a cold room is async, so two simultaneous joins could each build their
// own Y.Doc and one would silently win. In-flight loads are memoised to prevent that.
const pendingRooms = new Map();

function seedRoom(ydoc) {
    const files = ydoc.getMap('files');
    const meta = ydoc.getMap('meta');

    for (const [language, code] of Object.entries(DEFAULT_SNIPPETS)) {
        if (!files.has(language)) {
            files.set(language, new Y.Text());
            files.get(language).insert(0, code);
        }
    }
    if (!meta.get('language')) meta.set('language', 'javascript');
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
    socket.on('compileCode', async ({ roomId, input }) => {
        const room = rooms.get(roomId);
        if (!room) return;

        const sendOutput = (output) => {
            io.to(roomId).emit('codeResponse', { run: { output } });
        };

        // Execute the server's authoritative copy, not text supplied by the client.
        const language = room.ydoc.getMap('meta').get('language') || 'javascript';
        const raw = room.ydoc.getMap('files').get(language)?.toString() ?? '';
        const code = prepareSource(language, raw);

        const target = WANDBOX_COMPILERS[language];
        if (!target) {
            sendOutput(`Unsupported language: ${language}`);
            return;
        }

        try {
            const response = await axios.post(
                'https://wandbox.org/api/compile.json',
                {
                    code,
                    compiler: target.compiler,
                    options: target.options || '',
                    stdin: input || '',
                },
                { timeout: 30000 }
            );

            const d = response.data;
            // Compile errors live in compiler_error; runtime output in program_output/error.
            const output = [d.compiler_error, d.program_output, d.program_error]
                .filter(Boolean).join('').trim();
            sendOutput(output || '(no output)');
        } catch (err) {
            console.error('Compile failed:', err.response?.status, err.message);
            sendOutput(`Execution failed: ${err.message}`);
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
