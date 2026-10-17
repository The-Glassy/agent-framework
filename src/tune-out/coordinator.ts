/**
 * TuneOutCoordinator (issue #77) — the host-side machinery between a
 * tuned-out channel and the subconscious resident.
 *
 * Responsibilities: classify diverted traffic (stamp everything, wake on
 * addressed), acknowledge suppressed mentions deterministically, run the
 * per-channel summary cadence, count wakes durably with max-wakes
 * auto-cancel, and deliver the cancel dump.
 *
 * Voice doctrine ("no words in models' mouths"): everything the resident
 * reads from the subconscious is the subconscious's verbatim text under its
 * own participant name. Host-authored framing is system-styled and never
 * voiced: `<tuned-out-backlog …>` wraps raw diverted messages (the
 * <backscroll> precedent), and `[Tune-out: …]` bracket notices carry
 * lifecycle facts (the [Gate: …] precedent).
 */

import { randomUUID } from 'node:crypto';
import { authorLine } from '../author-presentation.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { StoredMessage } from '@animalabs/context-manager';
import type { ChannelRegistry, TuneOutParams } from '../mcpl/channel-registry.js';
import type { McplServerRegistry } from '../mcpl/server-registry.js';
import { CapabilityGrant } from '../mcpl/capability-grant.js';
import { armAfter, armAt } from '../deadline-timer.js';

/** The options a tune-out call can give. */
type TuneOutOption = 'durationSeconds' | 'cadenceSeconds' | 'backlogCap' | 'maxWakes';

/** Defaults for tune_out tool params. */
export const TUNE_OUT_DEFAULTS = {
  cadenceSeconds: 1800,
  backlogCap: 200,
  maxWakes: 5,
} as const;

/** Coalescing window for wake invocations: a mention storm becomes one
 *  subconscious turn, and max-wakes counts invocations, not messages. */
const WAKE_COALESCE_MS = 2_000;

/**
 * One backlog line: author, then the message's blocks in order — text as
 * is, anything else named by kind (`[image]`, `[document]`), so a release
 * never drops a block silently (#232 gap 4). The author is named once: a
 * server that renders `Name: body` into the text itself is not doubled.
 */
export function renderHeldLine(m: Pick<StoredMessage, 'participant' | 'content' | 'metadata'>): string {
  const author = (m.metadata as { author?: { name?: string } } | undefined)?.author?.name ?? m.participant;
  const parts = m.content.map((b: ContentBlock) =>
    b.type === 'text' ? (b as Extract<ContentBlock, { type: 'text' }>).text : `[${b.type}]`,
  );
  return authorLine(author, parts.filter((p) => p.length > 0).join(' '));
}

/** One reader invocation under `reader: 'forks'` (see SubconsciousConfig). */
export interface ReaderInvocation {
  serverId: string;
  channelId: string;
  epochId: string;
  trigger: 'cadence' | 'wake' | 'cancel';
  /** The host-framed notice for this invocation (bracket style). */
  notice: string;
  /** Held messages not yet handed to any reader fork, oldest first. */
  backlog: StoredMessage[];
  /** Standing dispositions, as text, or null when there are none. */
  dispositions: string | null;
}

/**
 * The all-except scope (issue #232 §3.2; focus folded into tune-out): a
 * resident-level policy epoch holding every channel but one, for a bounded
 * time. It covers DMs and channels registered after entry, since the
 * decision is "not the exception" rather than a per-channel state.
 */
export interface AllExceptParams {
  epochId: string;
  except: { serverId: string; channelId: string };
  cadenceSeconds: number;
  /** Per held channel, at release. */
  backlogCap: number;
  /** Reader wakes before the reader is paused (the hold itself stays). */
  maxWakes: number;
  startedAtSequence: number;
  startedAtMs: number;
  /** Mandatory: the scope always ends on its own. */
  expiresAtMs: number;
  source: string;
}

export interface AllExceptState {
  params: AllExceptParams;
  wakeCount: number;
}

/** `check`: what is held right now, without releasing anything. */
export interface TuneOutCheck {
  allExcept: { epochId: string; except: { serverId: string; channelId: string }; expiresAtMs: number; wakeCount: number; held: Record<string, number> } | null;
  channels: Array<{ serverId: string; channelId: string; epochId: string; held: number; expiresAtMs?: number }>;
  /** Up to `peekLimit` newest held lines of the peeked channel, oldest first. */
  peek?: string[];
}

export interface TuneOutFrameworkHooks {
  /** Deliver a message into an agent's window (per-agent seam). */
  addMessage: (
    participant: string,
    content: ContentBlock[],
    metadata?: Record<string, unknown>,
    forAgent?: string,
  ) => string;
  /** Queue an inference request for an agent. */
  requestInference: (agentName: string, reason: string, source: string) => void;
  /** The persistent subconscious's registry/participant name, or null. */
  subconsciousName: () => string | null;
  /**
   * `reader: 'forks'`: derive and run one reader fork. Absent in persistent
   * mode. The framework owns the fork's lifecycle; the coordinator owns the
   * epoch.
   */
  invokeReader?: (invocation: ReaderInvocation) => void;
  /**
   * `reader: 'forks'`: deliver a reader fork's own words to the resident
   * as attributed mail (its name, its incarnation). Absent in persistent
   * mode, where the subconscious writes under its own name directly.
   */
  deliverFromReader?: (reader: string, content: ContentBlock[], metadata: Record<string, unknown>) => void;
  /** The primary resident's registry name. */
  primaryName: () => string | null;
  /** Read the primary's stored messages (shared slot, unfiltered). */
  getStoredMessages: () => StoredMessage[];
  /**
   * Messages admitted for the primary but not yet in its store (deferred
   * while a turn was alive). A release reads them too, so a message held
   * mid-turn is in the backlog it belongs to (#232 gap 7).
   */
  getDeferredMessages?: () => Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'>>;
  /**
   * Make what was just delivered durable, including anything the delivery
   * left in the deferred queue: a release flips durable epoch state, so its
   * dump must survive a crash in the same window (#232 gap 6).
   */
  commitDeliveries?: () => void;
  /**
   * The history-reading tool the resident actually has (e.g. a server's
   * `fetch_history`), or null. A truncation note names it only when it exists
   * (#232 gap 11).
   */
  historyTool?: () => string | null;
  /** Current chronicle head sequence (window anchor for new epochs). */
  currentSequence: () => number;
  /** Move the subconscious window anchor (never forward past active epochs). */
  setSubconsciousAnchor: (sequence: number) => void;
  /** True when a channel is bound to a conversation-fork agent. */
  isForkBound: (channelId: string) => boolean;
  /** Gate privileged-users list (#77: privileged authors wake, like mentions). */
  isPrivilegedAuthor: (authorId: string | null | undefined) => boolean;
  /** speak_in_channel master switch (recipe-side, canary-gated). */
  allowChannelSpeech: () => boolean;
  /**
   * Post a line into a channel under the resident's name. Used for the
   * all-except scope's entry and release announcements in the excepted
   * channel (Linn, 2026-10-12: the room should hear the door shut, not
   * discover it). Absent when `tuneOut.announce` is off.
   */
  announce?: (serverId: string, channelId: string, text: string) => Promise<{ success: boolean; error?: string }>;
  emitTrace: (event: { type: string; [key: string]: unknown }) => void;
}

