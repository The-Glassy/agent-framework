/**
 * Speculative channel chunks (docs/speculative-channel-chunks.md): the text
 * of a channel_publish call streams to a channel that opted in
 * (`capabilities.streaming.speculative`) while the model writes the call,
 * and the publish's outcome ends the stream: complete with the full text, or
 * cancelled with empty content.
 */

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, Membrane, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStreamOptions } from '@animalabs/membrane';
import { AgentFramework, type AgentConfig, type Module, type ModuleContext, type ProcessEvent, type ProcessState } from '../src/index.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';
import { PublishArgsReader, SpeculativePublishStreams, type SpeculativeStreamSink } from '../src/speculative-publish.js';
import { ChannelRegistry, type ChannelRef } from '../src/mcpl/channel-registry.js';
import { ALL_CAPABILITY_PATHS, CapabilityGrant } from '../src/mcpl/capability-grant.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

// ---------------------------------------------------------------------------
// PublishArgsReader
// ---------------------------------------------------------------------------

/** Feeds `json` to a reader in the given cut points; returns it and the deltas. */
function read(json: string, cuts: number[]) {
  const reader = new PublishArgsReader();
  const deltas: string[] = [];
  let at = 0;
  for (const cut of [...cuts, json.length]) {
    const d = reader.push(json.slice(at, cut));
    if (d) deltas.push(d);
    at = cut;
  }
  return { reader, deltas };
}

const TRICKY = 'Line one.\nShe said "hi" \\ back\t/ é 😀 end';

test('reader: content split at every position, escapes included, decodes to what JSON.parse gives', () => {
  const json = JSON.stringify({ channelId: 'bosun:meeting:1', content: TRICKY });
  // Also the escaped forms the model may write: é and a surrogate pair as 😀.
  const escaped = json.replace('é', '\\u00e9').replace('😀', '\\ud83d\\ude00').replace('/', '\\/');
  for (const source of [json, escaped]) {
    assert.equal(JSON.parse(source).content, TRICKY);
    for (let cut = 0; cut <= source.length; cut++) {
      const { reader, deltas } = read(source, [cut]);
      assert.equal(deltas.join(''), TRICKY, `cut at ${cut}: ${JSON.stringify(source.slice(0, cut))}`);
      assert.equal(reader.channelId, 'bosun:meeting:1');
      assert.equal(reader.done, true);
      assert.equal(reader.failed, false);
    }
    // One character at a time: every escape and the surrogate pair cross fragments.
    const { deltas } = read(source, [...source].map((_, i) => i + 1).slice(0, -1));
    assert.equal(deltas.join(''), TRICKY);
    // No delta holds half a surrogate pair.
    for (const d of deltas) assert.ok(!/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(d), `delta ${JSON.stringify(d)} splits a pair`);
  }
});

test('reader: channelId after content, text as the alias, other values skipped', () => {
  const json = '{ "meta": {"a": "}\\"{", "b": [1, {"c": null}]}, "n": -1.5e3, "ok": true, "content": "Hi.", "channelId": "room" }';
  const { reader, deltas } = read(json, [20, 40, 60]);
  assert.equal(deltas.join(''), 'Hi.');
  assert.equal(reader.channelId, 'room');
  assert.equal(reader.sendKey, 'content');
  assert.equal(reader.done, true);

  const alias = read('{"text":"Via text.","channelId":"room","serverId":"srv"}', [5, 12]);
  assert.equal(alias.deltas.join(''), 'Via text.');
  assert.equal(alias.reader.sendKey, 'text');
  assert.equal(alias.reader.serverId, 'srv');

  // Only the first of content/text streams, and a repeated key doesn't.
  const both = read('{"content":"One.","text":"Two.","content":"Three."}', []);
  assert.equal(both.deltas.join(''), 'One.');
});

