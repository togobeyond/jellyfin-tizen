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
// "1" -> channels 1.1, 1.2, ... (sorted before the 2.1 channel).
const SLOT_CHANNEL_BASE = process.env.SLOT_CHANNEL_BASE || '1';
// Jellyfin's M3U tuner copies the proxy stream as fast as the disk allows
// (often 30-40 MB/s), which starves the TV's direct stream on a busy HDD.
// Throttle that consumer to a little above realtime.
const THROTTLE_ADDRESSES = new Set((process.env.THROTTLE_ADDRESSES || '192.168.1.4')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean));
const THROTTLE_BYTES_PER_SEC = parseInt(process.env.THROTTLE_BYTES_PER_SEC || '4000000', 10);
const SCAN_MS = 2000;
const VIDEO_EXTENSIONS = new Set(['.ts', '.m2ts', '.mts', '.trp']);

// Optional: refresh the Jellyfin guide when the recording set changes, so the
// channel names follow the program being recorded.
const JELLYFIN_URL = (process.env.JELLYFIN_URL || '').replace(/\/$/, '');
const JELLYFIN_TOKEN = process.env.JELLYFIN_TOKEN || '';
const REFRESH_DEBOUNCE_MS = 5000;
const REFRESH_MIN_INTERVAL_MS = 30000;

const state = new Map();
// Recording name -> slot number. Kept until the recording stops so a running
// recording does not move between slots when another one starts or ends.
const slotAssignments = new Map();

let refreshTimer = null;
let lastRefreshAt = 0;
let lastSignature = null;
let guideTaskId = null;

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
            indexes.delete(name);
        }
    }

    for (const recording of state.values()) {
        if (!recording.active) {
            continue;
        }

        const index = indexFor(recording.name);

        if (!index.scanning && index.scannedBytes < recording.size - INDEX_READ_BYTES) {
            buildIndex(path.join(RECORDINGS_DIR, recording.name), index);
        }
    }

    scheduleJellyfinRefresh();
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

function slotChannelNumber(slot) {
    return SLOT_CHANNEL_BASE + '.' + slot;
}

function recordingLabel(title) {
    // TVHeadend names recordings "<channel>.<program>..<date>.ts".
    return String(title || '')
        .replace(/\.\.\d{4}-\d{2}-\d{2}.*$/, '')
        .replace(/"/g, '')
        .trim()
        .slice(0, 60);
}

function slotChannelName(slot, recording) {
    if (!recording) {
        return 'TVH 녹화 ' + slot;
    }

    return 'TVH 녹화 ' + slot + ' · ' + recordingLabel(recording.title);
}

// --- MPEG-TS time index ---------------------------------------------------
// TVHeadend writes MPEG-TS with PCR timestamps. Sampling the PCR lets us map
// a playback time to a byte offset in the growing file, so a client can seek
// to the recording start, the live edge, or any position in between.

const SEEK_PREROLL_MS = 3000;
const INDEX_SAMPLE_BYTES = 4 * 1024 * 1024;
const INDEX_READ_BYTES = 128 * 1024;

const indexes = new Map();

function indexFor(name) {
    let index = indexes.get(name);

    if (!index) {
        index = {
            entries: [],
            pcrPid: null,
            firstMs: null,
            lastMs: null,
            lastRawMs: null,
            accumulatedMs: 0,
            lastDeltaMs: null,
            scannedBytes: 0,
            size: 0,
            scanning: false,
            complete: false,
            promise: null
        };
        indexes.set(name, index);
    }

    return index;
}

function findPacketStart(buffer) {
    const limit = Math.min(188, buffer.length);

    for (let i = 0; i < limit; i++) {
        if (buffer[i] !== 0x47) {
            continue;
        }

        if (buffer.length <= i + 188 || buffer[i + 188] === 0x47) {
            return i;
        }
    }

    return -1;
}

function scanPcrs(buffer, handler) {
    const start = findPacketStart(buffer);

    if (start < 0) {
        return;
    }

    for (let i = start; i + 12 <= buffer.length; i += 188) {
        if (buffer[i] !== 0x47) {
            continue;
        }

        const afc = (buffer[i + 3] >> 4) & 3;

        if (!(afc & 2)) {
            continue;
        }

        const length = buffer[i + 4];

        if (length < 7 || !(buffer[i + 5] & 0x10)) {
            continue;
        }

        const base = (buffer[i + 6] * 0x2000000)
            + (buffer[i + 7] << 17)
            + (buffer[i + 8] << 9)
            + (buffer[i + 9] << 1)
            + (buffer[i + 10] >> 7);

        const pid = ((buffer[i + 1] & 0x1f) << 8) | buffer[i + 2];

        handler(base / 90, i, pid);
    }
}

function firstPcr(buffer, pid) {
    let found = null;
    scanPcrs(buffer, (milliseconds, offset, packetPid) => {
        if (pid != null && packetPid !== pid) {
            return;
        }

        if (!found) {
            found = { milliseconds, offset };
        }
    });
    return found;
}

function lastPcr(buffer, pid) {
    let found = null;
    scanPcrs(buffer, (milliseconds, offset, packetPid) => {
        if (pid != null && packetPid !== pid) {
            return;
        }

        found = { milliseconds, offset };
    });
    return found;
}

function choosePcrPid(buffer) {
    const counts = new Map();

    scanPcrs(buffer, (milliseconds, offset, pid) => {
        counts.set(pid, (counts.get(pid) || 0) + 1);
    });

    let best = null;
    let max = 0;

    counts.forEach((count, pid) => {
        if (count > max) {
            max = count;
            best = pid;
        }
    });

    return best;
}

async function readWindow(handle, offset, length) {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, result.bytesRead);
}

