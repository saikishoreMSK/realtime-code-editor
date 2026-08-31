// Integration smoke test for the CRDT sync layer.
//
// Drives two real Socket.IO clients against a real server process and asserts the
// behaviour that full-document broadcast could not provide: concurrent edits to the
// same offset converge with both users' input preserved.
//
//   npm test
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import * as Y from 'yjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

let persistDir;
// Each server gets an ephemeral port, so a stray process from an earlier run can
// never poison the suite.
let url;

function startServer() {
    const child = spawn(process.execPath, ['backend/index.js'], {
        env: {
            ...process.env,
            PORT: '0',
            PERSISTENCE: 'fs',
            PERSIST_DIR: persistDir,
            FLUSH_INTERVAL_MS: '300',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server start timed out')), 45000);
        let buf = '';
        child.stdout.on('data', (d) => {
            buf += d;
            const match = buf.match(/Server is running on port (\d+)/);
            if (match) {
                url = `http://localhost:${match[1]}`;
                clearTimeout(timer);
                resolve(child);
            }
        });
        child.stderr.on('data', (d) => process.stderr.write(d));
        child.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
    });
}

async function stopServer(child) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited;
}

// Mirrors the browser client's sync wiring: local edits go out, remote updates come
// in tagged 'remote' so they are never echoed back.
function connect({ roomId, userName, password }) {
    const ydoc = new Y.Doc();
    const socket = io(url, { transports: ['websocket'] });

    ydoc.on('update', (update, origin) => {
        if (origin !== 'remote') socket.emit('yUpdate', update);
    });
    const apply = (update) => Y.applyUpdate(ydoc, new Uint8Array(update), 'remote');
    socket.on('yUpdate', apply);
    socket.on('ySync', (update) => {
        apply(update);
        // Mirrors the browser client: hand our own state back so the server
        // converges with anything we changed while disconnected.
        socket.emit('yUpdate', Y.encodeStateAsUpdate(ydoc));
    });

    const client = {
        socket,
        ydoc,
        code: (lang = 'javascript') => ydoc.getMap('files').get(lang).toString(),
        ytext: (lang = 'javascript') => ydoc.getMap('files').get(lang),
        language: () => ydoc.getMap('meta').get('language'),
    };

    return new Promise((resolve, reject) => {
        // A socket that never joined still retries forever, which keeps the test
        // process alive and hangs the whole runner. Always close it on failure.
        const fail = (err) => {
            clearTimeout(timer);
            socket.close();
            reject(err);
        };
        const timer = setTimeout(
            () => fail(new Error(`${userName} join timed out`)),
            10000
        );
        // Left registered on purpose: Socket.IO re-fires 'connect' after a
        // reconnect, and re-joining is what puts the socket back in the room.
        socket.on('connect', () => {
            socket.emit('join', { roomId, userName, password, clientId: ydoc.clientID });
        });
        socket.on('ySync', () => {
            clearTimeout(timer);
            resolve(client);
        });
        socket.on('joinError', (msg) => fail(new Error(msg)));
        socket.on('connect_error', (err) => fail(new Error(`connect failed: ${err.message}`)));
    });
}

test.before(async () => {
    persistDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rce-test-'));
});

test.after(async () => {
    await fs.rm(persistDir, { recursive: true, force: true });
});

test('concurrent edits at the same offset both survive', async () => {
    const server = await startServer();
    try {
        const roomId = `converge-${Date.now()}`;
        const alice = await connect({ roomId, userName: 'alice' });
        const bob = await connect({ roomId, userName: 'bob' });
        await settle(300);

        assert.equal(alice.code(), bob.code(), 'clients did not start in sync');

        // The case that silently lost data under last-write-wins: two users insert
        // at position 0 with no knowledge of each other.
        alice.ytext().insert(0, 'AAA');
        bob.ytext().insert(0, 'BBB');
        await settle(600);

        assert.equal(alice.code(), bob.code(), 'documents diverged');
        assert.ok(alice.code().includes('AAA'), "alice's edit was lost");
        assert.ok(alice.code().includes('BBB'), "bob's edit was lost");

        alice.socket.close();
        bob.socket.close();
    } finally {
        await stopServer(server);
    }
});

test('active language syncs through the CRDT', async () => {
    const server = await startServer();
    try {
        const roomId = `lang-${Date.now()}`;
        const alice = await connect({ roomId, userName: 'alice' });
        const bob = await connect({ roomId, userName: 'bob' });
        await settle(300);

        bob.ydoc.getMap('meta').set('language', 'python');
        await settle(400);

        assert.equal(alice.language(), 'python');

        alice.socket.close();
        bob.socket.close();
    } finally {
        await stopServer(server);
    }
});

test('a dropped client has its cursor reaped for it', async () => {
    const server = await startServer();
    try {
        const roomId = `presence-${Date.now()}`;
        const alice = await connect({ roomId, userName: 'alice' });
        const bob = await connect({ roomId, userName: 'bob' });
        await settle(300);

        const departed = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no awarenessLeave')), 5000);
            alice.socket.on('awarenessLeave', (id) => { clearTimeout(timer); resolve(id); });
        });

        bob.socket.close();
        assert.equal(await departed, bob.ydoc.clientID);

        alice.socket.close();
    } finally {
        await stopServer(server);
    }
});

test('room content survives a server restart', async () => {
    const roomId = `persist-${Date.now()}`;
    let saved;

    let server = await startServer();
    try {
        const alice = await connect({ roomId, userName: 'alice' });
        alice.ytext().insert(0, '// survives restart\n');
        saved = alice.code();

        // Long enough for the debounced flush to reach disk.
        await settle(800);
        alice.socket.close();
    } finally {
        await stopServer(server);
    }

    server = await startServer();
    try {
        const carol = await connect({ roomId, userName: 'carol' });
        assert.equal(carol.code(), saved, 'room content was not restored');
        carol.socket.close();
    } finally {
        await stopServer(server);
    }
});

test('wrong password is rejected, correct one is accepted', async () => {
    const server = await startServer();
    try {
        const roomId = `locked-${Date.now()}`;
        const owner = await connect({ roomId, userName: 'owner', password: 's3cret' });
        await settle(200);

        await assert.rejects(
            () => connect({ roomId, userName: 'intruder', password: 'wrong' }),
            /Invalid room password/
        );

        const guest = await connect({ roomId, userName: 'guest', password: 's3cret' });
        assert.equal(typeof guest.code(), 'string');

        owner.socket.close();
        guest.socket.close();
    } finally {
        await stopServer(server);
    }
});

test('a reconnected client rejoins and syncs both ways', async () => {
    const server = await startServer();
    try {
        const roomId = `reconnect-${Date.now()}`;
        const alice = await connect({ roomId, userName: 'alice' });
        const bob = await connect({ roomId, userName: 'bob' });
        await settle(300);

        // Drop alice the way a flaky network or a proxy would.
        alice.socket.disconnect();
        await settle(200);
        alice.socket.connect();
        await settle(1000);

        // Without a re-join the server socket isn't in the room, so alice would
        // still be able to send but would receive nothing.
        bob.ytext().insert(0, 'FROM_BOB ');
        await settle(600);
        assert.ok(alice.code().includes('FROM_BOB'), 'reconnected client stopped receiving');

        alice.ytext().insert(0, 'FROM_ALICE ');
        await settle(600);
        assert.ok(bob.code().includes('FROM_ALICE'), 'reconnected client stopped sending');

        alice.socket.close();
        bob.socket.close();
    } finally {
        await stopServer(server);
    }
});