test('reader: what is not a JSON object stops it', () => {
  assert.equal(read('["content"]', []).reader.failed, true);
  // A skipped value that isn't JSON: the call can't parse, so nothing after it streams.
  for (const bad of ['{"junk":"raw\nnewline","content":"Never."}', '{"a":1,,"content":"Never."}', '{"a":1,}', '{"a":1,\u00a0"content":"Never."}',
    '{"junk":truX,"content":"Never."}', '{"n":1.2.3,"content":"Never."}', '{"meta":{tru},"content":"Never."}', '{"meta":[1,,2],"content":"Never."}']) {
    const r = read(bad, [9]);
    assert.equal(r.reader.failed, true, bad);
    assert.deepEqual(r.deltas, [], bad);
  }
  assert.equal(read('{"content" "x"}', []).reader.failed, true);
  assert.equal(read('{"content":"bad \\q escape"}', []).reader.failed, true);
  assert.equal(read('{"content":"x"} trailing', []).reader.failed, true);
  const partial = read('{"channelId":"room","content":"Half a sen', []);
  assert.equal(partial.reader.failed, false);
  assert.equal(partial.reader.done, false);
  assert.equal(partial.deltas.join(''), 'Half a sen');
});

// ---------------------------------------------------------------------------
// SpeculativePublishStreams
// ---------------------------------------------------------------------------

type Sent =
  | { kind: 'chunk'; channelId: string; streamId: string; seq: number; content: string }
  | { kind: 'complete'; channelId: string; streamId: string; content: string; cancelled: boolean };

function sink(opted = new Set(['voice']), fallback: string | null = 'voice') {
  const sent: Sent[] = [];
  const ref = (channelId: string): ChannelRef | null => (opted.has(channelId) ? { serverId: 'bosun', channelId } : null);
  const s: SpeculativeStreamSink = {
    target: ({ channelId }) => ref(channelId),
    defaultTarget: () => (fallback ? ref(fallback) : null),
    chunk: (to, streamId, seq, content) => { sent.push({ kind: 'chunk', channelId: to.channelId, streamId, seq, content }); },
    complete: (to, streamId, content, cancelled) => { sent.push({ kind: 'complete', channelId: to.channelId, streamId, content, cancelled }); },
  };
  return { sent, sink: s };
}

const publishCall = (id: string, input: Record<string, unknown>) => ({ id, name: 'channel_publish', input });
const voice: ChannelRef = { serverId: 'bosun', channelId: 'voice' };

test('streams: channelId first, each delta goes out at once; a delivered publish completes with the full text', () => {
  const { sent, sink: s } = sink();
  const streams = new SpeculativePublishStreams(s);
  for (const f of ['{"channelId":"voi', 'ce","content":"Hel', 'lo. ', 'Bye."}']) streams.onInputDelta('t1', 'channel_publish', f);
  assert.deepEqual(sent, [
    { kind: 'chunk', channelId: 'voice', streamId: 'spec_t1', seq: 0, content: 'Hel' },
    { kind: 'chunk', channelId: 'voice', streamId: 'spec_t1', seq: 1, content: 'lo. ' },
    { kind: 'chunk', channelId: 'voice', streamId: 'spec_t1', seq: 2, content: 'Bye.' },
  ]);
  streams.onToolCalls([publishCall('t1', { channelId: 'voice', content: 'Hello. Bye.' })]);
  assert.equal(streams.dispatch('t1')?.streamId, 'spec_t1');
  streams.published('t1', { delivered: true, destination: voice });
  assert.deepEqual(sent.at(-1), { kind: 'complete', channelId: 'voice', streamId: 'spec_t1', content: 'Hello. Bye.', cancelled: false });
  assert.equal(streams.size, 0);
});

test('streams: content before channelId is held, then sent at once when the channel is read', () => {
  const { sent, sink: s } = sink();
  const streams = new SpeculativePublishStreams(s);
  streams.onInputDelta('t1', 'channel_publish', '{"content":"Early ');
  streams.onInputDelta('t1', 'channel_publish', 'words.",');
  assert.deepEqual(sent, []);
  streams.onInputDelta('t1', 'channel_publish', '"channelId":"voice"}');
  assert.deepEqual(sent, [{ kind: 'chunk', channelId: 'voice', streamId: 'spec_t1', seq: 0, content: 'Early words.' }]);
});

