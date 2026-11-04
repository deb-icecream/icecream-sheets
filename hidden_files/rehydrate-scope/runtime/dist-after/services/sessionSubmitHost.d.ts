/**
 * SessionSubmitHost — the EngineHost the trigger runtime attaches to
 * when it is hosted against a live engine session (triggers program;
 * see hidden_files/triggers/REPORT.md "PIVOT — hosting point
 * corrected").
 *
 * Why this exists: the TriggerRuntime + AutomationApi are
 * SYNCHRONOUS. The session's real EngineHost is synchronous for reads
 * and events, but a trigger WRITE must not call host.execute()
 * directly — session writes have to go through the engine service's
 * sequenced composition (FIFO sequencer + journal + revision, the
 * /ops path) or co-authoring clients and the journal would diverge.
 * That composition is async (enqueueSequenced + runExecuteInternal).
 *
 * So this wrapper:
 *  - delegates every READ (readCell / readRange / getView / snapshot /
 *    sheetNames / usedRange / getAuthorizer) to the real host —
 *    synchronous and always current, exactly like the desktop's
 *    in-process hosting;
 *  - forwards engine EVENTS to the runtime's listeners, EXCEPT while
 *    an automation submit is being applied: the runtime's re-entrancy
 *    guard suppresses self-caused events during a run in the local
 *    topology, and submits here apply just after the run's sync part
 *    ends — without this filter a self-writing trigger would loop;
 *  - execute() enqueues the command through the session's submitOp
 *    (stamped with the command's own automation principal) and
 *    returns an optimistic { ok: true } — the AutomationApi contract
 *    is synchronous. Scripts therefore run to completion (multi-write
 *    scripts included). If a submit is later REJECTED by the engine,
 *    onLateFailure corrects the trigger's last-run record (the
 *    SessionTriggerHost's noteLateRunFailure) — failures are never
 *    silently swallowed;
 *  - drain() lets the supervisor wait for all queued submits (used
 *    before detach, so a session close never strands a write).
 *
 * Read-your-own-writes within a single run is the one documented
 * semantic difference from a purely local host: a script reads the
 * workbook as of the run's start (plus other clients' committed
 * edits); its own writes commit in order through the sequencer
 * immediately after each call.
 */
import { EngineHost, type Authorizer, type CellRef, type CommandResult, type EngineCommand, type EngineEventListener, type RangeRef, type TypedValue, type TypedView, type WorkbookSnapshot } from '@icecream-sheets/engine';
import type { EngineSessionHandle } from './engineSvc.js';
export interface SessionSubmitHostOptions {
    /** Called when a queued submit is rejected by the engine. */
    onLateFailure?: (specName: string, error: string) => void;
}
export declare class SessionSubmitHost extends EngineHost {
    private readonly inner;
    private readonly submitOp;
    private readonly onLateFailure;
    private readonly outerListeners;
    private readonly innerUnsubscribe;
    private readonly pending;
    /** >0 while an automation submit is queued/applying (event filter). */
    private applying;
    constructor(handle: EngineSessionHandle, opts?: SessionSubmitHostOptions);
    execute(command: EngineCommand): CommandResult;
    /** Wait until every queued submit has settled (pre-detach). */
    drain(): Promise<void>;
    subscribe(listener: EngineEventListener): () => void;
    readCell(ref: CellRef): TypedValue;
    readRange(range: RangeRef): TypedValue[][];
    getView(): TypedView;
    snapshot(): WorkbookSnapshot;
    sheetNames(): string[];
    getAuthorizer(): Authorizer;
    dispose(): void;
}