export class TuneOutCoordinator {
  private cadenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Each duration's pending expiry step (params.expiresAtMs). stop clears
   *  it, cancel does while the registry still holds the tune-out, and the
   *  channel's next enter does in any case. */
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Channels with a wake invocation pending inside the coalescing window. */
  private pendingWakes = new Map<string, { count: number; timer: ReturnType<typeof setTimeout> }>();
  /** Diverted-message tallies since the last subconscious invocation, per channel key. */
  private divertedSinceInvocation = new Map<string, number>();
  /**
   * `reader: 'forks'`: the highest sequence of a held message already
   * handed to a reader fork, per channel key. Each held message is
   * delivered to exactly one fork. In-memory: after a restart the first
   * fork of an epoch is handed everything the epoch has held, which is
   * the right side to err on.
   */
  private readerCursor = new Map<string, number>();
  /** The all-except scope's durable record, cached (undefined = not read yet). */
  private scopeCache: AllExceptState | null | undefined;
  /** Timer key for the scope's cadence and expiry. */
  private static readonly SCOPE_KEY = '\0all-except';

  constructor(
    private readonly channelRegistry: ChannelRegistry,
    private readonly serverRegistry: McplServerRegistry,
    private readonly hooks: TuneOutFrameworkHooks,
  ) {}

  private key(serverId: string, channelId: string): string {
    return `${serverId}\0${channelId}`;
  }

  /** A reader exists: the persistent subconscious, or forks on demand. */
  private readerAvailable(): boolean {
    return this.hooks.subconsciousName() !== null || typeof this.hooks.invokeReader === 'function';
  }

  /** Reader forks are the configured reader. */
  private get forkReader(): boolean {
    return this.hooks.subconsciousName() === null && typeof this.hooks.invokeReader === 'function';
  }

  /** Restart cadence + expiry timers and re-anchor after a process restart. */
  resumeActiveEpochs(): void {
    let oldestAnchor: number | null = null;
    for (const { serverId, channelId, params } of this.listActive()) {
      // An epoch whose deadline passed while the process was down cancels
      // immediately — the resident gets their backlog on the schedule they
      // committed to, not whenever the host happened to restart.
      if (params.expiresAtMs !== undefined && params.expiresAtMs <= Date.now()) {
        this.cancel(serverId, channelId, 'duration', 'duration elapsed');
        continue;
      }
      this.startCadence(serverId, channelId, params.cadenceSeconds);
      this.armExpiry(serverId, channelId, params);
      if (oldestAnchor === null || params.startedAtSequence < oldestAnchor) {
        oldestAnchor = params.startedAtSequence;
      }
    }
    const scope = this.getAllExcept();
    if (scope) {
      if (scope.params.expiresAtMs <= Date.now()) {
        this.cancelAllExcept('duration', 'duration elapsed');
      } else {
        this.armScopeTimers(scope.params);
        if (oldestAnchor === null || scope.params.startedAtSequence < oldestAnchor) {
          oldestAnchor = scope.params.startedAtSequence;
        }
      }
    }
    if (oldestAnchor !== null) {
      this.hooks.setSubconsciousAnchor(oldestAnchor);
    }
  }

  private armExpiry(serverId: string, channelId: string, params: TuneOutParams): void {
    if (params.expiresAtMs === undefined) return;
    const key = this.key(serverId, channelId);
    const existing = this.expiryTimers.get(key);
    if (existing) clearTimeout(existing);
    armAt(params.expiresAtMs, (timer) => { this.expiryTimers.set(key, timer); }, () => {
      this.expiryTimers.delete(key);
      this.cancel(serverId, channelId, 'duration', 'duration elapsed');
    });
  }

  private listActive(): Array<{ serverId: string; channelId: string; params: TuneOutParams }> {
    const active: Array<{ serverId: string; channelId: string; params: TuneOutParams }> = [];
    for (const entry of this.channelRegistry.listChannelsRaw()) {
      const state = this.channelRegistry.getTuneOutState(entry.serverId, entry.descriptor.id);
      if (state) {
        active.push({ serverId: entry.serverId, channelId: entry.descriptor.id, params: state.params });
      }
    }
    return active;
  }

  // ==========================================================================
  // Enter / cancel
  // ==========================================================================

  /**
   * The options a tune-out call gives, read as numbers before anything
   * changes (F76). A tool's input reaches here as the model wrote it, and
   * the store can't keep a NaN or an Infinity: its append would throw after
   * the registry had marked the channel tuned out. So each option is read
   * as a number first, a numeric string included, as the sleep tool reads
   * its seconds; null counts as left out. A value that gives no finite
   * number is refused, naming the option and, where it can be left out,
   * what leaving it out means; so is a duration whose end time is too far
   * off to store. `now` is the clock the end time was counted from. One
   * rule for a channel's tune-out and the all-except hold.
   */
  private readOptions(
    opts: { cadenceSeconds?: unknown; backlogCap?: unknown; maxWakes?: unknown; durationSeconds?: unknown },
    leftOut: Record<TuneOutOption, string | null>,
  ): { ok: true; given: Partial<Record<TuneOutOption, number>>; now: number; expiresAtMs: number | undefined } | { ok: false; error: string } {
    const given: Partial<Record<TuneOutOption, number>> = {};
    for (const name of Object.keys(leftOut) as TuneOutOption[]) {
      const value: unknown = opts[name];
      if (value == null) continue;
      const n = Number(value);
      if (!Number.isFinite(n)) {
        const got = typeof value === 'number'
          ? String(value)
          : `${typeof value === 'string' ? 'the string' : 'the value'} ${JSON.stringify(value)}`;
        return {
          ok: false,
          error: `Nothing was tuned out: ${name} must be a finite number${name.endsWith('Seconds') ? ' of seconds' : ''}, `
            + `and it was ${got}.${leftOut[name] ? ` Leave it out ${leftOut[name]}.` : ''}`,
        };
      }
      given[name] = n;
    }
    const now = Date.now();
    const expiresAtMs = given.durationSeconds === undefined
      ? undefined
      : now + Math.max(60, given.durationSeconds) * 1000;
    if (expiresAtMs !== undefined && !Number.isFinite(expiresAtMs)) {
      return {
        ok: false,
        error: `Nothing was tuned out: durationSeconds ${given.durationSeconds} is longer than an end time can be kept.`
          + (leftOut.durationSeconds ? ` Leave it out ${leftOut.durationSeconds}.` : ''),
      };
    }
    return { ok: true, given, now, expiresAtMs };
  }