test('streams: a call naming no channel streams to its default once the call is finished', () => {
  const { sent, sink: s } = sink();
  const streams = new SpeculativePublishStreams(s);
  streams.onInputDelta('t1', 'channel_publish', '{"content":"To the default."}');
  assert.deepEqual(sent, []);
  streams.onToolCalls([publishCall('t1', { content: 'To the default.' })]);
  assert.deepEqual(sent, [{ kind: 'chunk', channelId: 'voice', streamId: 'spec_t1', seq: 0, content: 'To the default.' }]);
  assert.equal(streams.dispatch('t1')?.streamId, 'spec_t1');
  streams.published('t1', { delivered: true, destination: voice });
  assert.equal(sent.length, 2);
});

test('streams: a channel that did not opt in, and other tools, get nothing', () => {
  const { sent, sink: s } = sink();
  const streams = new SpeculativePublishStreams(s);
  streams.onInputDelta('t1', 'channel_publish', '{"channelId":"text-chat","content":"Not spoken."}');
  streams.onInputDelta('t2', 'send_message', '{"channelId":"voice","content":"Other tool."}');
  streams.onInputDelta('t3', 'channel_publish', '{"content":"No default."}');
  streams.onToolCalls([publishCall('t1', { channelId: 'text-chat', content: 'Not spoken.' })]);
  assert.equal(streams.dispatch('t1'), undefined);
  streams.published('t1', { delivered: true, destination: { serverId: 'bosun', channelId: 'text-chat' } });
  assert.deepEqual(sent, []);

  const none = sink(new Set(['voice']), null);
  const s2 = new SpeculativePublishStreams(none.sink);
  s2.onInputDelta('t3', 'channel_publish', '{"content":"No default."}');
  s2.onToolCalls([publishCall('t3', { content: 'No default.' })]);
  assert.deepEqual(none.sent, []);
  assert.equal(s2.size, 0);
});

test('streams: a name two channels share waits for serverId, however the fragments fall', () => {
  const json = '{"channelId":"shared","serverId":"bosun","content":"Hello there."}';
  for (let cut = 1; cut < json.length; cut++) {
    const sent: Sent[] = [];
    const streams = new SpeculativePublishStreams({
      target: ({ channelId, serverId }) => (channelId === 'shared' && serverId === 'bosun' ? { serverId: 'bosun', channelId } : null),
      defaultTarget: () => null,
      chunk: (to, streamId, seq, content) => { sent.push({ kind: 'chunk', channelId: to.channelId, streamId, seq, content }); },
      complete: (to, streamId, content, c) => { sent.push({ kind: 'complete', channelId: to.channelId, streamId, content, cancelled: c }); },
    });
    streams.onInputDelta('t1', 'channel_publish', json.slice(0, cut));
    streams.onInputDelta('t1', 'channel_publish', json.slice(cut));
    assert.equal(sent.filter((e) => e.kind === 'chunk').map((e) => (e as { content: string }).content).join(''), 'Hello there.', `cut at ${cut}`);
  }
});

test('streams: a channel that changes after chunks went out cancels the stream', () => {
  const { sent, sink: s } = sink(new Set(['voice', 'voice2']));
  const streams = new SpeculativePublishStreams(s);
  streams.onInputDelta('t1', 'channel_publish', '{"channelId":"voice","content":"Spoken ');
  streams.onInputDelta('t1', 'channel_publish', 'already.","channelId":"voice2"}');
  assert.deepEqual(sent, [
    { kind: 'chunk', channelId: 'voice', streamId: 'spec_t1', seq: 0, content: 'Spoken ' },
    // The fragment that names another channel sends none of its text.
    { kind: 'complete', channelId: 'voice', streamId: 'spec_t1', content: '', cancelled: true },
  ]);
  streams.onToolCalls([publishCall('t1', { channelId: 'voice2', content: 'Spoken already.' })]);
  assert.equal(streams.dispatch('t1'), undefined, 'the publish carries no stream id');
  assert.equal(sent.length, 2);
});

