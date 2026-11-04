/**
 * Scheduler tick orchestration (Scope update 2): the supervisor scans
 * the registry for files with DUE timed triggers; closed files are
 * self-opened on an engine (CAS claim → engine /session/claim with a
 * creator token → the engine-side runtime fires → observed through
 * the shared store's persisted lastFiredAt → session released). Live
 * files are skipped (their attached runtime self-ticks). Duplicate
 * ticks never double-fire. Failures land on the trigger's lastRun.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TriggerSupervisor } from './triggerSupervisor.js';
import { filePersistence } from '../filePersistence.js';
const ALICE = 'alice@example.com';
const FILE_ID = 'file-tick-1';
const A1 = 'trig';
const A2 = 'test';
const ESEC = `${A1}-${A2}-engine`;
class MemoryRegistry {
    records = new Map();
    async lookup(fileId) {
        return this.records.get(fileId) ?? null;
    }
    async listAll() {
        return [...this.records.values()];
    }
    async claim(record, expectedEpoch) {
        const cur = this.records.get(record.fileId);
        if ((cur?.ownershipEpoch ?? null) !== expectedEpoch)
            return false;
        this.records.set(record.fileId, record);
        return true;
    }
    async heartbeat() {
        return true;
    }
    async release(fileId, sessionId, epoch) {
        const cur = this.records.get(fileId);
        if (!cur || cur.sessionId !== sessionId || cur.ownershipEpoch !== epoch)
            return false;
        this.records.set(fileId, { ...cur, leaseExpiry: 0 });
        return true;
    }
    async noteParticipant() {
        return true;
    }
}
function deadRecord(over = {}) {
    return {
        fileId: FILE_ID,
        sessionId: 'sess-tick-1',
        ownerInstance: 'engine-1',
        ownerEndpoint: 'http://engine.test',
        leaseExpiry: Date.now() - 60_000, // dead lease: the file is closed
        ownershipEpoch: 3,
        currentRevision: 5,
        storedRevision: 5,
        updatedAt: Date.now() - 60_000,
        creatorPrincipal: ALICE,
        participants: {},
        ...over,
    };
}
const supervisors = [];
afterEach(() => {
    for (const s of supervisors.splice(0))
        s.stop();
});
function makeHarness(opts) {
    const dir = mkdtempSync(join(tmpdir(), 'trig-tick-'));
    const env = {
        ...process.env,
        ICECREAM_DATA_DIR: dir,
        ENGINE_ACCESS_SECRET: ESEC,
    };
    const registry = new MemoryRegistry();
    const record = opts.record ?? deadRecord();
    registry.records.set(record.fileId, record);
    const engineCalls = [];
    const storeFile = filePersistence(dir);
    const tickFetch = (async (url, init) => {
        const path = new URL(url).pathname;
        const body = JSON.parse(String(init?.body ?? '{}'));
        const auth = init?.headers?.authorization;
        engineCalls.push({ path, body, auth });
        const json = (status, v) => new Response(JSON.stringify(v), {
            status,
            headers: { 'content-type': 'application/json' },
        });
        if (path === '/session/status') {
            if (!opts.sessionStatus)
                return json(404, { ok: false });
            return json(200, {
                ok: true,
                sessionId: record.sessionId,
                fileId: record.fileId,
                status: opts.sessionStatus,
                instanceId: 'engine-1',
            });
        }
        if (path === '/session/claim') {
            if (opts.claimBehavior === 'refuse')
                return json(500, { ok: false, error: 'boom' });
            if (opts.claimBehavior === 'pending')
                return json(200, { ok: true, pending: true });
            // Simulate the engine-side runtime firing the due triggers:
            // persist lastFiredAt on every enabled timed spec in the
            // shared store. Specs live in the { version, triggers }
            // envelope under the host-scoped store key
            // `<fileId>::<store key>` — the exact on-disk layout
            // SessionTriggerHost's scoped persistence uses.
            const key = `${record.fileId}::icecream-sheets.triggers.v1`;
            const raw = storeFile.load(key);
            if (raw) {
                const doc = JSON.parse(raw);
                const nowIso = new Date().toISOString();
                for (const spec of doc.triggers) {
                    if (spec.event === 'onAtTime' || spec.event === 'onInterval') {
                        spec.lastFiredAt = nowIso;
                    }
                }
                storeFile.save(key, JSON.stringify(doc));
            }
            return json(200, { ok: true, sessionId: body.sessionId });
        }
        if (path === '/session/release')
            return json(200, { ok: true });
        return json(404, { ok: false });
    });
    const sup = new TriggerSupervisor({
        records: () => registry.listAll(),
        claimRegistry: registry,
        engineBaseUrl: 'http://engine.test',
        env,
        // The supervisor and the fake "engine-side runtime" share one
        // file-backed store directory — exactly the production topology
        // (two processes, one store).
        persistenceProvider: {
            forScope: async () => ({ persistence: storeFile, flush: async () => undefined }),
        },
        tickFetch,
        selfOpenTimeoutMs: 4_000,
        selfOpenPollMs: 25,
        log: () => undefined,
    });
    supervisors.push(sup);
    return { sup, registry, engineCalls, env };
}
async function seedDueAtTime(sup) {
    const at = await sup.createForFile(FILE_ID, {
        name: 'closed-file one-shot',
        event: 'onAtTime',
        atTimeIso: new Date(Date.now() - 5_000).toISOString(),
        script: 'api.setCell("Sheet1", 0, 6, { kind: "number", value: 888 });',
        permissions: [{ action: 'cell.write', target: 'Sheet1!0,6' }],
        enabled: true,
    });
    await sup.grantForFile(FILE_ID, at.id, ALICE);
    return at.id;
}
describe('TriggerSupervisor.tick', () => {
    it('self-opens a closed file, fires the due one-shot, releases — and a duplicate tick does not double-fire', async () => {
        const h = makeHarness({ claimBehavior: 'fire' });
        const id = await seedDueAtTime(h.sup);
        const first = await h.sup.tick();
        expect(first.scanned).toBe(1);
        expect(first.fired).toEqual([FILE_ID]);
        expect(first.failures).toEqual([]);
        const claims = h.engineCalls.filter((c) => c.path === '/session/claim');
        expect(claims).toHaveLength(1);
        // The engine call carries a Bearer engine-access token minted for
        // the file's creator session.
        expect(claims[0].auth).toMatch(/^Bearer /);
        expect(claims[0].body).toMatchObject({ fileId: FILE_ID, sessionId: 'sess-tick-1' });
        expect(h.engineCalls.some((c) => c.path === '/session/release')).toBe(true);
        // The CAS claim was released afterwards (lease cleared).
        expect(h.registry.records.get(FILE_ID)?.leaseExpiry).toBe(0);
        // FENCING REGRESSION: the CAS must name THE ENGINE as owner (its
        // instance id + endpoint from the file's record) — naming the
        // tick itself makes the engine fence the session it just opened.
        expect(h.registry.records.get(FILE_ID)?.ownerInstance).toBe('engine-1');
        expect(h.registry.records.get(FILE_ID)?.ownerEndpoint).toBe('http://engine.test');
        // The store now carries the persisted fire marker.
        const after = await h.sup.listForFile(FILE_ID);
        expect(after.find((t) => t.id === id)?.lastFiredAt).toBeDefined();
        // Duplicate tick (at-least-once delivery): nothing is due any
        // more, so no second self-open and no second fire.
        const second = await h.sup.tick();
        expect(second.fired).toEqual([]);
        expect(second.failures).toEqual([]);
        expect(h.engineCalls.filter((c) => c.path === '/session/claim')).toHaveLength(1);
    });
    it('fires a due interval trigger on a closed file too', async () => {
        const h = makeHarness({ claimBehavior: 'fire' });
        const t = await h.sup.createForFile(FILE_ID, {
            name: 'closed interval',
            event: 'onInterval',
            intervalMs: 60_000,
            script: 'api.setCell("Sheet1", 0, 5, { kind: "number", value: 555 });',
            permissions: [{ action: 'cell.write', target: 'Sheet1!0,5' }],
            enabled: true,
        });
        await h.sup.grantForFile(FILE_ID, t.id, ALICE);
        const summary = await h.sup.tick();
        expect(summary.fired).toEqual([FILE_ID]);
    });
    it('skips files with a live session (their attached runtime self-ticks)', async () => {
        const h = makeHarness({
            claimBehavior: 'fire',
            record: deadRecord({ leaseExpiry: Date.now() + 60_000 }),
        });
        await seedDueAtTime(h.sup);
        const summary = await h.sup.tick();
        expect(summary.skippedLive).toEqual([FILE_ID]);
        expect(summary.fired).toEqual([]);
        // No self-open was attempted (the only engine call is the status probe).
        expect(h.engineCalls.filter((c) => c.path === '/session/claim')).toHaveLength(0);
    });
    it('a live LEASE with a probe-proven RELEASED session still self-opens (release leaves the lease standing)', async () => {
        const h = makeHarness({
            claimBehavior: 'fire',
            sessionStatus: 'released',
            record: deadRecord({ leaseExpiry: Date.now() + 60_000 }),
        });
        await seedDueAtTime(h.sup);
        const summary = await h.sup.tick();
        expect(summary.fired).toEqual([FILE_ID]);
        expect(summary.skippedLive).toEqual([]);
    });
    it('a record naming a non-engine owner still CASes as the engine (instance id resolved from /session/status, never trusted from the record)', async () => {
        const h = makeHarness({
            claimBehavior: 'fire',
            sessionStatus: 'released',
            record: deadRecord({ ownerInstance: 'trigger-tick' }),
        });
        await seedDueAtTime(h.sup);
        const summary = await h.sup.tick();
        expect(summary.fired).toEqual([FILE_ID]);
        expect(h.registry.records.get(FILE_ID)?.ownerInstance).toBe('engine-1');
    });
    it('a probe-proven ACTIVE session under a live lease is skipped', async () => {
        const h = makeHarness({
            claimBehavior: 'fire',
            sessionStatus: 'active',
            record: deadRecord({ leaseExpiry: Date.now() + 60_000 }),
        });
        await seedDueAtTime(h.sup);
        const summary = await h.sup.tick();
        expect(summary.skippedLive).toEqual([FILE_ID]);
        expect(h.engineCalls.filter((c) => c.path === '/session/claim')).toHaveLength(0);
    });
    it('records an engine refusal on the trigger lastRun and in the summary', async () => {
        const h = makeHarness({ claimBehavior: 'refuse' });
        const id = await seedDueAtTime(h.sup);
        const summary = await h.sup.tick();
        expect(summary.fired).toEqual([]);
        expect(summary.failures).toHaveLength(1);
        expect(summary.failures[0].error).toContain('refused by the engine');
        const list = await h.sup.listForFile(FILE_ID);
        const status = list.find((t) => t.id === id);
        expect(status?.lastRun?.ok).toBe(false);
        expect(status?.lastRun?.error).toContain('refused by the engine');
    });
    it('records the no-checkpoint case (pending claim) instead of firing blind', async () => {
        const h = makeHarness({ claimBehavior: 'pending' });
        const id = await seedDueAtTime(h.sup);
        const summary = await h.sup.tick();
        expect(summary.fired).toEqual([]);
        expect(summary.failures[0].error).toContain('no checkpointed session state');
        const list = await h.sup.listForFile(FILE_ID);
        expect(list.find((t) => t.id === id)?.lastRun?.ok).toBe(false);
        // The pending session was released again.
        expect(h.engineCalls.filter((c) => c.path === '/session/release').length).toBeGreaterThan(0);
    });
    it('a file with nothing due is scanned and left alone', async () => {
        const h = makeHarness({ claimBehavior: 'fire' });
        const t = await h.sup.createForFile(FILE_ID, {
            name: 'future one-shot',
            event: 'onAtTime',
            atTimeIso: new Date(Date.now() + 3_600_000).toISOString(),
            script: 'api.notify("later");',
            permissions: [{ action: 'ui.notify', target: 'toast' }],
            enabled: true,
        });
        await h.sup.grantForFile(FILE_ID, t.id, ALICE);
        const summary = await h.sup.tick();
        expect(summary.scanned).toBe(1);
        expect(summary.fired).toEqual([]);
        expect(h.engineCalls).toHaveLength(0);
    });
});