  enter(
    serverId: string,
    channelId: string,
    opts: { cadenceSeconds?: number; backlogCap?: number; maxWakes?: number; durationSeconds?: number },
    source: string,
  ): { ok: true; params: TuneOutParams } | { ok: false; error: string } {
    // No reader (issue #232 §3.3): a silent hold. Nothing summarizes, nothing
    // wakes, mentions are still acknowledged, the backlog is released on
    // cancel. The resident is told so in the tool result.
    if (this.hooks.isForkBound(channelId)) {
      return { ok: false, error: `channel ${channelId} is bound to a conversation fork; tune-out and fork routing are mutually exclusive` };
    }
    if (this.channelRegistry.getTuneOutState(serverId, channelId)) {
      return { ok: false, error: `channel ${channelId} is already tuned out (cancel first to change params)` };
    }
    const scope = this.getAllExcept();
    if (scope && scope.params.except.serverId === serverId && scope.params.except.channelId === channelId) {
      return { ok: false, error: `channel ${channelId} is the excepted channel of the active all-except hold; cancel that first` };
    }
    const read = this.readOptions(opts, {
      durationSeconds: 'to stay tuned out until you cancel',
      cadenceSeconds: `for the default, ${TUNE_OUT_DEFAULTS.cadenceSeconds}`,
      backlogCap: `for the default, ${TUNE_OUT_DEFAULTS.backlogCap}`,
      maxWakes: `for the default, ${TUNE_OUT_DEFAULTS.maxWakes}`,
    });
    if (!read.ok) return read;
    const { given, expiresAtMs } = read;
    const params: TuneOutParams = {
      epochId: randomUUID(),
      cadenceSeconds: Math.max(30, given.cadenceSeconds ?? TUNE_OUT_DEFAULTS.cadenceSeconds),
      backlogCap: Math.max(0, given.backlogCap ?? TUNE_OUT_DEFAULTS.backlogCap),
      maxWakes: Math.max(1, given.maxWakes ?? TUNE_OUT_DEFAULTS.maxWakes),
      startedAtSequence: this.hooks.currentSequence(),
      ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    };
    // A tune-out can end in the registry without cancel (a send into the
    // channel or a close sets its state there), leaving its timers armed:
    // clear them, so none of them acts on this one.
    this.clearTimers(serverId, channelId);
    this.channelRegistry.enterTuneOut(serverId, channelId, params, source);
    this.armExpiry(serverId, channelId, params);

    // Window anchor: start of the OLDEST active tune-out. Never move the
    // anchor forward here — an older active epoch owns it.
    const oldest = this.listActive().reduce(
      (min, e) => Math.min(min, e.params.startedAtSequence),
      params.startedAtSequence,
    );
    this.hooks.setSubconsciousAnchor(oldest);

    this.divertedSinceInvocation.set(this.key(serverId, channelId), 0);
    if (this.readerAvailable()) this.startCadence(serverId, channelId, params.cadenceSeconds);
    this.hooks.emitTrace({
      type: 'tune-out:entered', serverId, channelId, epochId: params.epochId, reader: this.readerAvailable(),
    });
    return { ok: true, params };
  }

  /** Whether a reader (persistent subconscious or reader forks) attends holds. */
  hasReader(): boolean {
    return this.readerAvailable();
  }

  /**
   * End a tune-out: durable flip, system-framed backlog dump into the
   * resident's window (capped), lifecycle notice, one wake for the
   * resident. `subconsciousNote` is the subconscious's own text (from its
   * cancel_tuneout call) — delivered verbatim under its name, never
   * synthesized here.
   */
  cancel(
    serverId: string,
    channelId: string,
    source: string,
    reason: string,
    subconsciousNote?: string,
    /** `reader: 'forks'`: the reader fork whose note this is. */
    noteAuthor?: string,
    /** The lifecycle state the channel returns to (a tool close ends in 'closed'). */
    nextState: 'open' | 'closed' = 'open',
  ): { ok: true } | { ok: false; error: string } {
    const ended = this.channelRegistry.cancelTuneOut(serverId, channelId, nextState, source);
    if (!ended) {
      return { ok: false, error: `channel ${channelId} is not tuned out` };
    }
    this.clearTimers(serverId, channelId);
    this.divertedSinceInvocation.delete(this.key(serverId, channelId));

    // Backlog: every message held under this epoch, oldest first — stored,
    // and still in the deferred queue (held mid-turn, not yet written).
    const epochId = ended.params.epochId;
    const ofEpoch = (m: Pick<StoredMessage, 'metadata'>): boolean =>
      (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === epochId;
    const backlog: Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'>> = [
      ...this.hooks.getStoredMessages().filter(ofEpoch),
      ...(this.hooks.getDeferredMessages?.() ?? []).filter(ofEpoch),
    ];
    const cap = ended.params.backlogCap;
    const shown = cap > 0 ? backlog.slice(-cap) : [];
    const truncated = backlog.length - shown.length;

    const lines = shown.map(renderHeldLine);
    const historyTool = this.hooks.historyTool?.() ?? null;
    const attrs = [
      `channel="${channelId}"`,
      `messages=${backlog.length}`,
      ...(truncated > 0
        ? [`truncated=${truncated} (oldest; ${historyTool ? `${historyTool} covers the rest` : 'not delivered'})`]
        : []),
    ];
    const dump =
      `<tuned-out-backlog ${attrs.join(' ')}>\n${lines.join('\n')}\n</tuned-out-backlog>`;

    // Host-framed system artifacts — never voiced as anyone.
    this.hooks.addMessage(
      'user',
      [{ type: 'text', text: `[Tune-out: ${channelId} cancelled — ${reason}, ${ended.wakeCount} wake${ended.wakeCount === 1 ? '' : 's'}]\n\n${dump}` }],
      { system: true, kind: 'tune-out-cancel', channelId, epochId },
    );
    // The epoch is already ended durably; the release must be as durable.
    this.hooks.commitDeliveries?.();
    // The subconscious's own words, under its own name, verbatim.
    const subName = this.hooks.subconsciousName();
    if (subconsciousNote && subName) {
      this.hooks.addMessage(
        subName,
        [{ type: 'text', text: subconsciousNote }],
        { kind: 'subconscious-note', channelId, epochId },
      );
    } else if (subconsciousNote && noteAuthor && this.hooks.deliverFromReader) {
      // A reader fork's note: attributed mail, under the fork's name and
      // incarnation, never the resident's voice.
      this.hooks.deliverFromReader(
        noteAuthor,
        [{ type: 'text', text: subconsciousNote }],
        { kind: 'subconscious-note', channelId, epochId },
      );
    }
    const primary = this.hooks.primaryName();
    if (primary) {
      this.hooks.requestInference(primary, `tune-out cancelled (${reason})`, 'tune-out');
    }
    // The subconscious gets one cancel turn of its own (unless it initiated
    // the cancel — its note already carries its words): the issue's cancel
    // shape is dump + a report from the subconscious, and when the cap
    // truncated the raw dump, its summary is what covers the tail.
    if (source !== 'subconscious') {
      const truncNote = truncated > 0
        ? ` ${truncated} of ${backlog.length} diverted messages were above the cap and not delivered raw.`
        : '';
      const notice = `[Tune-out cancelled: ${channelId} — ${reason}.${truncNote}]`;
      if (subName) {
        this.hooks.addMessage(
          'user',
          [{ type: 'text', text: notice }],
          { system: true, kind: 'tune-out-cancel-report', channelId },
          subName,
        );
        this.hooks.requestInference(subName, `tune-out cancelled: ${channelId}`, 'tune-out');
      } else if (this.forkReader) {
        // One last fork for the epoch: whatever was held since the last
        // look, plus the cancel notice; its report follows the dump.
        // The fork is handed stored messages only: a deferred one has no
        // sequence yet and will reach the store (view-filtered) on its own.
        this.invokeReaderFork(serverId, channelId, epochId, 'cancel', notice, this.hooks.getStoredMessages().filter(ofEpoch));
      }
    }
    this.readerCursor.delete(this.key(serverId, channelId));
    this.hooks.emitTrace({ type: 'tune-out:cancelled', serverId, channelId, epochId, reason, wakeCount: ended.wakeCount });
    return { ok: true };
  }