const cancelled = (streamId = 'spec_t1') => ({ kind: 'complete', channelId: 'voice', streamId, content: '', cancelled: true });

test('streams: every way a call does not get published cancels its stream, exactly once', () => {
  const begin = () => {
    const h = sink();
    const streams = new SpeculativePublishStreams(h.sink);
    streams.onInputDelta('t1', 'channel_publish', '{"channelId":"voice","content":"Maybe');
    return { ...h, streams };
  };

  // Cut off: the round's calls don't include it (max_tokens, a dropped call).
  let h = begin();
  h.streams.onToolCalls([{ id: 'other', name: 'think', input: {} }]);
  assert.deepEqual(h.sent.at(-1), cancelled());

  // The inference ended (or a refusal retry restarted it) before the call finished.
  h = begin();
  assert.deepEqual(h.streams.cancelPending(), ['t1']);
  assert.deepEqual(h.sent.at(-1), cancelled());

  // The publish failed.
  h = begin();
  h.streams.onToolCalls([publishCall('t1', { channelId: 'voice', content: 'Maybe' })]);
  h.streams.dispatch('t1');
  h.streams.published('t1', { delivered: false });
  assert.deepEqual(h.sent.at(-1), cancelled());

  // Delivered, but somewhere else than where it streamed.
  h = begin();
  h.streams.onToolCalls([publishCall('t1', { channelId: 'voice', content: 'Maybe' })]);
  h.streams.dispatch('t1');
  h.streams.published('t1', { delivered: true, destination: { serverId: 'other', channelId: 'voice' } });
  assert.deepEqual(h.sent.at(-1), cancelled());

  // Refused before its publish (a result arrived some other way).
  h = begin();
  h.streams.onToolCalls([publishCall('t1', { channelId: 'voice', content: 'Maybe' })]);
  h.streams.settle('t1');
  assert.deepEqual(h.sent.at(-1), cancelled());

  // Arguments that stop being JSON: what went out is taken back, nothing more goes.
  h = begin();
  h.streams.onInputDelta('t1', 'channel_publish', ' so"} oops');
  h.streams.onInputDelta('t1', 'channel_publish', 'more');
  assert.deepEqual(h.sent.at(-1), cancelled());
  h.streams.onToolCalls([publishCall('t1', { channelId: 'voice', content: 'Maybe so' })]);
  assert.equal(h.streams.dispatch('t1'), undefined);

  // stop(): a publish under way too.
  h = begin();
  h.streams.onToolCalls([publishCall('t1', { channelId: 'voice', content: 'Maybe' })]);
  h.streams.dispatch('t1');
  assert.deepEqual(h.streams.cancelPending(), [], 'a publish under way ends its own stream');
  h.streams.cancelAll();
  assert.deepEqual(h.sent.at(-1), cancelled());
  h.streams.published('t1', { delivered: true, destination: voice });
  assert.equal(h.sent.filter((e) => e.kind === 'complete').length, 1, 'ended once');
});

test('streams: a sink that throws never reaches the caller', () => {
  const streams = new SpeculativePublishStreams({
    target: () => voice,
    defaultTarget: () => voice,
    chunk: () => { throw new Error('transport closed'); },
    complete: () => { throw new Error('transport closed'); },
  });
  streams.onInputDelta('t1', 'channel_publish', '{"channelId":"voice","content":"x"}');
  streams.onToolCalls([publishCall('t1', { channelId: 'voice', content: 'x' })]);
  streams.dispatch('t1');
  streams.published('t1', { delivered: true, destination: voice });
});

// ---------------------------------------------------------------------------
// ChannelRegistry: which channels take a stream, and the wire shape
// ---------------------------------------------------------------------------

