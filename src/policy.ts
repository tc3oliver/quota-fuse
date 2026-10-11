import { attestedUntil, utcDay, type Config, type Group } from './config.ts';
import { Ledger } from './ledger.ts';

export class Denial extends Error {
  readonly status: number; readonly code: string; readonly group?: Group;
  constructor(status: number, code: string, message: string, group?: Group) { super(message); this.status = status; this.code = code; this.group = group; }
}
export function gate(config: Config, ledger: Ledger, now = new Date()): void {
  const p = config.policy;
  if ((!config.quotas.premium.models.length && !config.quotas.economy.models.length) || !attestedUntil(p.eligibilityAttestedUntil, now) || !attestedUntil(p.exclusiveOrgTrafficAttestedUntil, now) ||
      !attestedUntil(p.manualCostsAuditedUntil, now) || !process.env.OPENAI_API_KEY || !process.env.QG_PROXY_TOKEN || ledger.isPaused() ||
      !p.preflightCostVerified || p.inputCounter !== 'responses_preflight' || ledger.hasCrossDayUnknown(utcDay(now))) {
    throw new Denial(503, 'FREE_QUOTA_UNVERIFIED', 'Production safety gates are not verified');
  }
  for (const group of ['premium', 'economy'] as const) {
    const obs = ledger.snapshot(config, utcDay(now), group, now);
    if (obs.confidence === 'UNVERIFIED') throw new Denial(503, 'FREE_QUOTA_UNVERIFIED', 'Official usage collector unhealthy', group);
  }
}
export function classify(config: Config, model: unknown): Group {
  if (typeof model !== 'string') throw new Denial(403, 'MODEL_NOT_ELIGIBLE', 'Exact model ID required');
  for (const group of ['premium', 'economy'] as const) if (config.quotas[group].models.includes(model)) return group;
  throw new Denial(403, 'MODEL_NOT_ELIGIBLE', 'Model is not manually approved');
}