  // ==========================================================================
  // Ingestion: divert, stamp, classify
  // ==========================================================================

  /**
   * Consulted by the framework for every incoming channel message BEFORE
   * storage. Null = channel not tuned out (proceed normally). Otherwise the
   * caller stamps `metadata.tuneOut = { epochId }`, stores the message
   * without waking the residents, and this coordinator has already handled
   * wake bookkeeping (coalesced subconscious invocation, durable count,
   * suppression ack, possible auto-cancel).
   */
  onIncoming(
    serverId: string,
    channelId: string,
    messageId: string,
    tags: string[] | undefined,
    authorId?: string,
    gatePass = true,
  ): { epochId: string } | null {
    const hold = this.holdFor(serverId, channelId);
    if (!hold) return null;
    this.recordHeld(serverId, channelId, messageId, tags, authorId, gatePass);
    return hold;
  }

  /** The epoch holding this channel, or null. Pure: the admission stage's lookup. */
  holdFor(serverId: string, channelId: string): { epochId: string } | null {
    // Precedence: a per-channel epoch keeps its own hold (cadence, budget,
    // stamp); the all-except scope holds whatever else is not the exception.
    const state = this.channelRegistry.getTuneOutState(serverId, channelId);
    if (state) return { epochId: state.params.epochId };
    const scope = this.getAllExcept();
    if (scope && !(scope.params.except.serverId === serverId && scope.params.except.channelId === channelId)) {
      return { epochId: scope.params.epochId };
    }
    return null;
  }

  /** The channel unprefixed speech lands in while an all-except hold is active, else null. */
  focusChannel(): string | null {
    return this.getAllExcept()?.params.except.channelId ?? null;
  }

  // ==========================================================================
  // All-except scope
  // ==========================================================================

  private get scopeStateId(): string {
    return `tune-out/${this.hooks.primaryName() ?? 'default'}/all-except`;
  }

  getAllExcept(): AllExceptState | null {
    if (this.scopeCache !== undefined) return this.scopeCache;
    try {
      const raw = this.channelRegistry.readCoordinatorState(this.scopeStateId) as AllExceptState | null;
      this.scopeCache = raw && typeof raw === 'object' && raw.params && typeof raw.params.epochId === 'string' ? raw : null;
    } catch {
      this.scopeCache = null;
    }
    return this.scopeCache;
  }

  private writeScope(state: AllExceptState | null): void {
    this.scopeCache = state;
    this.channelRegistry.writeCoordinatorState(this.scopeStateId, state);
  }

  enterAllExcept(
    except: { serverId: string; channelId: string },
    opts: { cadenceSeconds?: number; backlogCap?: number; maxWakes?: number; durationSeconds?: number },
    source: string,
  ): { ok: true; params: AllExceptParams } | { ok: false; error: string } {
    const read = this.readOptions(opts, {
      durationSeconds: null,
      cadenceSeconds: `for the default, ${TUNE_OUT_DEFAULTS.cadenceSeconds}`,
      backlogCap: `for the default, ${TUNE_OUT_DEFAULTS.backlogCap}`,
      maxWakes: `for the default, ${TUNE_OUT_DEFAULTS.maxWakes}`,
    });
    if (!read.ok) return read;
    const { given, expiresAtMs } = read;
    if (expiresAtMs === undefined) {
      return { ok: false, error: 'an all-except hold needs `durationSeconds`: it always ends on its own' };
    }
    if (this.getAllExcept()) {
      return { ok: false, error: 'an all-except hold is already active (cancel it first)' };
    }
    if (this.channelRegistry.getTuneOutState(except.serverId, except.channelId)) {
      return { ok: false, error: `channel ${except.channelId} is tuned out; it cannot be the exception` };
    }
    if (this.hooks.isForkBound(except.channelId)) {
      return { ok: false, error: `channel ${except.channelId} is bound to a conversation fork` };
    }
    const params: AllExceptParams = {
      epochId: randomUUID(),
      except,
      cadenceSeconds: Math.max(30, given.cadenceSeconds ?? TUNE_OUT_DEFAULTS.cadenceSeconds),
      backlogCap: Math.max(0, given.backlogCap ?? TUNE_OUT_DEFAULTS.backlogCap),
      maxWakes: Math.max(1, given.maxWakes ?? TUNE_OUT_DEFAULTS.maxWakes),
      startedAtSequence: this.hooks.currentSequence(),
      startedAtMs: read.now,
      expiresAtMs,
      source,
    };
    this.writeScope({ params, wakeCount: 0 });
    const oldest = this.listActive().reduce((min, e) => Math.min(min, e.params.startedAtSequence), params.startedAtSequence);
    this.hooks.setSubconsciousAnchor(oldest);
    this.armScopeTimers(params);
    this.hooks.emitTrace({
      type: 'tune-out:entered', serverId: except.serverId, channelId: except.channelId, epochId: params.epochId,
      scope: 'all-except', reader: this.readerAvailable(), expiresAtMs: params.expiresAtMs,
    });
    const minutes = Math.max(1, Math.round((params.expiresAtMs - params.startedAtMs) / 60_000));
    const until = new Date(params.expiresAtMs).toISOString().slice(11, 16);
    this.announce(except, params.epochId, 'entered',
      `[Focus: ${this.hooks.primaryName() ?? 'the resident'} is here for ${minutes} min, until ${until} UTC; other channels are held meanwhile.]`);
    return { ok: true, params };
  }