async function primeIndex(fullPath, index) {
    const handle = await fs.promises.open(fullPath, 'r');

    try {
        const stat = await handle.stat();

        if (index.firstMs == null) {
            const head = await readWindow(handle, 0, Math.min(1024 * 1024, stat.size));

            if (index.pcrPid == null) {
                index.pcrPid = choosePcrPid(head);
            }

            const pcr = firstPcr(head, index.pcrPid);

            if (pcr) {
                index.firstMs = pcr.milliseconds;
                index.lastRawMs = pcr.milliseconds;
                index.accumulatedMs = 0;
                index.entries.push({ ms: 0, offset: pcr.offset });
            }
        }

    } finally {
        await handle.close();
    }
}

async function buildIndex(fullPath, index) {
    if (index.scanning) {
        return index.promise;
    }

    index.scanning = true;
    index.promise = (async () => {
        const handle = await fs.promises.open(fullPath, 'r');

        try {
            const stat = await handle.stat();
            index.size = stat.size;

            if (index.firstMs == null) {
                const head = await readWindow(handle, 0, Math.min(1024 * 1024, stat.size));

                if (index.pcrPid == null) {
                    index.pcrPid = choosePcrPid(head);
                }

                const pcr = firstPcr(head, index.pcrPid);

                if (pcr) {
                    index.firstMs = pcr.milliseconds;
                    index.lastRawMs = pcr.milliseconds;
                    index.accumulatedMs = 0;
                    index.entries.push({ ms: 0, offset: pcr.offset });
                }
            }

            let offset = index.scannedBytes;

            while (offset < stat.size - INDEX_READ_BYTES) {
                const buffer = await readWindow(handle, offset, INDEX_READ_BYTES);
                const pcr = firstPcr(buffer, index.pcrPid);

                if (pcr && index.firstMs != null) {
                    let delta = pcr.milliseconds - index.lastRawMs;

                    if (delta < 0 || delta > 600000) {
                        // The PCR resets or jumps when TVHeadend concatenates
                        // a new recording segment. Continue from the previous
                        // sampling step instead of stalling the duration.
                        delta = index.lastDeltaMs || 3700;
                    }

                    index.lastRawMs = pcr.milliseconds;

                    if (delta > 0) {
                        index.lastDeltaMs = delta;
                        index.accumulatedMs += delta;
                    }

                    const milliseconds = index.accumulatedMs;
                    const last = index.entries[index.entries.length - 1];

                    if (!last || milliseconds > last.ms + 250) {
                        index.entries.push({ ms: milliseconds, offset: offset + pcr.offset });
                        index.lastMs = milliseconds;
                    }
                }

                offset += INDEX_SAMPLE_BYTES;
                index.scannedBytes = offset;
                await new Promise((resolve) => setImmediate(resolve));
            }

            index.complete = index.scannedBytes >= stat.size - INDEX_READ_BYTES;
        } finally {
            await handle.close();
        }
    })().catch((err) => {
        console.error('index build failed for ' + fullPath + ':', err.message);
    }).finally(() => {
        index.scanning = false;
    });

    return index.promise;
}