function streamingRegistry() {
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const publishes: Array<Record<string, unknown>> = [];
  const server = {
    grant: new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS), []),
    sendChannelsOutgoingSpeculativeChunk: (params: Record<string, unknown>) => { notifications.push({ method: 'channels/outgoing/chunk', params }); },
    sendChannelsOutgoingSpeculativeComplete: (params: Record<string, unknown>) => { notifications.push({ method: 'channels/outgoing/complete', params }); },
    sendChannelsPublish: async (params: Record<string, unknown>) => { publishes.push(params); return { delivered: true }; },
    sendChannelsOpen: async () => ({}),
    sendChannelsClose: async () => ({}),
  };
  const registry = new ChannelRegistry(
    { getServer: (id: string) => (id === 'bosun' || id === 'chat' ? server : null) } as unknown as McplServerRegistry,
    {} as FeatureSetManager, () => {}, () => {},
  );
  const register = (serverId: string, id: string, extra: Record<string, unknown> = {}) =>
    registry.handleChanged(serverId, { added: [{ id, type: 'chat', label: id, ...extra }] } as never);
  return { registry, server, notifications, publishes, register };
}

const SPECULATIVE = { capabilities: { streaming: { speculative: true } } };

test('registry: only a channel that opted in, not inbound-only, on a server granted channels.streaming, takes a stream', async () => {
  const h = streamingRegistry();
  await h.register('bosun', 'bosun:meeting:1', SPECULATIVE);
  await h.register('bosun', 'bosun:plain');
  await h.register('bosun', 'bosun:ears', { ...SPECULATIVE, direction: 'inbound' });
  await h.register('bosun', 'shared', SPECULATIVE);
  await h.register('chat', 'shared', SPECULATIVE);

  assert.deepEqual(h.registry.speculativeTarget({ channelId: 'bosun:meeting:1' }), { serverId: 'bosun', channelId: 'bosun:meeting:1' });
  assert.equal(h.registry.speculativeTarget({ channelId: 'bosun:plain' }), null);
  assert.equal(h.registry.speculativeTarget({ channelId: 'bosun:ears' }), null);
  assert.equal(h.registry.speculativeTarget({ channelId: 'shared' }), null, 'a name two channels answer to picks none');
  assert.deepEqual(h.registry.speculativeTarget({ channelId: 'shared', serverId: 'chat' }), { serverId: 'chat', channelId: 'shared' });
  assert.equal(h.registry.speculativeTarget({ channelId: 'nowhere' }), null);

  // A name the turn's own channel answers to means that channel, as the publish reads it.
  const chat = { serverId: 'chat', channelId: 'shared' };
  assert.deepEqual(h.registry.speculativeTarget({ channelId: 'shared' }, [chat]), chat);
  await h.register('chat', 'only-plain-on-chat');
  await h.register('bosun', 'only-plain-on-chat', SPECULATIVE);
  assert.equal(h.registry.speculativeTarget({ channelId: 'only-plain-on-chat' }, [{ serverId: 'chat', channelId: 'only-plain-on-chat' }]), null,
    "the turn's own channel didn't opt in, though another server's channel with its id did");

  h.server.grant = new CapabilityGrant(new Set(ALL_CAPABILITY_PATHS.filter((p) => p !== 'channels.streaming')), []);
  assert.equal(h.registry.speculativeTarget({ channelId: 'bosun:meeting:1' }), null);
});