  /** Whether entry and release of the all-except scope are announced in the excepted channel. */
  announces(): boolean {
    return typeof this.hooks.announce === 'function';
  }

  /**
   * The excepted channel hears the scope open and close: one bracketed line
   * under the resident's name, posted through the same path as a publish.
   * Fire-and-forget; the outcome is traced, never awaited by the epoch flip.
   */
  private announce(
    target: { serverId: string; channelId: string },
    epochId: string,
    kind: 'entered' | 'released',
    text: string,
  ): void {
    if (!this.hooks.announce) return;
    const base = { serverId: target.serverId, channelId: target.channelId, epochId, kind };
    this.hooks.announce(target.serverId, target.channelId, text).then(
      (r) => this.hooks.emitTrace(r.success
        ? { type: 'tune-out:announced', ...base }
        : { type: 'tune-out:announce-failed', ...base, error: r.error ?? 'publish failed' }),
      (err: unknown) => this.hooks.emitTrace({ type: 'tune-out:announce-failed', ...base, error: (err as Error).message }),
    );
  }

  /** The scope's end time and cadence, on timers no longer than one holds
   *  (deadline-timer), as a channel's tune-out arms its own. */
  private armScopeTimers(params: AllExceptParams): void {
    const key = TuneOutCoordinator.SCOPE_KEY;
    const expiry = this.expiryTimers.get(key);
    if (expiry) clearTimeout(expiry);
    armAt(params.expiresAtMs, (timer) => { this.expiryTimers.set(key, timer); }, () => {
      this.expiryTimers.delete(key);
      this.cancelAllExcept('duration', 'duration elapsed');
    });
    if (!this.readerAvailable()) return;
    const cadence = this.cadenceTimers.get(key);
    if (cadence) clearTimeout(cadence);
    const hold = (timer: ReturnType<typeof setTimeout>): void => { this.cadenceTimers.set(key, timer); };
    const tick = () => {
      const scope = this.getAllExcept();
      if (!scope) return;
      // One look per held channel with new traffic since the last look.
      for (const [channelKey, diverted] of this.divertedSinceInvocation) {
        if (diverted <= 0) continue;
        const [serverId, channelId] = channelKey.split('\0') as [string, string];
        if (this.channelRegistry.getTuneOutState(serverId, channelId)) continue; // a per-channel epoch's own cadence
        this.invokeSubconscious(serverId, channelId, 'cadence', diverted);
      }
      armAfter(params.cadenceSeconds * 1000, hold, tick);
    };
    armAfter(params.cadenceSeconds * 1000, hold, tick);
  }

  private clearScopeTimers(): void {
    const key = TuneOutCoordinator.SCOPE_KEY;
    const cadence = this.cadenceTimers.get(key);
    if (cadence) clearTimeout(cadence);
    this.cadenceTimers.delete(key);
    const expiry = this.expiryTimers.get(key);
    if (expiry) clearTimeout(expiry);
    this.expiryTimers.delete(key);
  }

  /** Channels held by the scope (not by their own epoch) with the count held under it. */
  private scopeHeldCounts(epochId: string): Map<string, { serverId: string; channelId: string; count: number }> {
    const counts = new Map<string, { serverId: string; channelId: string; count: number }>();
    const all = [...this.hooks.getStoredMessages(), ...(this.hooks.getDeferredMessages?.() ?? [])];
    for (const m of all) {
      const meta = m.metadata as { tuneOut?: { epochId?: string }; channelId?: string; serverId?: string } | undefined;
      if (meta?.tuneOut?.epochId !== epochId) continue;
      const channelId = typeof meta.channelId === 'string' ? meta.channelId : '(unknown channel)';
      const serverId = typeof meta.serverId === 'string' ? meta.serverId : '';
      const k = this.key(serverId, channelId);
      const entry = counts.get(k) ?? { serverId, channelId, count: 0 };
      entry.count += 1;
      counts.set(k, entry);
    }
    return counts;
  }