function offsetForMs(index, targetMs) {
    // The recording start is best played from byte 0 so AVPlay gets the
    // PAT/PMT and the first keyframe. The first PCR is usually a bit later.
    if (!index.entries.length || targetMs <= 0) {
        return 0;
    }

    let low = 0;
    let high = index.entries.length - 1;
    let best = 0;

    while (low <= high) {
        const middle = (low + high) >> 1;

        if (index.entries[middle].ms <= targetMs) {
            best = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }

    return index.entries[best].offset;
}

function timeForMs(index, targetMs) {
    if (!index.entries.length) {
        return 0;
    }

    const offset = offsetForMs(index, targetMs);
    const entry = index.entries.find((candidate) => candidate.offset === offset);
    return entry ? entry.ms : 0;
}

async function seekInfo(name, targetParam) {
    const recording = state.get(name);

    if (!recording) {
        return null;
    }

    const fullPath = path.join(RECORDINGS_DIR, name);
    const index = indexFor(name);

    await primeIndex(fullPath, index);

    const durationMs = Math.max(0, index.lastMs || 0);

    if (targetParam === undefined) {
        buildIndex(fullPath, index);
        return {
            name,
            durationMs,
            startMs: 0,
            offset: 0,
            active: recording.active,
            entries: index.entries.length
        };
    }

    let targetMs;

    if (targetParam === 'live' || targetParam == null) {
        // Start well before the live edge. AVPlay closes the HTTP connection
        // when it catches up with a stream that is still being written; a
        // 30 s margin keeps it following steadily.
        targetMs = Math.max(0, durationMs - 30000);
    } else {
        targetMs = Math.max(0, parseFloat(targetParam) || 0);

        if (targetMs > durationMs - 1500) {
            targetMs = Math.max(0, durationMs - SEEK_PREROLL_MS);
        }
    }

    const build = buildIndex(fullPath, index);

    if (!index.complete) {
        await Promise.race([build, new Promise((resolve) => setTimeout(resolve, 10000))]);
    }

    const startMs = timeForMs(index, targetMs);

    return {
        name,
        durationMs,
        startMs,
        offset: offsetForMs(index, startMs),
        active: recording.active,
        entries: index.entries.length
    };
}

async function offsetForStream(name, params) {
    const recording = state.get(name);

    if (!recording || (!params.has('from') && !params.has('start'))) {
        return 0;
    }

    const fullPath = path.join(RECORDINGS_DIR, name);
    const index = indexFor(name);
    let targetMs = 0;

    if (params.has('from')) {
        targetMs = Math.max(0, (parseFloat(params.get('from')) || 0) * 1000);
    } else {
        const start = params.get('start');

        if (start === 'live') {
            await primeIndex(fullPath, index);
            targetMs = Math.max(0, (index.lastMs || 0) - 30000);
        } else {
            targetMs = Math.max(0, ((parseFloat(start) || 0) * 1000) - SEEK_PREROLL_MS);
        }
    }

    await primeIndex(fullPath, index);

    if (index.entries.length < 2 && targetMs > 5000) {
        await Promise.race([
            buildIndex(fullPath, index),
            new Promise((resolve) => setTimeout(resolve, 10000))
        ]);
    }

    return offsetForMs(index, targetMs);
}

function playlistSignature() {
    return slotRecordings()
        .map((entry) => entry.slot + '=' + (entry.recording ? entry.recording.title : ''))
        .join('|');
}

function scheduleJellyfinRefresh() {
    if (!JELLYFIN_URL || !JELLYFIN_TOKEN) {
        return;
    }

    const signature = playlistSignature();

    if (signature === lastSignature) {
        return;
    }

    lastSignature = signature;

    if (refreshTimer) {
        clearTimeout(refreshTimer);
    }

    refreshTimer = setTimeout(triggerJellyfinRefresh, REFRESH_DEBOUNCE_MS);
}

async function triggerJellyfinRefresh() {
    refreshTimer = null;

    const wait = REFRESH_MIN_INTERVAL_MS - (Date.now() - lastRefreshAt);

    if (wait > 0) {
        refreshTimer = setTimeout(triggerJellyfinRefresh, wait);
        return;
    }

    const headers = { Authorization: 'MediaBrowser Token=' + JELLYFIN_TOKEN };

    try {
        if (!guideTaskId) {
            const response = await fetch(JELLYFIN_URL + '/ScheduledTasks', { headers });

            if (!response.ok) {
                throw new Error('ScheduledTasks returned ' + response.status);
            }

            const tasks = await response.json();
            const task = tasks.find((candidate) => candidate.Key === 'RefreshGuide');
            guideTaskId = task ? task.Id : null;
        }

        if (!guideTaskId) {
            console.error('Jellyfin RefreshGuide task not found');
            return;
        }

        const response = await fetch(JELLYFIN_URL + '/ScheduledTasks/Running/' + guideTaskId, {
            method: 'POST',
            headers
        });

        lastRefreshAt = Date.now();

        if (response.ok) {
            console.log('Triggered Jellyfin guide refresh for new slot names');
        } else {
            console.error('Jellyfin guide refresh returned ' + response.status);
        }
    } catch (err) {
        console.error('Jellyfin guide refresh failed:', err.message);
    }
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

        for (const entry of slotRecordings()) {
            const channel = slotChannelNumber(entry.slot);
            const name = slotChannelName(entry.slot, entry.recording);

            lines.push('#EXTINF:-1 tvg-id="tvh-rec-slot-' + entry.slot + '" tvg-chno="' + channel
                + '" tvg-name="' + name + '",' + name);
            lines.push(baseUrl + '/live/slot/' + entry.slot);
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
            return;
        }

        let done = false;
        const finish = () => {
            if (done) {
                return;
            }

            done = true;
            res.removeListener('drain', finish);
            res.removeListener('close', finish);
            resolve();
        };

        res.once('drain', finish);
        res.once('close', finish);
    });
}

