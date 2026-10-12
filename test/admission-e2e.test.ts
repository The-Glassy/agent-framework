/**
 * The admission stage (issue #232 §3.5, Dendrite §D): one decision per
 * inbound event per recipient, taken before any side effect. These are the
 * #232 gap probes as regression tests — each `it` names the gap it closes.
 *
 * Harness: the RFC-006 loopback MCPL server and a mocked model. The event
 * loop is driven explicitly (`runUntilIdle`), so every wake that is expected
 * has a scripted response and every wake that is not shows up as a hang-free
 * `membrane.calls` count. The persistent subconscious is the reader unless a
 * test says otherwise.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, eventually, TS } from './helpers/coalescing-fixture.js';
import { GateModule, waitCall, say } from './helpers/dendrite.js';
import type { TuneOutCoordinator } from '../src/tune-out/coordinator.js';
import type { FrameworkConfig } from '../src/types/framework.js';

type Stored = { participant: string; content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> };
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Internals = {
  tuneOutCoordinator: TuneOutCoordinator | null;
  channelRegistry: {
    getDefaultPublishChannel(): string | null;
    resolveLocus(agent: string): string | null;
    getDesiredState(serverId: string, channelId: string): string | undefined;
    getTuneOutState(serverId: string, channelId: string): { params: { epochId: string } } | null;
    channels: Map<string, unknown>;
  };
  eventGate: { debounceTimers: Map<string, unknown> } | null;
  deferredMessages: Array<{ content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> }>;
  handleTuneOutTool(agentName: string, input: Record<string, unknown>): { success: boolean; error?: string; data?: unknown };
};

const SUB = { enabled: true, systemPrompt: 'You are the Subconscious. Report briefly.' } as const;
const internals = (f: Fixture) => f.framework as unknown as Internals;
const textOf = (m: { content: Array<{ type: string; text?: string }> }): string =>
  m.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
const stored = (f: Fixture, agent = 'agent'): Stored[] =>
  f.framework.getAgent(agent)!.getContextManager().getAllMessages() as unknown as Stored[];
const held = (m: Stored): boolean => !!(m.metadata as { tuneOut?: unknown } | undefined)?.tuneOut;
const has = (f: Fixture, text: string) => stored(f).some((m) => textOf(m).includes(text));
const find = (f: Fixture, text: string) => stored(f).find((m) => textOf(m).includes(text))!;
const AMBIENT = ['chat:ambient', 'chat:from-human'];
const MENTION = ['chat:mention', 'chat:addressed', 'chat:from-human'];

function incoming(f: Fixture, channelId: string, messageId: string, text: string, tags = AMBIENT, content?: unknown[]) {
  return f.send('channels/incoming', {
    messages: [{
      channelId, messageId, timestamp: TS, author: { id: 'U1', name: 'antra' }, tags,
      content: content ?? [{ type: 'text', text }],
    }],
  });
}

/** A Discord-shaped DM: it arrives as a push event, since the DM channel is closed. */
function dm(f: Fixture, eventId: string, text: string) {
  return f.send('push/event', {
    featureSet: 'doc', eventId, timestamp: TS,
    payload: { content: [{ type: 'text', text }] },
    origin: { source: 'discord', channelId: '777', guildId: null, isDM: true, authorId: 'U1', authorName: 'antra', messageId: eventId },
    tags: ['chat:dm', 'chat:addressed', 'chat:from-human'],
  });
}

async function registerOpen(f: Fixture, ...ids: string[]) {
  await f.send('channels/register', {
    channels: ids.map((id) => ({ id, type: 'discord', label: id, initiallyOpen: true, metadata: { channelType: 'guild_text' } })),
  });
  await eventually(() => ids.every((id) => internals(f).channelRegistry.getDesiredState('editor', id) === 'open'), 'channels open');
}

function enter(f: Fixture, channelId: string, opts: Record<string, number> = {}) {
  const r = internals(f).tuneOutCoordinator!.enter('editor', channelId, { cadenceSeconds: 3600, maxWakes: 5, ...opts }, 'agent-tool');
  assert.ok(r.ok, `enter ${channelId}: ${(r as { error?: string }).error ?? ''}`);
}