test('registry: chunk and complete params are the contract, and the publish carries the stream id', async () => {
  const h = streamingRegistry();
  await h.register('bosun', 'bosun:meeting:1', SPECULATIVE);
  const to = { serverId: 'bosun', channelId: 'bosun:meeting:1' };
  h.registry.sendSpeculativeChunk(to, 'Glassy', 'spec_t1', 0, 'Hello');
  h.registry.sendSpeculativeComplete(to, 'Glassy', 'spec_t1', 'Hello.', false);
  h.registry.sendSpeculativeComplete(to, 'Glassy', 'spec_t2', '', true);
  assert.deepEqual(h.notifications, [
    { method: 'channels/outgoing/chunk', params: { channelId: 'bosun:meeting:1', streamId: 'spec_t1', seq: 0, content: 'Hello', speculative: true, conversationId: 'Glassy' } },
    { method: 'channels/outgoing/complete', params: { channelId: 'bosun:meeting:1', streamId: 'spec_t1', content: 'Hello.', speculative: true, conversationId: 'Glassy' } },
    { method: 'channels/outgoing/complete', params: { channelId: 'bosun:meeting:1', streamId: 'spec_t2', content: '', speculative: true, cancelled: true, conversationId: 'Glassy' } },
  ]);

  await h.registry.handleChannelToolCall('channel_publish', { channelId: 'bosun:meeting:1', content: 'Hello.' },
    { kind: 'agent', agentName: 'Glassy', speculativeStream: { streamId: 'spec_t1', channel: to } });
  await h.registry.handleChannelToolCall('channel_publish', { channelId: 'bosun:meeting:1', content: 'Plain.' },
    { kind: 'agent', agentName: 'Glassy' });
  assert.equal(h.publishes[0]!.streamId, 'spec_t1');
  assert.equal('streamId' in h.publishes[1]!, false);
  // A publish that lands elsewhere than its stream's channel carries no stream id.
  await h.register('bosun', 'bosun:plain');
  await h.registry.handleChannelToolCall('channel_publish', { channelId: 'bosun:plain', content: 'Elsewhere.' },
    { kind: 'agent', agentName: 'Glassy', speculativeStream: { streamId: 'spec_t4', channel: to } });
  assert.equal('streamId' in h.publishes[2]!, false);

  // A channel that didn't opt in gets no chunk, even when asked.
  h.registry.sendSpeculativeChunk({ serverId: 'bosun', channelId: 'bosun:plain' }, 'Glassy', 'spec_t3', 0, 'x');
  assert.equal(h.notifications.length, 3);
});

// ---------------------------------------------------------------------------
// The framework, end to end with a scripted stream
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const text = (value: string): ContentBlock => ({ type: 'text', text: value });
const call = (id: string, name: string, input: Record<string, unknown> = {}): ContentBlock =>
  ({ type: 'tool_use', id, name, input }) as ContentBlock;
const round = (...blocks: ContentBlock[]) => createMockResponse(blocks, 'tool_use');
const final = (...blocks: ContentBlock[]) => createMockResponse(blocks);

/**
 * Each stream takes the next script. Before a tool-calls event, each call's
 * argument fragments (by call id) come as tool-input tokens; `cutOff` ones
 * come before the stream's end, for a call that never finishes.
 */
class ScriptMembrane {
  options: YieldingStreamOptions[] = [];
  constructor(
    readonly scripts: NormalizedResponse[][],
    readonly fragments: Record<string, string[]>,
    readonly cutOff: Record<string, string[]> = {},
  ) {}
  streamYielding(_request: NormalizedRequest, options: YieldingStreamOptions = {}) {
    this.options.push(options);
    const script = this.scripts.shift();
    assert.ok(script, 'unexpected extra inference');
    const stream = new MockYieldingStream(script);
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    const { fragments, cutOff } = this;
    const deltas = (id: string, name: string, list: string[]) => list.map((content) => ({
      type: 'tokens', content,
      meta: { type: 'tool_call', visible: false, blockIndex: 1, toolCallPart: 'input', toolId: id, toolName: name },
    }) as unknown as StreamEvent);
    async function* wrapped(): AsyncGenerator<StreamEvent> {
      const it = { [Symbol.asyncIterator]: iterate };
      for await (const event of it as AsyncIterable<StreamEvent>) {
        if (event.type === 'tool-calls') {
          for (const c of event.calls) yield* deltas(c.id, c.name, fragments[c.id] ?? []);
        }
        if (event.type === 'complete') {
          for (const [id, list] of Object.entries(cutOff)) yield* deltas(id, 'channel_publish', list);
        }
        yield event;
      }
    }
    (stream as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<StreamEvent> })[Symbol.asyncIterator] = () => wrapped();
    return stream;
  }
  asMembrane() { return this as unknown as Membrane; }
}