async function streamRecording(req, res, name, startOffset) {
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
    const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const throttleBps = THROTTLE_ADDRESSES.has(remote) ? THROTTLE_BYTES_PER_SEC : 0;
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

    console.log('stream start ' + name + ' from ' + remote
        + (startOffset ? ' offset=' + startOffset : ''));

    const buffer = Buffer.alloc(64 * 1024);
    let position = Math.max(0, startOffset || 0);
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

                    if (throttleBps > 0) {
                        const targetMs = (sent / throttleBps) * 1000;
                        const elapsedMs = Date.now() - started;

                        if (targetMs > elapsedMs) {
                            await sleep(Math.min(1000, targetMs - elapsedMs));
                        }
                    }

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

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        res.end();
        return;
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        res.end();
        return;
    }

    if (req.method === 'POST' && url.pathname === '/debug') {
        let body = '';

        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 16384) {
                req.destroy();
            }
        });
        req.on('end', () => {
            console.log('client-debug ' + body.replace(/\s+/g, ' ').slice(0, 4000));
            res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
            res.end();
        });
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
                channel: slotChannelNumber(entry.slot),
                name: entry.recording ? entry.recording.title : null
            }))
        }));
        return;
    }

    if (url.pathname === '/playlist.m3u') {
        playlist(req, res);
        return;
    }

    if (url.pathname.startsWith('/info/')) {
        const target = url.pathname.substring('/info/'.length);
        let name = null;

        if (target.startsWith('slot/')) {
            const slot = parseInt(target.substring('slot/'.length), 10);
            const entry = slotRecordings().find((candidate) => candidate.slot === slot);
            name = entry && entry.recording ? entry.recording.name : null;
        } else {
            name = decodeURIComponent(target);
        }

        if (!name) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
                .end('No active recording');
            return;
        }

        let info = null;

        try {
            info = await seekInfo(name, url.searchParams.has('t')
                ? url.searchParams.get('t')
                : undefined);
        } catch (err) {
            console.error('info failed:', err.message);
        }

        if (!info) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
                .end('Recording not found');
            return;
        }

        if (url.searchParams.get('dump') === '1') {
            const index = indexFor(name);
            info.firstMs = index.firstMs;
            info.lastMs = index.lastMs;
            info.pcrPid = index.pcrPid;
            info.scannedBytes = index.scannedBytes;
            info.size = index.size;
            info.scanning = index.scanning;
            info.complete = index.complete;
            info.first = index.entries.slice(0, 5);
            info.last = index.entries.slice(-5);
        }

        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(info));
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

        let offset = 0;

        try {
            offset = await offsetForStream(entry.recording.name, url.searchParams);
        } catch (err) {
            console.error('seek failed:', err.message);
        }

        streamRecording(req, res, entry.recording.name, offset);
        return;
    }

    if (url.pathname.startsWith('/live/')) {
        const name = decodeURIComponent(url.pathname.substring('/live/'.length));
        let offset = 0;

        try {
            offset = await offsetForStream(name, url.searchParams);
        } catch (err) {
            console.error('seek failed:', err.message);
        }

        streamRecording(req, res, name, offset);
        return;
    }

    res.writeHead(404).end('Not found');
});

scan();
setInterval(scan, SCAN_MS).unref();
server.listen(PORT, '0.0.0.0', () => {
    console.log('TVH proxy listening on port ' + PORT + ', recordings: ' + RECORDINGS_DIR);
});
