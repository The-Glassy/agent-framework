/**
 * The all-except scope (issue #232 §3.2; focus folded into tune-out): hold
 * every channel except one, for a bounded time. A resident-level policy
 * epoch, decided by the same admission stage as a per-channel tune-out.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/coalescing-fixture.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import {
  SUB, internals, textOf, stored, held, has, find, MENTION,
  incoming, dm, registerOpen, enter, settle, channellessTurnLocus,
} from './helpers/admission.js';

const epochOf = (m: { metadata?: Record<string, unknown> }): string | undefined =>
  (m.metadata as { tuneOut?: { epochId?: string } } | undefined)?.tuneOut?.epochId;

function enterAllExcept(f: Parameters<typeof internals>[0], except: string, opts: Record<string, number> = {}) {
  const r = internals(f).tuneOutCoordinator!.enterAllExcept(
    { serverId: 'editor', channelId: except }, { durationSeconds: 120, backlogCap: 10, ...opts }, 'agent-tool',
  );
  assert.ok(r.ok, `all-except: ${(r as { error?: string }).error ?? ''}`);
  return (r as { params: { epochId: string } }).params;
}

describe('tune-out, all-except scope', () => {
  it('holds every channel but the excepted one — including DMs and channels registered later', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      const scope = enterAllExcept(f, 'work');

      await incoming(f, 'noisy', 'n1', 'noise one');
      await settle(f);
      assert.equal(epochOf(find(f, 'noise one')), scope.epochId, 'held under the scope\'s epoch');

      await dm(f, 'dm-1', 'a dm while focused');
      await settle(f);
      assert.equal(epochOf(find(f, 'a dm while focused')), scope.epochId, 'a DM is held too (resident-level, not per channel)');

      await registerOpen(f, 'late');
      await incoming(f, 'late', 'l1', 'registered after entry');
      await settle(f);
      assert.equal(epochOf(find(f, 'registered after entry')), scope.epochId, 'a channel registered after entry is held');

      await incoming(f, 'work', 'w1', 'the excepted channel', MENTION);
      await f.turn();
      assert.ok(!held(find(f, 'the excepted channel')), 'the excepted channel is delivered');
      assert.ok(f.membrane.calls.length >= 1, 'and wakes');

      const epochs = f.framework.listPolicyEpochs();
      const listed = epochs.find((e) => e.id === scope.epochId);
      assert.ok(listed, 'the scope is a policy epoch');
      assert.deepEqual(listed!.scope, { kind: 'all-except', except: { serverId: 'editor', channelId: 'work' } });
      assert.equal(typeof listed!.expiresAtMs, 'number', 'bounded');
    } finally { await f.close(); }
  });

  it('while active, a turn with no delivery of its own speaks into the excepted channel; after cancel it has no locus', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      assert.equal(await channellessTurnLocus(f), null, 'default rule: no locus without a delivery');
      enterAllExcept(f, 'work');
      assert.equal(await channellessTurnLocus(f), 'work', 'the focus destination');
      assert.ok(internals(f).tuneOutCoordinator!.cancelAllExcept('agent-tool', 'test').ok);
      f.alwaysRespond(); // the release wakes the resident and the reader
      await f.framework.runUntilIdle();
      assert.equal(await channellessTurnLocus(f), null, 'gone with the scope');
    } finally { await f.close(); }
  });

  it('check reports held counts per channel and peeks one channel without releasing', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy', 'other');
      const scope = enterAllExcept(f, 'work');
      await incoming(f, 'noisy', 'n1', 'noise one');
      await incoming(f, 'noisy', 'n2', 'noise two');
      await incoming(f, 'other', 'o1', 'elsewhere');
      await settle(f);
      const report = internals(f).tuneOutCoordinator!.check({ peek: { serverId: 'editor', channelId: 'noisy' }, peekLimit: 1 });
      assert.ok(report.allExcept, 'the scope is reported');
      assert.equal(report.allExcept!.epochId, scope.epochId);
      assert.deepEqual(report.allExcept!.held, { noisy: 2, other: 1 });
      assert.deepEqual(report.peek, ['antra: noise two'], 'peek shows the newest held line, capped');
      assert.ok(internals(f).tuneOutCoordinator!.getAllExcept(), 'still active');
      assert.equal(stored(f).filter(held).length, 3, 'nothing released');
      assert.ok(!has(f, '<tuned-out-backlog'), 'no release notice');
    } finally { await f.close(); }
  });

  it('cancel releases per held channel with a per-channel cap; the originals stay excluded', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy', 'other');
      enterAllExcept(f, 'work', { backlogCap: 1 });
      await incoming(f, 'noisy', 'n1', 'noise one');
      await incoming(f, 'noisy', 'n2', 'noise two');
      await incoming(f, 'other', 'o1', 'elsewhere');
      await settle(f);
      assert.ok(internals(f).tuneOutCoordinator!.cancelAllExcept('agent-tool', 'test').ok);
      f.alwaysRespond(); // the release wakes the resident and the reader
      const release = textOf(find(f, 'all channels except'));
      assert.match(release, /\[Tune-out: all channels except work released — test/);
      assert.match(release, /<tuned-out-backlog channel="noisy" messages=2 truncated=1/);
      assert.match(release, /antra: noise two/);
      assert.ok(!/antra: noise one/.test(release), 'per-channel cap applied');
      assert.match(release, /<tuned-out-backlog channel="other" messages=1/);
      assert.match(release, /antra: elsewhere/);
      assert.equal(internals(f).tuneOutCoordinator!.getAllExcept(), null, 'scope ended');
      const compiled = await f.framework.getAgent('agent')!.getContextManager().compile();
      assert.ok(!compiled.messages.some((m) => textOf(m as never).includes('noise one') && !textOf(m as never).includes('<tuned-out-backlog')), 'originals stay view-excluded');
      await incoming(f, 'noisy', 'n3', 'after release', MENTION);
      await f.turn();
      assert.ok(!held(find(f, 'after release')), 'traffic is delivered again');
    } finally { await f.close(); }
  });

  it('precedence: a per-channel epoch keeps its own hold; the excepted channel cannot be tuned out', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy');
      const perChannel = internals(f).channelRegistry.getTuneOutState('editor', 'noisy')!.params.epochId;
      const scope = enterAllExcept(f, 'work');
      await incoming(f, 'noisy', 'n1', 'noise under both');
      await settle(f);
      assert.equal(epochOf(find(f, 'noise under both')), perChannel, 'the per-channel epoch wins');
      assert.notEqual(perChannel, scope.epochId);

      const refused = internals(f).tuneOutCoordinator!.enter('editor', 'work', { cadenceSeconds: 3600 }, 'agent-tool');
      assert.equal(refused.ok, false);
      assert.match((refused as { error: string }).error, /excepted/);

      assert.ok(internals(f).tuneOutCoordinator!.cancelAllExcept('agent-tool', 'test').ok);
      const again = internals(f).tuneOutCoordinator!.enterAllExcept({ serverId: 'editor', channelId: 'noisy' }, { durationSeconds: 120 }, 'agent-tool');
      assert.equal(again.ok, false, 'a tuned-out channel cannot be the exception');
      assert.match((again as { error: string }).error, /tuned out/);
    } finally { await f.close(); }
  });

  it('the duration is mandatory, and a second scope is refused', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work');
      const noDuration = internals(f).tuneOutCoordinator!.enterAllExcept({ serverId: 'editor', channelId: 'work' }, {} as never, 'agent-tool');
      assert.equal(noDuration.ok, false);
      assert.match((noDuration as { error: string }).error, /durationSeconds/);
      enterAllExcept(f, 'work');
      const second = internals(f).tuneOutCoordinator!.enterAllExcept({ serverId: 'editor', channelId: 'work' }, { durationSeconds: 120 }, 'agent-tool');
      assert.equal(second.ok, false);
      assert.match((second as { error: string }).error, /already/);
    } finally { await f.close(); }
  });

  it('the tool: scope all-except, check, cancel — and `focus` as the alias', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      const i = internals(f);
      const noDuration = i.handleTuneOutTool('agent', { channelId: 'work', scope: 'all-except' });
      assert.equal(noDuration.success, false);
      assert.match(noDuration.error ?? '', /durationSeconds/);
      const entered = i.handleTuneOutTool('agent', { channelId: 'work', scope: 'all-except', durationSeconds: 120 });
      assert.ok(entered.success, entered.error);
      assert.equal((entered.data as { except?: string }).except, 'work');
      await incoming(f, 'noisy', 'n1', 'noise');
      await settle(f);
      const check = i.handleTuneOutTool('agent', { mode: 'check', peek: 'noisy' });
      assert.ok(check.success, check.error);
      assert.deepEqual((check.data as { allExcept: { held: Record<string, number> } }).allExcept.held, { noisy: 1 });
      assert.deepEqual((check.data as { peek: string[] }).peek, ['antra: noise']);
      const cancelled = i.handleTuneOutTool('agent', { mode: 'cancel', scope: 'all-except' });
      assert.ok(cancelled.success, cancelled.error);
      assert.equal(i.tuneOutCoordinator!.getAllExcept(), null);

      const focus = (f.framework as unknown as { handleFocusTool(agent: string, input: Record<string, unknown>): { success: boolean; error?: string; data?: unknown } })
        .handleFocusTool('agent', { channelId: 'work', durationSeconds: 120 });
      assert.ok(focus.success, focus.error);
      assert.equal(i.tuneOutCoordinator!.getAllExcept()!.params.except.channelId, 'work');
      assert.ok(f.framework.getAllTools().some((t) => t.name === 'focus'), 'focus is offered as the alias');
    } finally { await f.close(); }
  });

  it('closing the excepted channel ends the scope', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enterAllExcept(f, 'work');
      await incoming(f, 'noisy', 'n1', 'held');
      await settle(f);
      const result = await f.framework.executeToolCall({ id: 'c1', name: 'channel_close', input: { channelId: 'work' }, callerAgentName: 'agent' } as never);
      assert.ok(result.success, result.error);
      assert.equal(internals(f).tuneOutCoordinator!.getAllExcept(), null, 'nothing left to speak into: the scope ended');
      assert.match(textOf(find(f, 'all channels except')), /antra: held/);
    } finally { await f.close(); }
  });
});