type JsonObject = Record<string, unknown>;
export interface ApprovedRequest {
  body: JsonObject;
  preflight: JsonObject;
  group: Group;
  maxOutput: number;
  chat: boolean;
  includeUsage: boolean;
}
function obj(v: unknown): v is JsonObject { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function fail(message: string): never { throw new Denial(403, 'PAID_FEATURE_BLOCKED', message); }
function only(o: JsonObject, keys: readonly string[], what: string): void {
  for (const key of Object.keys(o)) if (!keys.includes(key)) fail('Unsupported ' + what + ' field: ' + key);
}
function name(v: unknown): v is string { return typeof v === 'string' && /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(v); }
function string(v: unknown, max = 1048576): v is string { return typeof v === 'string' && Buffer.byteLength(v) <= max; }
function audited(config: Config, field: 'localFunctionBillingVerifiedUntil' | 'structuredTextBillingVerifiedUntil'): void {
  if (!attestedUntil(config.policy[field] ?? null, new Date()))
    throw new Denial(503, 'FREE_QUOTA_UNVERIFIED', field + ' requires independently reviewed billing eligibility');
}
function schema(value: unknown, label: string): JsonObject {
  if (!obj(value)) fail(label + ' must be a JSON Schema object');
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > 32768) fail(label + ' exceeds 32 KiB');
  let nodes = 0;
  const visit = (v: unknown, depth: number): void => {
    if (depth > 16 || ++nodes > 4096) fail(label + ' exceeds schema complexity limits');
    if (Array.isArray(v)) { for (const part of v) visit(part, depth + 1); return; }
    if (obj(v)) {
      for (const [k, part] of Object.entries(v)) {
        if (k === '$ref' && (typeof part !== 'string' || !part.startsWith('#/')))
          fail('Only local JSON Schema references are accepted');
        visit(part, depth + 1);
      }
    }
  };
  visit(value, 0);
  return value;
}
function checkTextFormat(format: unknown): JsonObject {
  if (!obj(format)) fail('text.format must be an object');
  if (format.type === 'text' || format.type === 'json_object') {
    only(format, ['type'], 'text.format');
    return format;
  }
  if (format.type === 'json_schema') {
    only(format, ['type', 'name', 'description', 'schema', 'strict'], 'text.format');
    if (!name(format.name) || !string(format.description ?? '', 2048) ||
      (format.strict !== undefined && typeof format.strict !== 'boolean')) fail('Invalid JSON Schema format');
    schema(format.schema, 'text.format.schema');
    return format;
  }
  return fail('Only text, json_object and json_schema output formats are supported');
}
function textFromMessage(item: JsonObject): JsonObject {
  only(item, ['type', 'role', 'content'], 'message');
  if (item.type !== undefined && item.type !== 'message') fail('Unsupported message type');
  if (!['user','assistant','system','developer'].includes(item.role as string)) fail('Invalid message role');
  if (string(item.content)) return { role: item.role, content: item.content };
  if (!Array.isArray(item.content) || !item.content.length || item.content.length > 128)
    fail('Only non-empty text message content is allowed');
  const parts: JsonObject[] = [];
  for (const part of item.content) {
    if (!obj(part)) fail('Message content part must be an object');
    only(part, ['type','text'], 'text part');
    if ((part.type !== 'input_text' && part.type !== 'output_text') || !string(part.text))
      fail('Multimodal and non-text parts are blocked');
    parts.push(part);
  }
  return { role: item.role, content: parts };
}
function history(input: unknown): { input: unknown; hasFunctions: boolean } {
  if (typeof input === 'string' && input.length > 0) return { input, hasFunctions: false };
  if (!Array.isArray(input) || !input.length || input.length > 128) fail('Expected bounded text-only message history');
  const calls = new Set<string>(), results = new Set<string>();
  const converted: JsonObject[] = [];
  let hasFunctions = false;
  for (const item of input) {
    if (!obj(item)) fail('Input history items must be objects');
    if (item.type === 'function_call') {
      only(item, ['type','id','name','call_id','arguments','status'], 'function_call');
      if (!name(item.name) || !string(item.call_id, 128) || !(item.call_id as string).length ||
          !string(item.arguments) || (item.id !== undefined && !string(item.id, 128)) ||
          (item.status !== undefined && item.status !== 'completed') || calls.has(item.call_id as string))
        fail('Invalid or duplicate function_call');
      calls.add(item.call_id as string); hasFunctions = true;
      converted.push(item);
    } else if (item.type === 'function_call_output') {
      only(item, ['type','call_id','output'], 'function_call_output');
      if (!string(item.call_id, 128) || !calls.has(item.call_id) || results.has(item.call_id) || !string(item.output))
        fail('Unmatched or invalid function_call_output');
      results.add(item.call_id); hasFunctions = true;
      converted.push(item);
    } else {
      converted.push(textFromMessage(item));
    }
  }
  return { input: converted, hasFunctions };
}
function functionTools(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) fail('Expected 1 to 32 local function declarations');
  const names = new Set<string>();
  return value.map(v => {
    if (!obj(v)) fail('Tool declaration must be an object');
    only(v, ['type','name','description','parameters','strict'], 'tool');
    if (v.type !== 'function' || !name(v.name) || names.has(v.name) || !string(v.description ?? '', 4096) ||
       (v.strict !== undefined && typeof v.strict !== 'boolean'))
      fail('Only unique client-executed function tools are allowed');
    names.add(v.name);
    if (v.parameters !== undefined) schema(v.parameters, 'tool.parameters');
    return v;
  });
}
function functionChoice(choice: unknown, names: Set<string>): unknown {
  if (choice === undefined) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (obj(choice)) {
    only(choice, ['type','name'], 'tool_choice');
    if (choice.type === 'function' && typeof choice.name === 'string' && names.has(choice.name)) return choice;
  }
  return fail('Invalid or unsupported tool_choice');
}
function chatInput(raw: JsonObject): { input: unknown; tools?: JsonObject[]; choice?: unknown; output?: JsonObject; includeUsage: boolean } {
  only(raw, ['model','messages','max_completion_tokens','max_tokens','stream','stream_options','n','store','tools','tool_choice','parallel_tool_calls','response_format'], 'chat request');
  if (raw.n !== undefined && raw.n !== 1) fail('Only n=1 is supported');
  if (!Array.isArray(raw.messages) || !raw.messages.length || raw.messages.length > 128) fail('Expected bounded chat messages');
  const items: JsonObject[] = [];
  for (const message of raw.messages) {
    if (!obj(message)) fail('Chat message must be an object');
    if (message.role === 'tool') {
      only(message, ['role','tool_call_id','content'], 'tool reply');
      if (!string(message.tool_call_id, 128) || !string(message.content))
        fail('Invalid tool reply');
      items.push({ type:'function_call_output', call_id:message.tool_call_id, output:message.content });
    } else if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      only(message, ['role','content','tool_calls'], 'assistant tool message');
      if (message.content !== null && message.content !== undefined && !string(message.content)) fail('Invalid assistant content');
      if (message.content) items.push({ role:'assistant', content:message.content });
      for (const call of message.tool_calls) {
        if (!obj(call) || call.type !== 'function' || !obj(call.function) ||
          !string(call.id, 128) || !name(call.function.name) || !string(call.function.arguments)) fail('Invalid chat function call');
        only(call, ['id','type','function'], 'chat tool call');
        only(call.function, ['name','arguments'], 'chat tool function');
        items.push({ type:'function_call', call_id:call.id, name:call.function.name, arguments:call.function.arguments });
      }
    } else {
      only(message, ['role','content'], 'chat message');
      if (!['user','assistant','system','developer'].includes(message.role as string) || !string(message.content))
        fail('Only text Chat messages are supported');
      items.push({role:message.role, content:message.content});
    }
  }
  let tools: JsonObject[] | undefined;
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) fail('Invalid chat tools');
    tools = raw.tools.map(t => {
      if (!obj(t) || t.type !== 'function' || !obj(t.function)) fail('Only local function tools are supported');
      only(t, ['type','function'], 'chat tool');
      return { type:'function', ...t.function };
    });
  }
  let choice: unknown = raw.tool_choice;
  if (obj(choice) && choice.type === 'function' && obj(choice.function)) {
    only(choice, ['type','function'], 'chat tool choice');
    only(choice.function, ['name'], 'chat tool choice function');
    choice = { type:'function', name:choice.function.name };
  }
  let output: JsonObject | undefined;
  if (raw.response_format !== undefined) {
    if (!obj(raw.response_format)) fail('Invalid chat response_format');
    if (raw.response_format.type === 'json_schema' && obj(raw.response_format.json_schema)) {
      only(raw.response_format, ['type','json_schema'], 'response_format');
      output = { format: { type:'json_schema', ...raw.response_format.json_schema } };
    } else { only(raw.response_format, ['type'], 'response_format'); output = {format: raw.response_format}; }
  }
  if (raw.stream_options !== undefined) {
    if (!obj(raw.stream_options)) fail('Invalid stream_options');
    only(raw.stream_options, ['include_usage'], 'stream_options');
    if (typeof raw.stream_options.include_usage !== 'boolean' || raw.stream !== true) fail('Invalid stream_options.include_usage');
  }
  if (raw.max_tokens !== undefined && raw.max_completion_tokens !== undefined) fail('Only one max token cap may be set');
  return { input:items, tools, choice, output, includeUsage:raw.stream_options !== undefined && (raw.stream_options as JsonObject).include_usage === true };
}
export function validateRequest(config: Config, endpoint: string, raw: unknown): ApprovedRequest {
  if (!obj(raw)) throw new Denial(400, 'BAD_REQUEST', 'JSON object required');
  const group = classify(config, raw.model);
  const chat = endpoint === '/v1/chat/completions';
  let input: unknown = raw.input, tools: JsonObject[] | undefined, choice: unknown, output: JsonObject | undefined;
  let includeUsage = false;
  let maxOutput: unknown = raw.max_output_tokens;
  if (chat) {
    const data = chatInput(raw);
    input=data.input; tools=data.tools; choice=data.choice; output=data.output; includeUsage=data.includeUsage;
    maxOutput = raw.max_completion_tokens ?? raw.max_tokens;
  } else {
    only(raw, ['model','input','instructions','max_output_tokens','stream','store','tools','tool_choice','parallel_tool_calls','text'], 'Responses request');
    if (raw.instructions !== undefined && !string(raw.instructions)) fail('Only text instructions are supported');
    tools = raw.tools !== undefined ? functionTools(raw.tools) : undefined;
    choice = raw.tool_choice;
    output = raw.text !== undefined ? raw.text as JsonObject : undefined;
  }
  if (raw.store !== undefined && raw.store !== false) fail('Stored conversations are disabled');
  if (raw.stream !== undefined && typeof raw.stream !== 'boolean') throw new Denial(400,'BAD_REQUEST','stream must be boolean');
  if (!Number.isSafeInteger(maxOutput) || (maxOutput as number) < 1 || (maxOutput as number) > config.policy.maxOutputTokens)
    fail('Explicit bounded output token cap required');
  const checked = history(input);
  if (tools && chat) tools = functionTools(tools);
  if (choice !== undefined) {
    choice = functionChoice(choice, new Set((tools ?? []).map(t=>t.name as string)));
    if (!tools && choice !== 'none') fail('Tool choice requires local tools');
  }
  const usesFunctions = !!tools || checked.hasFunctions;
  if (usesFunctions) audited(config,'localFunctionBillingVerifiedUntil');
  if (raw.parallel_tool_calls !== undefined && (typeof raw.parallel_tool_calls !== 'boolean' || !tools))
    fail('parallel_tool_calls requires local function tools');
  if (output !== undefined) {
    if (!obj(output)) fail('Invalid text configuration');
    only(output, ['format'], 'text');
    const fmt=checkTextFormat(output.format);
    if (fmt.type !== 'text') audited(config,'structuredTextBillingVerifiedUntil');
  }
  const body: JsonObject = {model:raw.model, input:checked.input, max_output_tokens:maxOutput, store:false};
  if (!chat && raw.instructions !== undefined) body.instructions=raw.instructions;
  if (tools) body.tools=tools;
  if (choice !== undefined) body.tool_choice=choice;
  if (raw.parallel_tool_calls !== undefined) body.parallel_tool_calls=raw.parallel_tool_calls;
  if (output !== undefined) body.text=output;
  if (raw.stream !== undefined) body.stream=raw.stream;
  // These fields are the same between preflight and dispatch. No truncation,
  // previous_response_id, conversation, remote tool execution or hidden context.
  const preflight: JsonObject = {model:body.model, input:body.input};
  for (const key of ['instructions','tools','tool_choice','text']) if (body[key] !== undefined) preflight[key]=body[key];
  return {body, preflight, group, maxOutput:maxOutput as number, chat, includeUsage};
}
