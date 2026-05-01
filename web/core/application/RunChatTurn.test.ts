import { describe, expect, it } from 'vitest';
import { RunChatTurn } from './RunChatTurn.js';
import { AuthRequiredError, NotFoundError } from './errors.js';
import { FakeSessionStore } from './testing/fakeSessionStore.js';
import type {
  ChatAdapter,
  ChatTurnInput,
  ChatTurnResult,
  ToolSpec,
} from '../ports/ChatAdapter.js';
import type {
  ToolCall,
  ToolDispatcher,
  ToolOutcome,
} from '../ports/ToolDispatcher.js';

class FakeChatAdapter implements ChatAdapter {
  readonly inputs: ChatTurnInput[] = [];
  /**
   * Queue of fixed responses; each call to runTurn shifts one off. Lets a
   * single test express a multi-turn conversation deterministically.
   */
  constructor(private readonly responses: ChatTurnResult[]) {}
  async runTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
    this.inputs.push(input);
    return this.responses.shift() ?? { assistantText: '', toolCalls: [] };
  }
}

class FakeAgentSdkChat implements ChatAdapter {
  readonly inputs: ChatTurnInput[] = [];
  toolHook: (name: string, input: Record<string, unknown>) => Promise<void> = async () => {
    /* default: throw if hook not set by use case */
    throw new Error('toolHook not wired');
  };
  constructor(
    private readonly assistantText: string,
    /** The tool calls the SDK should "make" via toolHook before returning. */
    private readonly hookedCalls: ToolCall[] = [],
  ) {}
  async runTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
    this.inputs.push(input);
    for (const call of this.hookedCalls) await this.toolHook(call.name, call.input);
    return { assistantText: this.assistantText, toolCalls: [] };
  }
}

class FakeToolDispatcher implements ToolDispatcher {
  readonly applied: ToolCall[] = [];
  constructor(private readonly tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>) {}
  async apply(_sessionId: string, call: ToolCall): Promise<ToolOutcome> {
    this.applied.push(call);
    return { call, ok: true };
  }
  catalogue(): ToolSpec[] {
    return this.tools.map((t) => ({ ...t }));
  }
}

function seedSession() {
  const store = new FakeSessionStore();
  store.seed(
    {
      id: 'sid',
      dir: '/tmp/x',
      origName: 'x.fig',
      archiveVersion: 106,
      documentJson: { id: '0:0', guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT', children: [] },
    },
    '{}',
  );
  return store;
}

describe('RunChatTurn', () => {
  // Spec invariant I-1
  it('throws AuthRequiredError when api-key mode lacks an apiKey', async () => {
    const useCase = new RunChatTurn(seedSession(), new FakeToolDispatcher([]), {
      subscription: new FakeAgentSdkChat(''),
      apiKey: new FakeChatAdapter([]),
    });
    await expect(
      useCase.execute({
        sessionId: 'sid',
        messages: [{ role: 'user', content: 'hi' }],
        selectedGuid: null,
        model: 'claude-opus-4-6',
        authMode: 'api-key',
      }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });

  // I-2
  it('throws NotFoundError for a missing session', async () => {
    const useCase = new RunChatTurn(new FakeSessionStore(), new FakeToolDispatcher([]), {
      subscription: new FakeAgentSdkChat(''),
      apiKey: new FakeChatAdapter([]),
    });
    await expect(
      useCase.execute({
        sessionId: 'nope',
        messages: [{ role: 'user', content: 'hi' }],
        selectedGuid: null,
        model: 'claude-opus-4-6',
        authMode: 'subscription',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // I-5: api-key path threads tool calls through the dispatcher and surfaces
  // them in the actions list.
  it('api-key mode runs the agent loop, dispatches tool calls, returns actions', async () => {
    const store = seedSession();
    const dispatcher = new FakeToolDispatcher([
      { name: 'set_text', description: 't', inputSchema: { type: 'object' } },
    ]);
    // Turn 1: model returns one tool call.
    // Turn 2: model returns a final text and no tool calls — loop exits.
    const apiKeyAdapter = new FakeChatAdapter([
      {
        assistantText: 'going to edit',
        toolCalls: [{ name: 'set_text', input: { guid: '0:1', value: 'X' } }],
      },
      { assistantText: ' done.', toolCalls: [] },
    ]);
    const useCase = new RunChatTurn(store, dispatcher, {
      subscription: new FakeAgentSdkChat(''),
      apiKey: apiKeyAdapter,
    });

    const out = await useCase.execute({
      sessionId: 'sid',
      messages: [{ role: 'user', content: 'rename it' }],
      selectedGuid: null,
      model: 'claude-opus-4-6',
      authMode: 'api-key',
      apiKey: 'sk-ant-test',
    });

    // Two turns happened.
    expect(apiKeyAdapter.inputs).toHaveLength(2);
    // Tool got dispatched once.
    expect(dispatcher.applied).toEqual([{ name: 'set_text', input: { guid: '0:1', value: 'X' } }]);
    // assistantText is the concatenation of both turns.
    expect(out.assistantText).toBe('going to edit done.');
    expect(out.actions).toEqual([{ tool: 'set_text', input: { guid: '0:1', value: 'X' } }]);
  });

  // Subscription path: AgentSdkChat owns the loop — we only verify the use
  // case wired toolHook so SDK-side tool calls land in the dispatcher.
  it('subscription mode wires toolHook onto AgentSdkChat', async () => {
    const store = seedSession();
    const dispatcher = new FakeToolDispatcher([
      { name: 'set_position', description: 'm', inputSchema: { type: 'object' } },
    ]);
    const subAdapter = new FakeAgentSdkChat('moved.', [
      { name: 'set_position', input: { guid: '0:1', x: 10, y: 20 } },
    ]);
    const useCase = new RunChatTurn(store, dispatcher, {
      subscription: subAdapter,
      apiKey: new FakeChatAdapter([]),
    });

    const out = await useCase.execute({
      sessionId: 'sid',
      messages: [{ role: 'user', content: 'move it' }],
      selectedGuid: null,
      model: 'claude-opus-4-6',
      authMode: 'subscription',
    });

    expect(out.assistantText).toBe('moved.');
    expect(out.actions).toEqual([{ tool: 'set_position', input: { guid: '0:1', x: 10, y: 20 } }]);
    expect(dispatcher.applied).toEqual([{ name: 'set_position', input: { guid: '0:1', x: 10, y: 20 } }]);
  });
});
