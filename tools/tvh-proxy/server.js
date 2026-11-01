/*
 * TVHeadend in-progress recording proxy for Jellyfin.
 *
 * TVHeadend writes recordings as growing .ts files. This service exposes
 * those files as never-ending HTTP streams so Jellyfin can treat an
 * in-progress recording like a live channel.
 *
 * Endpoints:
 *   GET /playlist.m3u          stable slot channels for the M3U tuner
 *   GET /playlist.m3u?dynamic=1  one channel per active recording (debug)
 *   GET /playlist.m3u?all=1    every recording, completed ones included
 *   GET /live/slot/<n>         stream the recording currently in slot n
 *   GET /live/<name>           stream a recording, following file growth
 *   GET /health                health check and slot mapping
 *
 * The playlist lists a fixed number of channels ("TVH 녹화 1"...) so Jellyfin
 * only has to refresh the tuner once. New recordings take free slots without
 * another guide refresh.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8099', 10);
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/recordings';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const ACTIVE_WINDOW_MS = parseInt(process.env.ACTIVE_WINDOW_MS || '120000', 10);
const IDLE_GRACE_MS = parseInt(process.env.IDLE_GRACE_MS || '30000', 10);
const SLOT_COUNT = parseInt(process.env.SLOT_COUNT || '4', 10);
const SLOT_FIRST_CHANNEL = parseInt(process.env.SLOT_FIRST_CHANNEL || '9001', 10);
const SCAN_MS = 2000;
const VIDEO_EXTENSIONS = new Set(['.ts', '.m2ts', '.mts', '.trp']);

const state = new Map();
// Recording name -> slot number. Kept until the recording stops so a running
// recording does not move between slots when another one starts or ends.
const slotAssignments = new Map();

function isVideoFile(name) {
    return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function listRecordings() {
    try {
        return fs.readdirSync(RECORDINGS_DIR)
            .filter(isVideoFile)
            .map((name) => {
                const fullPath = path.join(RECORDINGS_DIR, name);

                try {
                    const stat = fs.statSync(fullPath);

                    if (!stat.isFile() || stat.size === 0) {
                        return null;
                    }

                    return {
                        name,
                        size: stat.size,
                        mtimeMs: stat.mtimeMs,
                        birthMs: stat.birthtimeMs || stat.mtimeMs,
                        title: path.basename(name, path.extname(name))
                    };
                } catch (err) {
                    return null;
                }
            })
            .filter(Boolean);
    } catch (err) {
        console.error('Unable to read recordings directory:', err.message);
        return [];
    }
}

function scan() {
    const now = Date.now();
    const files = listRecordings();
    const seen = new Set();

    for (const file of files) {
        seen.add(file.name);
        const previous = state.get(file.name);
        const grew = previous && file.size > previous.size;
        const recentlyTouched = now - file.mtimeMs < ACTIVE_WINDOW_MS;

        state.set(file.name, {
            name: file.name,
            title: file.title,
            size: file.size,
            mtimeMs: file.mtimeMs,
            birthMs: file.birthMs,
            lastGrowth: grew ? now : (previous ? previous.lastGrowth : now),
            active: !!grew || recentlyTouched
        });
    }

    for (const name of state.keys()) {
        if (!seen.has(name)) {
            state.delete(name);
        }
    }
}

function activeRecordings() {
    return Array.from(state.values())
        .filter((recording) => recording.active)
        .sort((a, b) => a.title.localeCompare(b.title));
}

function activeRecordingsByStart() {
    return activeRecordings().sort((a, b) => {
        const byStart = (a.birthMs || a.mtimeMs) - (b.birthMs || b.mtimeMs);
        return byStart !== 0 ? byStart : a.title.localeCompare(b.title);
    });
}

function slotRecordings() {
    const active = activeRecordingsByStart();
    const activeNames = new Set(active.map((recording) => recording.name));

    for (const name of Array.from(slotAssignments.keys())) {
        if (!activeNames.has(name)) {
            slotAssignments.delete(name);
        }
    }

    const used = new Set(slotAssignments.values());

    for (const recording of active) {
        if (slotAssignments.has(recording.name)) {
            continue;
        }

        for (let slot = 1; slot <= SLOT_COUNT; slot++) {
            if (!used.has(slot)) {
                slotAssignments.set(recording.name, slot);
                used.add(slot);
                break;
            }
        }
    }

    const slots = [];

    for (let slot = 1; slot <= SLOT_COUNT; slot++) {
        const assigned = Array.from(slotAssignments.entries())
            .find(([, number]) => number === slot);
        slots.push({
            slot,
            recording: assigned ? state.get(assigned[0]) || null : null
        });
    }

    return slots;
}

function stableChannelNumber(name) {
    let hash = 0;

    for (let i = 0; i < name.length; i++) {
        hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    }

    return 9000 + (Math.abs(hash) % 900);
}

function requestBaseUrl(req) {
    if (PUBLIC_URL) {
        return PUBLIC_URL;
    }

    return 'http://' + (req.headers.host || ('127.0.0.1:' + PORT));
}

function sendPlaylist(res, lines) {
    res.writeHead(200, {
        'Content-Type': 'audio/x-mpegurl; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(lines.join('\n') + '\n');
}

function playlist(req, res) {
    // Slot mode keeps the channel list stable, so a new recording does not
    // need a Jellyfin guide refresh.
    if (!req.url.includes('dynamic=1') && !req.url.includes('all=1')) {
        const baseUrl = requestBaseUrl(req);
        const lines = ['#EXTM3U'];

        for (let slot = 1; slot <= SLOT_COUNT; slot++) {
            const channel = SLOT_FIRST_CHANNEL + slot - 1;
            const name = 'TVH 녹화 ' + slot;

            lines.push('#EXTINF:-1 tvg-id="tvh-rec-slot-' + slot + '" tvg-chno="' + channel
                + '" tvg-name="' + name + '",' + name);
            lines.push(baseUrl + '/live/slot/' + slot);
        }

        sendPlaylist(res, lines);
        return;
    }

    const includeAll = req.url.includes('all=1');
    const recordings = includeAll
        ? Array.from(state.values()).sort((a, b) => a.title.localeCompare(b.title))
        : activeRecordings();
    const baseUrl = requestBaseUrl(req);
    const lines = ['#EXTM3U'];

    for (const recording of recordings) {
        const channel = stableChannelNumber(recording.name);
        const id = 'tvh-rec-' + channel;
        const url = baseUrl + '/live/' + encodeURIComponent(recording.name);

        lines.push('#EXTINF:-1 tvg-id="' + id + '" tvg-chno="' + channel
            + '" tvg-name="TVH: ' + recording.title.replace(/"/g, '') + '",TVH: ' + recording.title);
        lines.push(url);
    }

    sendPlaylist(res, lines);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeWithBackpressure(res, buffer) {
    return new Promise((resolve) => {
        if (res.write(buffer)) {
            resolve();
        } else {
            res.once('drain', resolve);
        }
    });
}

async function streamRecording(req, res, name) {
    if (!name || path.basename(name) !== name || !isVideoFile(name)) {
        res.writeHead(400).end('Bad recording name');
        return;
    }

    const fullPath = path.join(RECORDINGS_DIR, name);
    let fd;

    try {
        fd = fs.openSync(fullPath, 'r');
    } catch (err) {
        res.writeHead(404).end('Recording not found');
        return;
    }

    let aborted = false;
    const remote = req.socket.remoteAddress;
    const started = Date.now();
    let sent = 0;
    let reason = 'ended';
    res.on('close', () => { aborted = true; });

    res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Transfer-Encoding': 'chunked'
    });

    console.log('stream start ' + name + ' from ' + remote);

    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    let lastSize = 0;
    let lastGrowth = Date.now();
    const known = state.get(name);

    try {
        while (!aborted && !res.destroyed) {
            const stat = fs.fstatSync(fd);
            const size = stat.size;

            if (size > lastSize) {
                lastSize = size;
                lastGrowth = Date.now();
            }

            if (position < size) {
                const length = Math.min(buffer.length, size - position);
                const bytesRead = fs.readSync(fd, buffer, 0, length, position);

                if (bytesRead > 0) {
                    position += bytesRead;
                    sent += bytesRead;
                    await writeWithBackpressure(res, buffer.subarray(0, bytesRead));
                    continue;
                }
            }

            // A completed file should finish immediately. An active one stays
            // open while TVHeadend appends more data.
            const isActive = known ? known.active : (Date.now() - stat.mtimeMs < ACTIVE_WINDOW_MS);

            if (!isActive) {
                reason = 'inactive';
                break;
            }

            if (Date.now() - lastGrowth > IDLE_GRACE_MS) {
                reason = 'idle';
                break;
            }

            await sleep(300);
        }
    } catch (err) {
        console.error('Streaming failed:', err.message);
    } finally {
        try { fs.closeSync(fd); } catch (err) { /* ignore */ }

        if (!res.writableEnded) {
            res.end();
        }

        console.log('stream ' + (aborted ? 'client-closed' : reason) + ' ' + name
            + ' from ' + remote + ' bytes=' + sent
            + ' seconds=' + ((Date.now() - started) / 1000).toFixed(1));
    }
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        res.end();
        return;
    }

    if (req.method !== 'GET') {
        res.writeHead(405).end();
        return;
    }

    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            recordings: state.size,
            active: activeRecordings().length,
            slots: slotRecordings().map((entry) => ({
                slot: entry.slot,
                channel: SLOT_FIRST_CHANNEL + entry.slot - 1,
                name: entry.recording ? entry.recording.title : null
            }))
        }));
        return;
    }

    if (url.pathname === '/playlist.m3u') {
        playlist(req, res);
        return;
    }

    if (url.pathname.startsWith('/live/slot/')) {
        const slot = parseInt(url.pathname.substring('/live/slot/'.length), 10);
        const entry = slotRecordings().find((candidate) => candidate.slot === slot);

        if (!entry || !entry.recording) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
                .end('No active recording in slot ' + slot);
            return;
        }

        streamRecording(req, res, entry.recording.name);
        return;
    }

    if (url.pathname.startsWith('/live/')) {
        const name = decodeURIComponent(url.pathname.substring('/live/'.length));
        streamRecording(req, res, name);
        return;
    }

    res.writeHead(404).end('Not found');
});

scan();
setInterval(scan, SCAN_MS).unref();
server.listen(PORT, '0.0.0.0', () => {
    console.log('TVH proxy listening on port ' + PORT + ', recordings: ' + RECORDINGS_DIR);
});