/** Turns the test's message into the turn's request. */
class WakeModule implements Module {
  readonly name = 'test';
  async start(_ctx: ModuleContext) {}
  async stop() {}
  getTools() { return []; }
  async handleToolCall() { return { success: true }; }
  async onProcess(event: ProcessEvent, _state: ProcessState) {
    return event.type === 'external-message'
      ? { addMessages: [{ participant: 'user', content: [{ type: 'text' as const, text: String(event.content) }] }], requestInference: true }
      : {};
  }
}

const CHANNEL_PUBLISH_TOOL = {
  name: 'channel_publish', description: 'Publish',
  inputSchema: { type: 'object' as const, properties: { channelId: { type: 'string' }, content: { type: 'string' } } },
};

async function harness(membrane: ScriptMembrane, config: Partial<AgentConfig> = {}, opted = new Set(['bosun:meeting:1'])) {
  const dir = mkdtempSync(join(tmpdir(), 'af-speculative-')); dirs.push(dir);
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
    agents: [{ name: 'Glassy', model: 'test', systemPrompt: 'system', proseRouting: 'disabled', ...config }], modules: [new WakeModule()], syncIntervalMs: 0,
  });
  const log: Array<Record<string, unknown>> = [];
  const failing = new Set<string>();
  const ref = (channelId: string) => ({ serverId: 'bosun', channelId });
  const target: Record<string, unknown> = {
    resolveLocus: () => ref('bosun:meeting:1'),
    speculativeTarget: ({ channelId }: { channelId: string }) => (opted.has(channelId) ? ref(channelId) : null),
    sendSpeculativeChunk: (to: ChannelRef, conversationId: string, streamId: string, seq: number, content: string) =>
      log.push({ kind: 'chunk', channelId: to.channelId, conversationId, streamId, seq, content }),
    sendSpeculativeComplete: (to: ChannelRef, conversationId: string, streamId: string, content: string, cancelled: boolean) =>
      log.push({ kind: 'complete', channelId: to.channelId, conversationId, streamId, content, ...(cancelled ? { cancelled } : {}) }),
    handleChannelToolCall: async (name: string, input: { channelId?: string; content?: string }, origin: { speculativeStream?: { streamId: string } },
      published: { outcome?: unknown }) => {
      if (name !== 'channel_publish') return { success: true, data: {} };
      log.push({ kind: 'publish', channelId: input.channelId, content: input.content, ...(origin.speculativeStream ? { streamId: origin.speculativeStream.streamId } : {}) });
      const fails = failing.has(input.content ?? '');
      published.outcome = fails
        ? { status: 'failed', destination: ref(input.channelId!), reason: 'the stub reported delivered: false', at: Date.now() }
        : { status: 'delivered', destination: ref(input.channelId!), at: Date.now() };
      return fails ? { success: false, error: 'not delivered', isError: true } : { success: true, data: { delivered: true } };
    },
    getChannelTools: () => [CHANNEL_PUBLISH_TOOL],
    getDescriptor: () => undefined,
    isChannelOpen: () => true,
    getDefaultPublishChannel: () => null,
    channelsNamed: (name: string) => [ref(name)],
    nameShown: (channel: { channelId: string }) => channel.channelId,
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(target, {
    get: (t, key: string) => (key in t ? t[key] : () => undefined),
  });
  const run = async () => {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: {} });
    await framework.runUntilIdle();
  };
  return { framework, log, failing, run };
}