  /**
   * End the all-except hold: durable flip, one release notice with a
   * per-channel backlog (each capped), the reader's note if any, one wake
   * for the resident, and the reader's own look at what it had not seen.
   */
  cancelAllExcept(
    source: string,
    reason: string,
    note?: string,
    noteAuthor?: string,
  ): { ok: true } | { ok: false; error: string } {
    const scope = this.getAllExcept();
    if (!scope) return { ok: false, error: 'no all-except hold is active' };
    this.writeScope(null);
    this.clearScopeTimers();
    const { epochId, except, backlogCap } = scope.params;
    for (const [key, pending] of this.pendingWakes) {
      const [serverId, channelId] = key.split('\0') as [string, string];
      if (this.channelRegistry.getTuneOutState(serverId, channelId)) continue;
      clearTimeout(pending.timer);
      this.pendingWakes.delete(key);
    }

    const ofEpoch = (m: Pick<StoredMessage, 'metadata'>): boolean =>
      (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === epochId;
    const all = [...this.hooks.getStoredMessages().filter(ofEpoch), ...(this.hooks.getDeferredMessages?.() ?? []).filter(ofEpoch)];
    const byChannel = new Map<string, Array<Pick<StoredMessage, 'participant' | 'content' | 'metadata'>>>();
    for (const m of all) {
      const channelId = (m.metadata as { channelId?: string } | undefined)?.channelId ?? '(unknown channel)';
      byChannel.set(channelId, [...(byChannel.get(channelId) ?? []), m]);
    }
    const historyTool = this.hooks.historyTool?.() ?? null;
    const dumps = [...byChannel.entries()].map(([channelId, backlog]) => {
      const shown = backlogCap > 0 ? backlog.slice(-backlogCap) : [];
      const truncated = backlog.length - shown.length;
      const attrs = [
        `channel="${channelId}"`,
        `messages=${backlog.length}`,
        ...(truncated > 0 ? [`truncated=${truncated} (oldest; ${historyTool ? `${historyTool} covers the rest` : 'not delivered'})`] : []),
      ];
      return `<tuned-out-backlog ${attrs.join(' ')}>\n${shown.map(renderHeldLine).join('\n')}\n</tuned-out-backlog>`;
    });
    const summary = byChannel.size === 0
      ? 'Nothing was held.'
      : `${all.length} message${all.length === 1 ? '' : 's'} held in ${byChannel.size} channel${byChannel.size === 1 ? '' : 's'}.`;
    this.hooks.addMessage(
      'user',
      [{ type: 'text', text: `[Tune-out: all channels except ${except.channelId} released — ${reason}, ${scope.wakeCount} wake${scope.wakeCount === 1 ? '' : 's'}]\n\n${summary}${dumps.length > 0 ? '\n\n' + dumps.join('\n\n') : ''}` }],
      { system: true, kind: 'tune-out-cancel', scope: 'all-except', channelId: except.channelId, epochId },
    );
    this.hooks.commitDeliveries?.();
    const subName = this.hooks.subconsciousName();
    if (note && subName) {
      this.hooks.addMessage(subName, [{ type: 'text', text: note }], { kind: 'subconscious-note', epochId });
    } else if (note && noteAuthor && this.hooks.deliverFromReader) {
      this.hooks.deliverFromReader(noteAuthor, [{ type: 'text', text: note }], { kind: 'subconscious-note', epochId });
    }
    const primary = this.hooks.primaryName();
    if (primary) this.hooks.requestInference(primary, `tune-out cancelled (${reason})`, 'tune-out');
    if (source !== 'subconscious' && this.readerAvailable()) {
      const notice = `[Tune-out cancelled: all channels except ${except.channelId} — ${reason}.]`;
      if (subName) {
        this.hooks.addMessage('user', [{ type: 'text', text: notice }], { system: true, kind: 'tune-out-cancel-report', scope: 'all-except' }, subName);
        this.hooks.requestInference(subName, 'tune-out cancelled: all-except', 'tune-out');
      } else if (this.forkReader) {
        // One last look per channel the forks had not fully seen.
        for (const [channelId, backlog] of byChannel) {
          const serverId = (backlog[0]?.metadata as { serverId?: string } | undefined)?.serverId ?? '';
          const stored = this.hooks.getStoredMessages().filter((m) => ofEpoch(m) && (m.metadata as { channelId?: string } | undefined)?.channelId === channelId);
          const cursor = this.readerCursor.get(this.key(serverId, channelId)) ?? -1;
          if (stored.some((m) => m.sequence > cursor)) {
            this.invokeReaderFork(serverId, channelId, epochId, 'cancel', notice, stored);
          }
        }
      }
    }
    for (const key of [...this.divertedSinceInvocation.keys()]) {
      const [serverId, channelId] = key.split('\0') as [string, string];
      if (!this.channelRegistry.getTuneOutState(serverId, channelId)) {
        this.divertedSinceInvocation.delete(key);
        this.readerCursor.delete(key);
      }
    }
    this.hooks.emitTrace({ type: 'tune-out:cancelled', serverId: except.serverId, channelId: except.channelId, epochId, scope: 'all-except', reason, wakeCount: scope.wakeCount });
    this.announce(except, epochId, 'released', `[Focus: ${primary ?? 'the resident'} released — ${reason}.]`);
    return { ok: true };
  }

  /** What is held right now — per-channel epochs and the scope — without releasing. */
  check(opts: { peek?: { serverId?: string; channelId: string }; peekLimit?: number } = {}): TuneOutCheck {
    const stored = this.hooks.getStoredMessages();
    const deferred = this.hooks.getDeferredMessages?.() ?? [];
    const countOf = (epochId: string) => [...stored, ...deferred].filter(
      (m) => (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId === epochId,
    ).length;
    const channels = this.listActive().map(({ serverId, channelId, params }) => ({
      serverId, channelId, epochId: params.epochId, held: countOf(params.epochId),
      ...(params.expiresAtMs !== undefined ? { expiresAtMs: params.expiresAtMs } : {}),
    }));
    const scope = this.getAllExcept();
    let allExcept: TuneOutCheck['allExcept'] = null;
    if (scope) {
      const held: Record<string, number> = {};
      for (const { channelId, count } of this.scopeHeldCounts(scope.params.epochId).values()) held[channelId] = count;
      allExcept = { epochId: scope.params.epochId, except: scope.params.except, expiresAtMs: scope.params.expiresAtMs, wakeCount: scope.wakeCount, held };
    }
    const result: TuneOutCheck = { allExcept, channels };
    if (opts.peek) {
      const limit = Math.max(1, Math.min(50, opts.peekLimit ?? 5));
      // Only what is held NOW: the channel's own epoch, or the scope's. A
      // released epoch's messages are delivered, not held; showing them here
      // would be a false declaration (first live run, 2026-10-12, finding B).
      const active = new Set<string>();
      for (const e of channels) {
        if (e.channelId === opts.peek.channelId && (!opts.peek.serverId || e.serverId === opts.peek.serverId)) active.add(e.epochId);
      }
      if (scope) active.add(scope.params.epochId);
      const lines = [...stored, ...deferred]
        .filter((m) => {
          const meta = m.metadata as { tuneOut?: { epochId?: string }; channelId?: string; serverId?: string } | undefined;
          return typeof meta?.tuneOut?.epochId === 'string' && active.has(meta.tuneOut.epochId)
            && meta.channelId === opts.peek!.channelId
            && (!opts.peek!.serverId || meta.serverId === opts.peek!.serverId);
        })
        .slice(-limit)
        .map(renderHeldLine);
      result.peek = lines;
    }
    return result;
  }

  /**
   * Bookkeeping for one held message, after admission decided the hold:
   * the cadence tally, the deterministic acknowledgement of a suppressed
   * mention, and the reader wake when the resident's gate would have woken
   * them (`gatePass` is that verdict, probed without side effects).
   */
  recordHeld(
    serverId: string,
    channelId: string,
    messageId: string,
    tags: string[] | undefined,
    authorId?: string,
    gatePass = true,
  ): void {
    const key = this.key(serverId, channelId);
    this.divertedSinceInvocation.set(key, (this.divertedSinceInvocation.get(key) ?? 0) + 1);

    // Wake classification: the resident's wake gate composes as a
    // PRECONDITION (antra, #tuneout-talk: the subconscious is affected BY
    // main's wake gate, it does not replace it) — an event the gate would
    // suppress for the resident (muted author, rate-limit) must not wake
    // the subconscious either; it diverts silently into the backlog and
    // surfaces in cadence summaries. On top of the gate: addressed
    // mentions and gate-privileged authors wake, per the issue.
    const addressed = Array.isArray(tags) && tags.includes('chat:addressed');
    const privileged = this.hooks.isPrivilegedAuthor(authorId);
    if (gatePass && addressed) {
      // The mention-er always gets a deterministic signal, independent of
      // what the subconscious later decides (grant-gated; decline
      // precedent). Gate-suppressed mentions get NO reaction: main would
      // not have signaled either, and reacting would leak the resident's
      // standing mute to its subject.
      void this.acknowledgeSuppressed(serverId, channelId, messageId);
    }
    if (gatePass && (addressed || privileged) && this.readerAvailable()) {
      this.scheduleWakeInvocation(serverId, channelId);
    }
  }

  /** Reader forks that reported through `deliver_summary` (so their trailing prose is not a second report). */
  private readerReports = new Set<string>();

  readerReported(reader: string): boolean {
    return this.readerReports.has(reader);
  }

  forgetReader(reader: string): void {
    this.readerReports.delete(reader);
  }

  private async acknowledgeSuppressed(serverId: string, channelId: string, messageId: string): Promise<void> {
    try {
      const server = this.serverRegistry.getServer(serverId);
      if (!server || !CapabilityGrant.of(server).has('channels.acknowledge')) return;
      await server.sendChannelsAcknowledge({
        channelId,
        messageId,
        intent: 'suppressed-tuned-out',
      });
    } catch (err) {
      this.hooks.emitTrace({
        type: 'tune-out:ack-failed',
        serverId,
        channelId,
        error: (err as Error).message,
      });
    }
  }

  // ==========================================================================
  // Subconscious invocation (cadence + coalesced wakes)
  // ==========================================================================

  private startCadence(serverId: string, channelId: string, cadenceSeconds: number): void {
    this.stopCadence(serverId, channelId);
    const key = this.key(serverId, channelId);
    const hold = (timer: ReturnType<typeof setTimeout>): void => { this.cadenceTimers.set(key, timer); };
    const tick = () => {
      const state = this.channelRegistry.getTuneOutState(serverId, channelId);
      if (!state) return; // cancelled meanwhile
      const diverted = this.divertedSinceInvocation.get(key) ?? 0;
      // An empty period needs no turn at all — skip silently.
      if (diverted > 0) {
        this.invokeSubconscious(serverId, channelId, 'cadence', diverted);
      }
      armAfter(cadenceSeconds * 1000, hold, tick);
    };
    armAfter(cadenceSeconds * 1000, hold, tick);
  }

  /** Clear a channel's tune-out timers: its cadence, its end time and a wake
   *  still coalescing. */
  private clearTimers(serverId: string, channelId: string): void {
    const key = this.key(serverId, channelId);
    this.stopCadence(serverId, channelId);
    const expiry = this.expiryTimers.get(key);
    if (expiry) clearTimeout(expiry);
    this.expiryTimers.delete(key);
    const pending = this.pendingWakes.get(key);
    if (pending) clearTimeout(pending.timer);
    this.pendingWakes.delete(key);
  }

  private stopCadence(serverId: string, channelId: string): void {
    const key = this.key(serverId, channelId);
    const timer = this.cadenceTimers.get(key);
    if (timer) clearTimeout(timer);
    this.cadenceTimers.delete(key);
  }

  private scheduleWakeInvocation(serverId: string, channelId: string): void {
    const key = this.key(serverId, channelId);
    const pending = this.pendingWakes.get(key);
    if (pending) {
      pending.count++;
      return;
    }
    const timer = setTimeout(() => {
      const entry = this.pendingWakes.get(key);
      this.pendingWakes.delete(key);
      this.fireWake(serverId, channelId, entry?.count ?? 1);
    }, WAKE_COALESCE_MS);
    this.pendingWakes.set(key, { count: 1, timer });
  }

  /** One coalesced wake: counted durably against the epoch that holds the channel. */
  private fireWake(serverId: string, channelId: string, count: number): void {
    if (this.channelRegistry.getTuneOutState(serverId, channelId)) {
      // Count ONE durable wake per coalesced invocation.
      const counted = this.channelRegistry.recordTuneOutWake(serverId, channelId);
      if (!counted) return; // cancelled inside the window
      if (counted.wakeCount > counted.params.maxWakes) {
        this.cancel(
          serverId,
          channelId,
          'tune-out-max-wakes',
          `wake budget exhausted (${counted.params.maxWakes})`,
        );
        return;
      }
      this.invokeSubconscious(serverId, channelId, 'wake', count);
      return;
    }
    const scope = this.getAllExcept();
    if (!scope) return; // released inside the window
    // The all-except scope: exhausting the budget pauses the reader, it does
    // not end the hold (#232 §3.2 — the hold is the resident's bounded
    // commitment; the deadline ends it).
    const wakeCount = scope.wakeCount + 1;
    this.writeScope({ ...scope, wakeCount });
    if (wakeCount > scope.params.maxWakes) {
      this.hooks.emitTrace({
        type: 'tune-out:wake-budget-paused', epochId: scope.params.epochId, scope: 'all-except',
        serverId, channelId, wakeCount, maxWakes: scope.params.maxWakes,
      });
      return;
    }
    this.invokeSubconscious(serverId, channelId, 'wake', count);
  }

  /**
   * One subconscious turn: a system-framed trigger notice (bracket style —
   * what happened, never what to say) plus standing dispositions, then an
   * inference request. The merged view supplies the actual traffic.
   */
  private invokeSubconscious(
    serverId: string,
    channelId: string,
    trigger: 'cadence' | 'wake',
    count: number,
  ): void {
    const subName = this.hooks.subconsciousName();
    if (!subName && !this.forkReader) return;
    const key = this.key(serverId, channelId);
    this.divertedSinceInvocation.set(key, 0);

    const notice = trigger === 'wake'
      ? `[Tune-out wake: ${channelId} — ${count} addressed message${count === 1 ? '' : 's'}]`
      : `[Tune-out cadence: ${channelId} — ${count} diverted message${count === 1 ? '' : 's'} since your last look]`;
    if (!subName) {
      const hold = this.holdFor(serverId, channelId);
      if (!hold) return;
      this.invokeReaderFork(
        serverId,
        channelId,
        hold.epochId,
        trigger,
        notice,
        this.hooks.getStoredMessages().filter(
          (m) => (m.metadata as { tuneOut?: { epochId?: string }; channelId?: string } | undefined)?.tuneOut?.epochId === hold.epochId
            && ((m.metadata as { channelId?: string } | undefined)?.channelId ?? channelId) === channelId,
        ),
      );
      return;
    }
    this.hooks.addMessage(
      'user',
      [{ type: 'text', text: notice }],
      { system: true, kind: `tune-out-${trigger}`, channelId },
      subName,
    );
    this.hooks.requestInference(subName, `tune-out ${trigger}: ${channelId}`, 'tune-out');
  }

  /**
   * `reader: 'forks'`: hand the framework one invocation. The backlog is
   * the epoch's held messages not yet handed to any fork — each is
   * delivered to exactly one reader — plus the standing dispositions.
   */
  private invokeReaderFork(
    serverId: string,
    channelId: string,
    epochId: string,
    trigger: ReaderInvocation['trigger'],
    notice: string,
    epochBacklog: StoredMessage[],
  ): void {
    if (!this.hooks.invokeReader) return;
    const key = this.key(serverId, channelId);
    const cursor = this.readerCursor.get(key) ?? -1;
    const backlog = epochBacklog.filter((m) => m.sequence > cursor).sort((a, b) => a.sequence - b.sequence);
    if (backlog.length > 0) this.readerCursor.set(key, backlog[backlog.length - 1]!.sequence);
    const entries = Object.entries(this.readDispositions());
    this.hooks.invokeReader({
      serverId,
      channelId,
      epochId,
      trigger,
      notice,
      backlog,
      dispositions: entries.length > 0 ? entries.map(([k, v]) => `- ${k}: ${v}`).join('\n') : null,
    });
  }

  // ==========================================================================
  // Dispositions (standing notes, snapshot slot)
  // ==========================================================================

  private dispositionsCache: Record<string, string> | null = null;

  private get dispositionsStateId(): string {
    return `subconscious/${this.hooks.primaryName() ?? 'default'}/dispositions`;
  }

  /**
   * The dispositions as a fixed system-position ContextInjection for the
   * subconscious's compiles (antra: deliver changes, never let them wash
   * away — it has no long-term memory, so they must not live in window
   * content). Bytes change only when a disposition changes: KV-friendly.
   */
  getDispositionsInjection(): {
    namespace: string;
    position: 'system';
    content: Array<{ type: 'text'; text: string }>;
  } | null {
    const dispositions = this.readDispositions();
    const entries = Object.entries(dispositions);
    if (entries.length === 0) return null;
    return {
      namespace: 'dispositions',
      position: 'system',
      content: [{
        type: 'text',
        text: `[Standing dispositions]\n${entries.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`,
      }],
    };
  }

  private readDispositions(): Record<string, string> {
    if (this.dispositionsCache) return this.dispositionsCache;
    try {
      const raw = this.channelRegistry.readCoordinatorState(this.dispositionsStateId);
      this.dispositionsCache = (raw && typeof raw === 'object') ? raw as Record<string, string> : {};
    } catch {
      this.dispositionsCache = {};
    }
    return this.dispositionsCache;
  }

  noteDisposition(key: string, text: string): void {
    const dispositions = { ...this.readDispositions() };
    if (text === '') {
      delete dispositions[key];
    } else {
      dispositions[key] = text;
    }
    this.dispositionsCache = dispositions;
    this.channelRegistry.writeCoordinatorState(this.dispositionsStateId, dispositions);
  }

  // ==========================================================================
  // Subconscious tool dispatch
  // ==========================================================================

  async handleSubconsciousTool(
    name: string,
    input: Record<string, unknown>,
    /** The calling agent: the persistent subconscious, or a reader fork. */
    caller?: string,
  ): Promise<{ success: boolean; data?: unknown; error?: string; isError?: boolean }> {
    switch (name) {
      case 'deliver_summary': {
        const text = String(input.text ?? '').trim();
        const channelId = String(input.channelId ?? '');
        if (!text) return { success: false, error: 'empty summary', isError: false };
        const subName = this.hooks.subconsciousName();
        if (subName) {
          // Verbatim, under its own participant name, into the resident's window.
          this.hooks.addMessage(subName, [{ type: 'text', text }], {
            kind: 'subconscious-summary',
            channelId,
          });
          return { success: true, data: { delivered: true } };
        }
        if (caller && this.hooks.deliverFromReader) {
          // A reader fork's report: attributed mail under its own name.
          this.readerReports.add(caller);
          this.hooks.deliverFromReader(caller, [{ type: 'text', text }], {
            kind: 'subconscious-summary',
            channelId,
          });
          return { success: true, data: { delivered: true } };
        }
        return { success: false, error: 'subconscious not configured', isError: true };
      }
      case 'cancel_tuneout': {
        const channelId = String(input.channelId ?? '');
        const note = typeof input.text === 'string' && input.text.trim() ? input.text.trim() : undefined;
        const located = this.findByChannel(channelId, typeof input.serverId === 'string' ? input.serverId : undefined);
        if (located && 'error' in located) return { success: false, error: located.error, isError: false };
        if (!located) {
          // The reader keeps its latitude over the all-except hold too: a
          // channel it holds (or the scope named outright) ends the scope.
          const scope = this.getAllExcept();
          const heldByScope = scope && (input.scope === 'all-except' || channelId === 'all-except'
            || (channelId !== '' && this.holdFor(typeof input.serverId === 'string' ? input.serverId : scope.params.except.serverId, channelId)?.epochId === scope.params.epochId));
          if (!heldByScope) return { success: false, error: `channel ${channelId} is not tuned out`, isError: false };
          const result = this.cancelAllExcept('subconscious', 'subconscious judgment', note, caller);
          return result.ok
            ? { success: true, data: { cancelled: true, scope: 'all-except' } }
            : { success: false, error: result.error, isError: false };
        }
        const result = this.cancel(located.serverId, channelId, 'subconscious', 'subconscious judgment', note, caller);
        return result.ok
          ? { success: true, data: { cancelled: true } }
          : { success: false, error: result.error, isError: false };
      }
      case 'note_disposition': {
        const key = String(input.key ?? '').trim();
        if (!key) return { success: false, error: 'key required', isError: false };
        this.noteDisposition(key, String(input.text ?? ''));
        return { success: true, data: { noted: key } };
      }
      case 'speak_in_channel': {
        if (!this.hooks.allowChannelSpeech()) {
          return {
            success: false,
            isError: false,
            error: 'channel speech is disabled for the subconscious (recipe: subconscious.allowChannelSpeech)',
          };
        }
        const channelId = String(input.channelId ?? '');
        const text = String(input.text ?? '').trim();
        if (!text) return { success: false, error: 'empty message', isError: false };
        return this.channelRegistry.publishForAgent(channelId, text, this.hooks.subconsciousName() ?? caller ?? 'Subconscious');
      }
      default:
        return { success: false, error: `unknown subconscious tool: ${name}`, isError: true };
    }
  }

  /** Server-qualified lookup among active epochs; an id on several servers is an error (#232 gap 8). */
  private findByChannel(channelId: string, serverId?: string): { serverId: string } | { error: string } | null {
    const matches = this.listActive().filter(
      (e) => e.channelId === channelId && (!serverId || e.serverId === serverId),
    );
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      return { error: `channel ${channelId} is tuned out on several servers (${matches.map((m) => m.serverId).join(', ')}); include serverId` };
    }
    return { serverId: matches[0]!.serverId };
  }

  /** Stop all timers (framework shutdown). */
  stop(): void {
    for (const timer of this.cadenceTimers.values()) clearTimeout(timer);
    this.cadenceTimers.clear();
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    for (const { timer } of this.pendingWakes.values()) clearTimeout(timer);
    this.pendingWakes.clear();
  }
}
