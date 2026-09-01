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
        code: (file = 'main.js') => ydoc.getMap('files').get(file).toString(),
        ytext: (file = 'main.js') => ydoc.getMap('files').get(file),
        paths: () => [...ydoc.getMap('files').keys()].sort(),
        schema: () => ydoc.getMap('meta').get('schema'),
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

test('edits to different files converge without bleeding into each other', async () => {
    const server = await startServer();
    try {
        const roomId = `files-${Date.now()}`;
        const alice = await connect({ roomId, userName: 'alice' });
        const bob = await connect({ roomId, userName: 'bob' });
        await settle(300);

        assert.deepEqual(alice.paths(), ['Main.java', 'main.cpp', 'main.js', 'main.py']);

        // Two users working in different files at the same time.
        alice.ytext('main.js').insert(0, 'FROM_ALICE ');
        bob.ytext('main.py').insert(0, 'FROM_BOB ');
        await settle(600);

        assert.ok(bob.code('main.js').includes('FROM_ALICE'), "alice's file did not reach bob");
        assert.ok(alice.code('main.py').includes('FROM_BOB'), "bob's file did not reach alice");
        assert.ok(!alice.code('main.js').includes('FROM_BOB'), 'edits crossed files');

        alice.socket.close();
        bob.socket.close();
    } finally {
        await stopServer(server);
    }
});

test('creating and deleting a file propagates to the room', async () => {
    const server = await startServer();
    try {
        const roomId = `crud-${Date.now()}`;
        const alice = await connect({ roomId, userName: 'alice' });
        const bob = await connect({ roomId, userName: 'bob' });
        await settle(300);

        alice.ydoc.transact(() => {
            const files = alice.ydoc.getMap('files');
            files.set('src/helper.js', new Y.Text());
            files.get('src/helper.js').insert(0, 'export const x = 1;');
        });
        await settle(500);

        assert.ok(bob.paths().includes('src/helper.js'), 'new file did not reach bob');
        assert.equal(bob.code('src/helper.js'), 'export const x = 1;');

        bob.ydoc.getMap('files').delete('src/helper.js');
        await settle(500);

        assert.ok(!alice.paths().includes('src/helper.js'), 'delete did not reach alice');

        alice.socket.close();
        bob.socket.close();
    } finally {
        await stopServer(server);
    }
});

test('a language-keyed snapshot migrates onto file paths', async () => {
    // Build the snapshot the pre-multi-file server would have written.
    const legacy = new Y.Doc();
    legacy.transact(() => {
        const files = legacy.getMap('files');
        files.set('javascript', new Y.Text());
        files.get('javascript').insert(0, '// written before multi-file\n');
        legacy.getMap('meta').set('language', 'javascript');
    });

    const roomId = `legacy-${Date.now()}`;
    const file = path.join(
        persistDir,
        `${Buffer.from(roomId).toString('base64url')}.json`
    );
    await fs.writeFile(file, JSON.stringify({
        state: Buffer.from(Y.encodeStateAsUpdate(legacy)).toString('base64'),
        passwordHash: null,
        updatedAt: new Date().toISOString(),
    }));

    const server = await startServer();
    try {
        const alice = await connect({ roomId, userName: 'alice' });
        await settle(300);

        assert.equal(alice.schema(), 2, 'schema was not stamped');
        assert.ok(!alice.paths().includes('javascript'), 'legacy key survived');
        assert.ok(
            alice.code('main.js').includes('written before multi-file'),
            'legacy content was lost'
        );

        alice.socket.close();
    } finally {
        await stopServer(server);
    }
});

test('running a file that does not exist is reported', async () => {
    const server = await startServer();
    try {
        const roomId = `missing-${Date.now()}`;
        const alice = await connect({ roomId, userName: 'alice' });
        await settle(200);

        const responded = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no codeResponse')), 5000);
            alice.socket.on('codeResponse', (payload) => {
                clearTimeout(timer);
                resolve(payload);
            });
        });

        alice.socket.emit('compileCode', { roomId, path: 'nope.js', input: '' });
        const payload = await responded;
        assert.match(payload.run.output, /No such file: nope\.js/);

        alice.socket.close();
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
        alice.ytext('main.js').insert(0, '// survives restart\n');
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
