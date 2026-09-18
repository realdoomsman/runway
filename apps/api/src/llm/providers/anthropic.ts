// Anthropic Messages API provider. SPEC §6; AMENDMENTS A1 (thinking blocks 1:1), A3 (stop details),
// A5 (usage → cost), A6 (request shape, caching, retries owned by the router).
import Anthropic from '@anthropic-ai/sdk';
import { LLM_REQUEST_TIMEOUT_MS, priceUsage, type ModelInfo, type StopReason } from '@runway/shared';
import type { LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmToolDef } from '../../core/interfaces.js';
import { errorMessage } from '../../lib/errors.js';
import { isRetryableStatus, LlmCallError } from '../errors.js';
import { requestTimeoutMs } from '../timeout.js';

// A6's ceiling: the per-request timeout is min(remaining step budget, this).
export const ANTHROPIC_REQUEST_TIMEOUT_MS = LLM_REQUEST_TIMEOUT_MS;
const BUDGET_THINKING_MIN = 1_024;
const BUDGET_THINKING_MAX = 16_000;

export type AnthropicParams = Anthropic.MessageCreateParamsNonStreaming;

export interface AnthropicProviderOpts { apiKey: string; client?: Anthropic }

export function createAnthropicProvider(opts: AnthropicProviderOpts): LlmProvider {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 });
  return {
    name: 'anthropic',
    async complete(req, model) {
      const params = buildAnthropicRequest(req, model);
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(params, { signal: req.signal, timeout: requestTimeoutMs(req.remainingMs) });
      } catch (e) {
        throw toCallError(e);
      }
      return mapAnthropicResponse(message, model);
    },
  };
}

export function buildAnthropicRequest(req: LlmRequest, model: ModelInfo): AnthropicParams {
  const params: AnthropicParams = {
    model: model.id,
    max_tokens: req.maxTokens,
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: req.messages.map(toMessageParam),
    cache_control: { type: 'ephemeral' },
  };
  if (req.tools.length > 0) {
    params.tools = [...req.tools].sort((a, b) => a.name.localeCompare(b.name)).map(toTool);
    if (req.toolChoice === 'none') params.tool_choice = { type: 'none' };
  }
  const thinking = thinkingParam(model, req.maxTokens);
  if (thinking) params.thinking = thinking;
  if (model.supportsEffort && req.effort) params.output_config = { effort: req.effort };
  return params;
}

function thinkingParam(model: ModelInfo, maxTokens: number): Anthropic.ThinkingConfigParam | null {
  if (model.thinking === 'adaptive') return { type: 'adaptive' };
  if (model.thinking === 'budget' && maxTokens > BUDGET_THINKING_MIN) {
    const budget = Math.min(BUDGET_THINKING_MAX, Math.max(BUDGET_THINKING_MIN, Math.floor(maxTokens / 2)));
    return { type: 'enabled', budget_tokens: budget };
  }
  return null;
}

function toTool(def: LlmToolDef): Anthropic.Tool {
  return {
    name: def.name,
    description: def.description,
    input_schema: { ...def.inputSchema, type: 'object' },
    strict: true,
  };
}

function toMessageParam(m: LlmMessage): Anthropic.MessageParam {
  return { role: m.role, content: m.content.map(toBlockParam) };
}

function toBlockParam(c: LlmContent): Anthropic.ContentBlockParam {
  switch (c.type) {
    case 'text': return { type: 'text', text: c.text };
    case 'tool_use': return { type: 'tool_use', id: c.id, name: c.name, input: c.input };
    case 'tool_result': return { type: 'tool_result', tool_use_id: c.toolUseId, content: c.content, ...(c.isError ? { is_error: true } : {}) };
    case 'thinking': return { type: 'thinking', thinking: c.thinking, signature: c.signature };
    case 'redacted_thinking': return { type: 'redacted_thinking', data: c.data };
  }
}

export function mapAnthropicResponse(message: Anthropic.Message, model: ModelInfo): LlmResponse {
  const content: LlmContent[] = [];
  for (const block of message.content) {
    switch (block.type) {
      case 'text': content.push({ type: 'text', text: block.text }); break;
      case 'tool_use': content.push({ type: 'tool_use', id: block.id, name: block.name, input: parseToolInput(block.input) }); break;
      case 'thinking': content.push({ type: 'thinking', thinking: block.thinking, signature: block.signature }); break;
      case 'redacted_thinking': content.push({ type: 'redacted_thinking', data: block.data }); break;
      default: break;   // server-tool blocks are never requested
    }
  }
  const tokens = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
  const res: LlmResponse = {
    content,
    stopReason: mapStopReason(message.stop_reason),
    usage: { ...tokens, costMicro: priceUsage(model, tokens) },
    model: message.model,
    raw: message,
  };
  if (message.stop_details) {
    res.stopDetails = {
      category: message.stop_details.category,
      ...(message.stop_details.explanation ? { explanation: message.stop_details.explanation } : {}),
    };
  }
  return res;
}

const STOP_REASONS: Record<Anthropic.StopReason, StopReason> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
  pause_turn: 'pause_turn',
  stop_sequence: 'stop_sequence',
  model_context_window_exceeded: 'max_tokens',
};

function mapStopReason(reason: Anthropic.StopReason | null): StopReason {
  return (reason && STOP_REASONS[reason]) ?? 'error';
}

// Tool inputs arrive parsed; a string body is parsed as JSON and left as-is when it is not JSON
// so the registry's validation reports it instead of a string match here (A6).
function parseToolInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function toCallError(e: unknown): LlmCallError {
  if (e instanceof Anthropic.APIUserAbortError) return new LlmCallError('anthropic', 'request aborted', { retryable: false, cause: e });
  if (e instanceof Anthropic.APIConnectionError) return new LlmCallError('anthropic', `network error: ${e.message}`, { retryable: true, cause: e });
  if (e instanceof Anthropic.APIError) {
    return new LlmCallError('anthropic', `HTTP ${e.status}: ${e.message}`, { status: e.status, retryable: isRetryableStatus(e.status), cause: e });
  }
  return new LlmCallError('anthropic', errorMessage(e), { retryable: false, cause: e });
}