/** Process what the server sent; nothing may wake (no response is scripted). */
async function settle(f: Fixture): Promise<void> {
  const before = f.membrane.calls.length;
  // A sentinel keeps an unexpected wake from hanging the mock; the count
  // below is the assertion. Unused, it is swallowed by the next scripted turn.
  f.membrane.pushResponse(say('[unexpected wake]'));
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, before, 'nothing woke');
}

/** Run a turn nothing delivered into (a heartbeat) and report the locus it froze. */
async function channellessTurnLocus(f: Fixture): Promise<string | null> {
  let locus: string | null | undefined;
  const off = f.framework.onTrace((t) => {
    if (t.type === 'inference:started' && (t as { agentName: string }).agentName === 'agent') {
      locus = (t as { channelId?: string }).channelId ?? null;
    }
  });
  try {
    (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
      agentName: 'agent', reason: 'heartbeat', source: 'test', timestamp: Date.now(),
    });
    await f.turn();
  } finally { off(); }
  assert.notEqual(locus, undefined, 'the heartbeat turn ran');
  return locus ?? null;
}

/** A resident turn blocked in a tool call, on an open channel. */
async function blockInTool(f: Fixture, gate: GateModule): Promise<{ loop: Promise<void> }> {
  // The fixture pre-scripts one 'ok'; the mock hands every queued response
  // to the first stream, so start this turn's script from a clean queue.
  f.membrane.responses.length = 0;
  (f.membrane as unknown as { responseIndex: number }).responseIndex = 0;
  f.membrane.pushResponse(waitCall('g1'));
  f.membrane.pushResponse(say('done'));
  await incoming(f, 'work', 'w1', 'please wait for me');
  const loop = f.framework.runUntilIdle();
  await eventually(() => gate.entered.has('g1'), 'resident blocked in a tool call');
  return { loop }; // wrapped: an async return would await the loop itself
}