test('framework: off by default; no tool-input deltas are asked for and nothing streams', async () => {
  const membrane = new ScriptMembrane(
    [[round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', content: 'Hi.' })), final(text('done'))]],
    { p1: ['{"channelId":"bosun:meeting:1","content":"Hi."}'] },
  );
  const h = await harness(membrane);
  try {
    await h.run();
    assert.equal((membrane.options[0] as { emitToolInputDeltas?: boolean }).emitToolInputDeltas, undefined);
    assert.deepEqual(h.log, [{ kind: 'publish', channelId: 'bosun:meeting:1', content: 'Hi.' }]);
  } finally { await h.framework.stop(); }
});

test('framework: on, the text streams ahead of the publish, which carries the stream id and completes it', async () => {
  const membrane = new ScriptMembrane(
    [[
      round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', content: 'Good question.\nThe answer is yes.' })),
      round(call('p2', 'channel_publish', { channelId: 'text-chat', content: 'Not spoken.' })),
      final(text('done')),
    ]],
    {
      p1: ['{"channelId": "bosun:meet', 'ing:1", "content": "Good ques', 'tion.\\nThe answer', ' is yes."}'],
      p2: ['{"channelId":"text-chat","content":"Not spoken."}'],
    },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  try {
    await h.run();
    assert.equal((membrane.options[0] as { emitToolInputDeltas?: boolean }).emitToolInputDeltas, true);
    const streamId = 'spec_p1';
    assert.deepEqual(h.log, [
      { kind: 'chunk', channelId: 'bosun:meeting:1', conversationId: 'Glassy', streamId, seq: 0, content: 'Good ques' },
      { kind: 'chunk', channelId: 'bosun:meeting:1', conversationId: 'Glassy', streamId, seq: 1, content: 'tion.\nThe answer' },
      { kind: 'chunk', channelId: 'bosun:meeting:1', conversationId: 'Glassy', streamId, seq: 2, content: ' is yes.' },
      { kind: 'publish', channelId: 'bosun:meeting:1', content: 'Good question.\nThe answer is yes.', streamId },
      { kind: 'complete', channelId: 'bosun:meeting:1', conversationId: 'Glassy', streamId, content: 'Good question.\nThe answer is yes.' },
      // A channel that didn't opt in: as before.
      { kind: 'publish', channelId: 'text-chat', content: 'Not spoken.' },
    ]);
  } finally { await h.framework.stop(); }
});

test('framework: a failed publish and a call cut off before it finished are cancelled', async () => {
  const membrane = new ScriptMembrane(
    [[
      round(call('p1', 'channel_publish', { channelId: 'bosun:meeting:1', content: 'Will fail.' })),
      final(text('done')),
    ]],
    { p1: ['{"channelId":"bosun:meeting:1","content":"Will ', 'fail."}'] },
    { cut: ['{"channelId":"bosun:meeting:1","content":"Never fin'] },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  h.failing.add('Will fail.');
  try {
    await h.run();
    const ends = h.log.filter((e) => e.kind === 'complete');
    assert.deepEqual(ends, [
      { kind: 'complete', channelId: 'bosun:meeting:1', conversationId: 'Glassy', streamId: 'spec_p1', content: '', cancelled: true },
      { kind: 'complete', channelId: 'bosun:meeting:1', conversationId: 'Glassy', streamId: 'spec_cut', content: '', cancelled: true },
    ]);
    assert.deepEqual(h.log.filter((e) => e.kind === 'chunk' && e.streamId === 'spec_cut').map((e) => e.content), ['Never fin']);
  } finally { await h.framework.stop(); }
});

test('framework: a call naming no channel streams to the turn default once it is finished', async () => {
  const membrane = new ScriptMembrane(
    [[round(call('p1', 'channel_publish', { content: 'Default channel.' })), final(text('done'))]],
    { p1: ['{"content":"Default ', 'channel."}'] },
  );
  const h = await harness(membrane, { speculativeChannelChunks: true });
  try {
    await h.run();
    assert.deepEqual(h.log.map((e) => [e.kind, e.content]), [
      ['chunk', 'Default channel.'],
      ['publish', 'Default channel.'],
      ['complete', 'Default channel.'],
    ]);
    assert.equal(h.log[1]!.streamId, 'spec_p1');
  } finally { await h.framework.stop(); }
});
