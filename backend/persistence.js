// Room snapshots are written behind a two-function interface so the storage
// backend can be swapped (local files today, Redis/Postgres later) without the
// socket layer knowing about it.
import fs from 'fs/promises';
import path from 'path';

const MODE = process.env.PERSISTENCE || 'fs';
const DIR = path.resolve(process.env.PERSIST_DIR || './data');

// Room ids come straight from user input, so they can't be trusted as filenames.
// base64url encoding sidesteps both path traversal and illegal characters.
const fileFor = (roomId) =>
    path.join(DIR, `${Buffer.from(String(roomId)).toString('base64url')}.json`);

const ready = MODE === 'fs' ? fs.mkdir(DIR, { recursive: true }) : Promise.resolve();

export const persistenceMode = MODE;

export async function loadRoom(roomId) {
    if (MODE !== 'fs') return null;
    await ready;

    try {
        const raw = await fs.readFile(fileFor(roomId), 'utf8');
        const { state, passwordHash } = JSON.parse(raw);
        return {
            state: state ? new Uint8Array(Buffer.from(state, 'base64')) : null,
            passwordHash: passwordHash ?? null,
        };
    } catch (err) {
        // A missing file just means the room has never been saved.
        if (err.code !== 'ENOENT') console.error(`Load ${roomId} failed:`, err.message);
        return null;
    }
}

export async function saveRoom(roomId, { state, passwordHash }) {
    if (MODE !== 'fs') return;
    await ready;

    const file = fileFor(roomId);
    const tmp = `${file}.tmp`;
    const body = JSON.stringify({
        state: Buffer.from(state).toString('base64'),
        passwordHash: passwordHash ?? null,
        updatedAt: new Date().toISOString(),
    });

    try {
        // Write-then-rename: a crash mid-write can't corrupt an existing snapshot,
        // which matters because we also flush on SIGTERM.
        await fs.writeFile(tmp, body);
        await fs.rename(tmp, file);
    } catch (err) {
        console.error(`Save ${roomId} failed:`, err.message);
    }
}