describe('admission: the hold is decided once, before any side effect', () => {
  it('gap 1 — tuning out a DM holds the next DM (the push-event lane consults the hold)', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await dm(f, 'dm-0', 'first dm');
      await f.turn();
      assert.ok(has(f, 'first dm'));
      const callsBefore = f.membrane.calls.length;
      assert.ok(callsBefore >= 1, 'the first DM woke the resident');

      enter(f, 'discord:dm:777');
      await dm(f, 'dm-1', 'second dm');
      await settle(f);
      assert.ok(held(find(f, 'second dm')), 'the second DM carries the hold record');
      const compiled = await f.framework.getAgent('agent')!.getContextManager().compile();
      assert.ok(!compiled.messages.some((m) => textOf(m as Stored).includes('second dm')), 'a held DM is not in the resident\'s view');
    } finally { await f.close(); }
  });

  it('gap 2 — held traffic never moves the speech locus; under the default rule no inbound traffic does', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      await incoming(f, 'work', 'w1', 'hello from work');
      await f.turn();
      assert.ok(has(f, 'hello from work'));
      // `speech.locus: 'delivery'` (default): a turn nothing delivered into
      // (a heartbeat here) has no locus — not the last channel that spoke.
      assert.equal(await channellessTurnLocus(f), null, 'no global latest-inbound locus');
      assert.ok(has(f, 'no channel'), 'the resident is told their prose stays private');

      enter(f, 'noisy');
      await incoming(f, 'noisy', 'n1', 'noise');
      await settle(f);
      assert.ok(held(find(f, 'noise')));
      assert.notEqual(internals(f).channelRegistry.getDefaultPublishChannel(), 'noisy', 'held traffic is not "the latest inbound" either');
      assert.equal(await channellessTurnLocus(f), null);
    } finally { await f.close(); }
  });

  it('gap 2 (legacy rule) — `speech.locus: "latest-inbound"`: delivered traffic moves the locus, held traffic does not', async () => {
    const f = await fixture({ framework: { subconscious: SUB, speech: { locus: 'latest-inbound' } } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      await incoming(f, 'work', 'w1', 'hello from work');
      await f.turn();
      assert.equal(await channellessTurnLocus(f), 'work', 'legacy: the last delivered channel is the fallback locus');

      enter(f, 'noisy');
      await incoming(f, 'noisy', 'n1', 'noise');
      await settle(f);
      assert.equal(await channellessTurnLocus(f), 'work', 'held traffic did not move it');
    } finally { await f.close(); }
  });

  it('gap 3 — a debounce policy never queues a held mention; the reader still gets the gate\'s verdict', async () => {
    const f = await fixture({
      framework: {
        subconscious: SUB,
        gate: { config: { default: 'always', policies: [
          { name: 'noisy-debounce', match: { scope: ['mcpl:channel-incoming'], channel: 'noisy' }, behavior: { debounce: 60_000 } },
        ] } },
      } as Partial<FrameworkConfig>,
    });
    try {
      await registerOpen(f, 'noisy');
      const gate = internals(f).eventGate!;
      // Control: not held → the debounce batches the mention, nobody wakes yet.
      await incoming(f, 'noisy', 'c1', 'hey agent', MENTION);
      await settle(f);
      assert.ok(has(f, 'hey agent'));
      assert.equal(gate.debounceTimers.size, 1, 'control: the gate batched the mention');
      gate.debounceTimers.forEach((s) => clearTimeout((s as { timer: ReturnType<typeof setTimeout> }).timer));
      gate.debounceTimers.clear();

      enter(f, 'noisy');
      await incoming(f, 'noisy', 'h1', 'agent, you there?', MENTION);
      await settle(f);
      assert.ok(held(find(f, 'you there')));
      assert.equal(gate.debounceTimers.size, 0, 'a held mention is not batched for the resident');
      const coordinator = internals(f).tuneOutCoordinator as unknown as { pendingWakes: Map<string, unknown> };
      assert.equal(coordinator.pendingWakes.size, 1, 'the reader wake is scheduled: the gate\'s verdict (would wake) reached the coordinator');
    } finally { await f.close(); }
  });

  it('gap 4 — the release names non-text blocks instead of dropping them', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      await incoming(f, 'noisy', 'i1', '', AMBIENT, [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }]);
      await incoming(f, 'noisy', 'i2', '', AMBIENT, [
        { type: 'text', text: 'look at this' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      ]);
      await settle(f);
      assert.equal(stored(f).filter(held).length, 2, 'two held messages');
      assert.ok(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'test').ok);
      const release = textOf(find(f, '<tuned-out-backlog'));
      assert.match(release, /antra: \[image\]/, 'an image-only message names its image');
      assert.match(release, /antra: look at this \[image\]/, 'a captioned image keeps both');
    } finally { await f.close(); }
  });

  it('gap 5 — a held message arriving mid-turn is stored, not injected into the live turn', async () => {
    const gate = new GateModule();
    const f = await fixture({ framework: { subconscious: SUB, modules: [gate] } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy');
      const { loop } = await blockInTool(f, gate);
      await incoming(f, 'noisy', 'n1', 'held while acting');
      await eventually(
        () => internals(f).deferredMessages.some((m) => textOf(m as Stored).includes('held while acting')) || has(f, 'held while acting'),
        'held message arrived',
      );
      gate.release('g1');
      await loop;
      assert.ok(held(find(f, 'held while acting')), 'stored with the hold record');
      const injected = f.membrane.lastStream!.receivedToolResultOptions
        .flatMap((o) => o?.injectedMessages ?? [])
        .map((m) => JSON.stringify(m.content));
      assert.ok(!injected.some((s) => s.includes('held while acting')), 'the live turn never saw the held message');
      const compiled = await f.framework.getAgent('agent')!.getContextManager().compile();
      assert.ok(!compiled.messages.some((m) => textOf(m as Stored).includes('held while acting')), 'nor does the next compile');
    } finally { await f.close(); }
  });

  it('gap 7 — a held message still in the deferred queue at cancel is in the release', async () => {
    const gate = new GateModule();
    const f = await fixture({ framework: { subconscious: SUB, modules: [gate] } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      const { loop } = await blockInTool(f, gate);
      await incoming(f, 'noisy', 'n1', 'deferred and held');
      await eventually(() => internals(f).deferredMessages.some((m) => textOf(m as Stored).includes('deferred and held')), 'held message deferred');
      assert.ok(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'test').ok);
      // The cancel wakes the resident (after this turn) and the reader; the
      // mock answers every further request so neither wake is left streaming.
      f.alwaysRespond();
      gate.release('g1');
      await loop;
      const release = textOf(find(f, '<tuned-out-backlog'));
      assert.match(release, /messages=1/, 'the deferred message is counted');
      assert.match(release, /antra: deferred and held/, 'and listed');
    } finally { await f.close(); }
  });

  it('gap 6 — a release deferred behind a live turn is durable, and a boot that finds it re-wakes the resident', async () => {
    const gate = new GateModule();
    const f = await fixture({ framework: { subconscious: SUB, modules: [gate] } as Partial<FrameworkConfig> });
    const recovery = join(f.dir, 'store', 'recovery', 'deferred-writes.json');
    let saved: string;
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      const { loop } = await blockInTool(f, gate);
      await incoming(f, 'noisy', 'n1', 'held before the crash');
      await eventually(() => internals(f).deferredMessages.some((m) => textOf(m as Stored).includes('held before the crash')), 'held message deferred');
      assert.ok(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'test').ok);
      // The epoch is ended durably; the release, still deferred, is too.
      assert.ok(existsSync(recovery), 'the deferred queue was persisted by the cancel');
      saved = readFileSync(recovery, 'utf8');
      assert.match(saved, /tune-out-cancel/, 'the release is in the durable queue');
      f.alwaysRespond();
      gate.release('g1');
      await loop;
    } finally { await f.close(); }

    // A fresh process over a store that never saw the release land: the
    // same file, found at boot.
    const dir = mkdtempSync(join(tmpdir(), 'admission-reboot-'));
    const deferredWritesPath = join(dir, 'deferred-writes.json');
    writeFileSync(deferredWritesPath, saved!);
    const g = await fixture({ framework: { subconscious: SUB, deferredWritesPath } as Partial<FrameworkConfig>, dir });
    try {
      const pending = (g.framework as unknown as { pendingRequests: Array<{ agentName: string; reason: string }> }).pendingRequests;
      assert.ok(pending.some((r) => r.agentName === 'agent' && /tune-out released/.test(r.reason)), 'the restored release owes the resident its wake');
      assert.match(textOf(find(g, '<tuned-out-backlog')), /antra: held before the crash/, 'the release landed at boot');
    } finally { await g.close(); }
  });

  it('gap 9 — channel_close on a tuned-out channel goes through the cancel flow', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      await incoming(f, 'noisy', 'n1', 'held before close');
      await settle(f);
      assert.equal(stored(f).filter(held).length, 1);
      const result = await f.framework.executeToolCall({ id: 'c1', name: 'channel_close', input: { channelId: 'noisy' }, callerAgentName: 'agent' } as never);
      assert.ok(result.success, result.error);
      assert.equal(internals(f).channelRegistry.getDesiredState('editor', 'noisy'), 'closed');
      assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'noisy'), null, 'the epoch ended');
      assert.match(textOf(find(f, '<tuned-out-backlog')), /antra: held before close/, 'the release was delivered');
    } finally { await f.close(); }
  });

  it('gap 10 / §3.3 — without a reader, tune-out is a silent hold that still releases', async () => {
    const f = await fixture();
    try {
      await registerOpen(f, 'noisy');
      const coordinator = internals(f).tuneOutCoordinator;
      assert.ok(coordinator, 'the coordinator exists without a subconscious');
      enter(f, 'noisy', { backlogCap: 10 });
      await incoming(f, 'noisy', 'n1', 'agent?', MENTION);
      await settle(f);
      assert.equal(stored(f).filter(held).length, 1, 'held');
      assert.ok(coordinator!.cancel('editor', 'noisy', 'agent-tool', 'test').ok);
      assert.match(textOf(find(f, '<tuned-out-backlog')), /antra: agent\?/, 'the release reaches the resident');
    } finally { await f.close(); }
  });

  it('gap 8 — the tune_out tool refuses an ambiguous channel id and takes serverId', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'noisy');
      const i = internals(f);
      // A second server with the same channel id.
      i.channelRegistry.channels.set('other:noisy', { serverId: 'other', descriptor: { id: 'noisy', type: 'discord', label: 'noisy' }, open: true });
      const ambiguous = i.handleTuneOutTool('agent', { channelId: 'noisy' });
      assert.equal(ambiguous.success, false);
      assert.match(ambiguous.error ?? '', /ambiguous/);
      const resolved = i.handleTuneOutTool('agent', { channelId: 'noisy', serverId: 'editor' });
      assert.ok(resolved.success, resolved.error);
      assert.ok(i.channelRegistry.getTuneOutState('editor', 'noisy'));
    } finally { await f.close(); }
  });
});
