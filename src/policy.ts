import { attestedUntil, utcDay, unrestrictedModels, type Config, type Group } from './config.ts';
import { Ledger } from './ledger.ts';
import { groupForUnrestrictedModel } from './model-groups.ts';

export class Denial extends Error {
  readonly status: number; readonly code: string; readonly group?: Group;
  constructor(status: number, code: string, message: string, group?: Group) { super(message); this.status = status; this.code = code; this.group = group; }
}
export function gate(config: Config, ledger: Ledger, now = new Date()): void {
  const p = config.policy;
  // Shared-org design: production services may legally bypass the proxy and
  // share the org pool. exclusiveOrgTrafficAttestedUntil is therefore NOT a
  // gate (kept in config only for backward compatibility). External usage
  // tightens admission through effective_used instead of pausing collection.
  // The routing project itself, however, MUST be dedicated to QuotaFuse: the
  // max()-dedup is only sound when proxy-scope official usage can solely be
  // locally committed traffic. Without fresh dedication evidence, admission
  // fails closed rather than claiming safe dedup.
  if (/^proj_(SELECT|REPLACE|YOUR|EXAMPLE)/i.test(config.dataSharing.projectId) ||
      !attestedUntil(p.eligibilityAttestedUntil, now) ||
      !attestedUntil(p.proxyProjectDedicatedAttestedUntil ?? null, now) ||
      !attestedUntil(p.manualCostsAuditedUntil, now) || !process.env.OPENAI_API_KEY || !process.env.QG_PROXY_TOKEN || ledger.isPaused() ||
      !p.preflightCostVerified || p.inputCounter !== 'responses_preflight' || ledger.hasCrossDayUnknown(utcDay(now))) {
    throw new Denial(503, 'FREE_QUOTA_UNVERIFIED', 'Production safety gates are not verified');
  }
  for (const group of ['premium', 'economy'] as const) {
    const obs = ledger.snapshot(config, utcDay(now), group, now);
    if (obs.confidence === 'UNVERIFIED') throw new Denial(503, 'FREE_QUOTA_UNVERIFIED', 'Official usage collector unhealthy', group);
  }
}
/** Non-sensitive diagnostic codes for an authenticated local readiness check.
 * Independent of gate() so human guidance cannot accidentally grant admission. */
export function readinessIssues(config: Config, ledger: Ledger, now = new Date()): string[] {
  const p = config.policy;
  const issues: string[] = [];
  if (!process.env.OPENAI_API_KEY) issues.push('PROJECT_KEY_MISSING');
  if (!process.env.QG_PROXY_TOKEN) issues.push('PROXY_TOKEN_MISSING');
  if (/^proj_(?:SELECT|REPLACE|YOUR|EXAMPLE)/i.test(config.dataSharing.projectId))
    issues.push('ROUTING_PROJECT_UNSET');
  if (p.inputCounter !== 'responses_preflight') issues.push('PREFLIGHT_COUNTER_DISABLED');
  if (!p.preflightCostVerified) issues.push('PREFLIGHT_COST_UNVERIFIED');
  if (!attestedUntil(p.eligibilityAttestedUntil, now)) issues.push('ELIGIBILITY_ATTESTATION_MISSING');
  if (!attestedUntil(p.proxyProjectDedicatedAttestedUntil ?? null, now)) issues.push('PROXY_PROJECT_DEDICATION_UNVERIFIED');
  if (!attestedUntil(p.manualCostsAuditedUntil, now)) issues.push('COST_AUDIT_UNVERIFIED');
  try {
    const pause = ledger.pauseReason();
    if (pause) issues.push('COLLECTOR_PAUSED:' + (pause.match(/^[A-Z_]{1,60}$/) ? pause : 'UNKNOWN'));
    if (ledger.hasCrossDayUnknown(utcDay(now))) issues.push('PRIOR_DAY_UNKNOWN');
    for (const group of ['premium', 'economy'] as const) {
      try {
        const obs = ledger.snapshot(config, utcDay(now), group, now);
        if (obs.confidence === 'UNVERIFIED') issues.push('USAGE_BASELINE_UNVERIFIED:' + group.toUpperCase());
      } catch {
        issues.push('USAGE_BASELINE_UNVERIFIED:' + group.toUpperCase());
      }
    }
  } catch { issues.push('LEDGER_UNAVAILABLE'); }
  return issues;
}

export function classify(config: Config, model: unknown): Group {
  if (typeof model !== 'string' || model.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model))
    throw new Denial(403, 'MODEL_NOT_ELIGIBLE', 'Valid exact model ID required');
  // Empty whitelist accepts any exact model ID. Use the smaller Premium budget
  // when model group cannot be proven. This cannot guarantee free pricing.
  if (unrestrictedModels(config)) return config.dataSharing.modelGroupAccounting === 'official_v1' ? groupForUnrestrictedModel(model) : 'premium';
  for (const group of ['premium', 'economy'] as const) {
    if (config.quotas[group].models.includes(model)) {
      // In official_v1, configured lists authorize models but never assign
      // free-token groups. A misplaced Premium ID must not receive Economy capacity.
      return config.dataSharing.modelGroupAccounting === 'official_v1'
        ? groupForUnrestrictedModel(model) : group;
    }
  }
  throw new Denial(403, 'MODEL_NOT_ELIGIBLE', 'Model is outside the optional whitelist');
}

type ObjectValue = Record<string, unknown>;
const record = (v: unknown): v is ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v);
function fail(msg: string): never { throw new Denial(403, 'PAID_FEATURE_BLOCKED', msg); }
function keys(obj: ObjectValue, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) fail('Unsupported ' + where + ' parameter: ' + key);
}
function boundedText(v: unknown, what: string, allowEmpty = false): string {
  if (typeof v !== 'string' || (!allowEmpty && v.length === 0) || v.length > 1048576) fail('Invalid ' + what);
  return v as string;
}
const functionName = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(v);
function structuredTextAudited(config: Config, now: Date): void {
  if (config.policy.structuredTextVerified !== true ||
      !attestedUntil(config.policy.structuredTextAttestedUntil ?? null, now))
    throw new Denial(503, 'FREE_QUOTA_UNVERIFIED', 'Structured output billing has not been independently verified');
}
function schema(value: unknown, label: string): ObjectValue {
  if (!record(value) || value.type !== 'object') fail(label + ' requires an object JSON schema');
  const encoded = JSON.stringify(value);
  if (encoded.length > 32768) fail(label + ' schema too large');
  // Reject external references and deeply recursive schemas. Never fetch schema URLs.
  const visit=(node: unknown, depth=0): void => {
    if (depth>32) fail('Schema nesting too deep');
    if (Array.isArray(node)) for (const v of node) visit(v,depth+1);
    else if (record(node)) for (const [k,v] of Object.entries(node)) {
      if (k==='$ref' && (typeof v !== 'string' || !v.startsWith('#/'))) fail('External schema references prohibited');
      visit(v,depth+1);
    }
  };
  visit(value);
  return value as ObjectValue;
}
function textFormat(config: Config, v: unknown, now: Date): ObjectValue {
  if (!record(v)) fail('Invalid text format');
  keys(v, ['format'], 'text');
  if (!record(v.format)) fail('Missing text.format');
  const f = v.format;
  if (f.type === 'text') { keys(f, ['type'], 'text.format'); return {format:{type:'text'}}; }
  structuredTextAudited(config, now);
  if (f.type === 'json_object') { keys(f, ['type'], 'text.format'); return {format:{type:'json_object'}}; }
  if (f.type === 'json_schema') {
    keys(f, ['type','name','schema','strict','description'], 'text.format');
    if (!functionName(f.name) || f.strict !== true) fail('Strict named JSON schema required');
    schema(f.schema, 'structured output');
    if (f.description !== undefined) boundedText(f.description,'schema description',true);
    return {format: f};
  }
  return fail('Unsupported structured output format');
}
function validateFunctionTools(config: Config, input: unknown, now: Date): ObjectValue[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 16) fail('Expected 1-16 local functions');
  const names = new Set<string>();
  const validated = input.map((tool: unknown) => {
    if (!record(tool) || tool.type !== 'function') fail('Only client-side function tools permitted');
    keys(tool,['type','name','description','parameters','strict'],'function tool');
    if (!functionName(tool.name) || names.has(tool.name)) fail('Invalid or duplicate function name');
    names.add(tool.name);
    if (tool.description !== undefined) boundedText(tool.description,'function description',true);
    if (tool.strict !== undefined && typeof tool.strict !== 'boolean') fail('Invalid function strict setting');
    if (tool.parameters !== undefined) schema(tool.parameters, 'function parameters');
    return tool as ObjectValue;
  });
  // Client function declarations are regular model input; QuotaFuse does not execute them.
  return validated;
}
function validatedInput(config: Config, input: unknown, now: Date): unknown {
  if (typeof input === 'string') return boundedText(input,'input');
  if (!Array.isArray(input) || !input.length || input.length > 256) fail('Expected 1-256 text input items');
  const calls = new Set<string>();
  return input.map((item: unknown) => {
    if (!record(item)) fail('Input item must be an object');
    if (item.type === 'function_call' || item.type === 'function_call_output') {
      
      if (item.type === 'function_call') {
        keys(item,['type','name','call_id','arguments','id','status'],'function_call');
        if (!functionName(item.name) || typeof item.call_id !== 'string' || item.call_id.length > 256 || !item.call_id || calls.has(item.call_id)) fail('Invalid function_call');
        if (item.id !== undefined) boundedText(item.id, 'function_call ID');
        if (item.status !== undefined && item.status !== 'completed') fail('Only completed function calls accepted in history');
        boundedText(item.arguments,'function arguments',true);
        calls.add(item.call_id);
      } else {
        keys(item,['type','call_id','output'],'function_call_output');
        if (typeof item.call_id !== 'string' || !calls.has(item.call_id)) fail('Tool result does not match a preceding function call');
        boundedText(item.output,'function output',true);
        calls.delete(item.call_id);
      }
      return item;
    }
    if (item.type === 'reasoning') {
      
      keys(item,['type','id','encrypted_content','summary'],'reasoning');
      boundedText(item.id, 'reasoning id');
      boundedText(item.encrypted_content,'encrypted reasoning');
      if (item.summary !== undefined && (!Array.isArray(item.summary) || item.summary.length !== 0)) fail('Reasoning summary unsupported');
      return item;
    }
    keys(item,['role','content'],'message');
    if (!['user','assistant','system','developer'].includes(String(item.role))) fail('Unsupported message role');
    if (typeof item.content === 'string') boundedText(item.content,'message content',true);
    else if (Array.isArray(item.content) && item.content.length > 0 && item.content.length <= 64) {
      for (const c of item.content) {
        if (!record(c)) fail('Invalid content block');
        keys(c,['type','text'],'content block');
        if (!['input_text','output_text'].includes(String(c.type))) fail('Image, audio and other modalities unsupported');
        if (item.role === 'assistant' && c.type !== 'output_text') fail('Assistant content must use output_text');
        if (item.role !== 'assistant' && c.type !== 'input_text') fail('User/system content must use input_text');
        boundedText(c.text, 'content text',true);
      }
    } else fail('Only text content supported');
    return item;
  });
}
export interface ValidatedRequest {
  body: ObjectValue; group: Group; maxOutput: number; clientMode: 'responses'|'chat'; hasFunctions: boolean;
}
export function validateRequest(config: Config, endpoint: string, raw: unknown, now = new Date()): ValidatedRequest {
  if (!record(raw)) throw new Denial(400,'BAD_REQUEST','JSON object required');
  const group = classify(config,raw.model);
  const mode = endpoint === '/v1/chat/completions' ? 'chat' : 'responses';
  let req = raw;
  if (mode === 'chat') {
    keys(req,['model','messages','max_completion_tokens','stream','stream_options','store','n','tools','tool_choice','parallel_tool_calls','response_format'],'chat');
    if (req.n !== undefined && req.n !== 1) fail('Only n=1 supported');
    // Coding agents (e.g. OpenCode via @ai-sdk/openai-compatible) routinely send
    // store:false and stream_options:{include_usage:true}. Both are billing-neutral
    // here: stored responses stay disabled, and Chat SSE (including usage) is
    // generated by QuotaFuse itself, so the option is accepted and ignored.
    if (req.store !== undefined && req.store !== false) fail('Stored responses are disabled');
    if (req.stream_options !== undefined) {
      if (!record(req.stream_options)) fail('Invalid stream_options');
      keys(req.stream_options,['include_usage'],'stream_options');
      if (typeof req.stream_options.include_usage !== 'boolean') fail('Invalid stream_options');
    }
    if (!Array.isArray(req.messages) || !req.messages.length || req.messages.length > 256) fail('Invalid Chat messages');
    const mapped: ObjectValue[] = [];
    for (const msg of req.messages) {
      if (!record(msg)) fail('Invalid Chat message');
      if (msg.role === 'tool') {
        keys(msg,['role','tool_call_id','content'],'tool message');
        mapped.push({type:'function_call_output',call_id:msg.tool_call_id,output:msg.content});
      } else if (['user','assistant','system','developer'].includes(String(msg.role))) {
        keys(msg,['role','content','tool_calls'],'chat message');
        if (msg.content !== null && msg.content !== undefined) mapped.push({role:msg.role,content:msg.content});
        if (msg.tool_calls !== undefined) {
          if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls) || !msg.tool_calls.length || msg.tool_calls.length>16) fail('Invalid assistant tool calls');
          for (const call of msg.tool_calls) {
            if (!record(call) || call.type !== 'function' || !record(call.function)) fail('Invalid local tool call');
            keys(call,['id','type','function'],'chat tool call');
            keys(call.function,['name','arguments'],'chat function');
            mapped.push({type:'function_call',call_id:call.id,name:call.function.name,arguments:call.function.arguments});
          }
        }
      } else fail('Unsupported Chat role');
    }
    let convertedTools: ObjectValue[] | undefined;
    if (req.tools !== undefined) {
      if (!Array.isArray(req.tools)) fail('Chat tools must be an array');
      convertedTools = req.tools.map((t: unknown) => {
        if (!record(t) || t.type !== 'function' || !record(t.function)) fail('Only local Chat functions supported');
        keys(t,['type','function'],'chat tools');
        return {type:'function',...t.function};
      });
    }
    let choice = req.tool_choice;
    if (record(choice)) {
      if (choice.type !== 'function' || !record(choice.function)) fail('Unsupported Chat tool choice');
      keys(choice,['type','function'],'Chat tool choice');
      choice = {type:'function',name:choice.function.name};
    }
    let text: ObjectValue | undefined;
    if (req.response_format !== undefined) {
      if (!record(req.response_format)) fail('Invalid response_format');
      const f = req.response_format;
      if (f.type === 'json_schema') {
        keys(f,['type','json_schema'],'response_format');
        if (!record(f.json_schema)) fail('Invalid json_schema');
        text={format:{type:'json_schema',...f.json_schema}};
      } else { keys(f,['type'],'response_format'); text={format:f}; }
    }
    req = {
      model:req.model, input:mapped, max_output_tokens:req.max_completion_tokens, stream:req.stream,
      ...(convertedTools ? {tools:convertedTools} : {}),
      ...(choice!==undefined ? {tool_choice:choice} : {}),
      ...(req.parallel_tool_calls!==undefined ? {parallel_tool_calls:req.parallel_tool_calls} : {}),
      ...(text ? {text} : {})
    };
  } else keys(req,['model','input','instructions','max_output_tokens','stream','store','tools','tool_choice','parallel_tool_calls','text','include'],'Responses');
  const approved: ObjectValue = {model:req.model,input:validatedInput(config,req.input,now),max_output_tokens:req.max_output_tokens,store:false};
  if (req.instructions !== undefined) approved.instructions=boundedText(req.instructions,'instructions');
  if (req.stream !== undefined) {
    if (typeof req.stream !== 'boolean') throw new Denial(400,'BAD_REQUEST','stream must be boolean');
    approved.stream=req.stream;
  }
  if (req.store !== undefined && req.store !== false) fail('Stored responses are disabled');
  if (req.text !== undefined) approved.text=textFormat(config,req.text,now);
  if (req.include !== undefined) {
    
    if (!Array.isArray(req.include) || req.include.length !== 1 || req.include[0] !== 'reasoning.encrypted_content')
      fail('Only reasoning.encrypted_content include supported');
    approved.include=req.include;
  }
  let hasFunctions = false;
  if (req.tools !== undefined) { approved.tools=validateFunctionTools(config,req.tools,now); hasFunctions=true; }
  if (Array.isArray(approved.input) && approved.input.some((i: unknown)=>record(i) && ['function_call','function_call_output','reasoning'].includes(String(i.type)))) hasFunctions=true;
  if (req.tool_choice !== undefined) {
    if (!hasFunctions) fail('No declared function tools');
    const choice=req.tool_choice;
    if (typeof choice === 'string') {
      if (!['none','auto','required'].includes(choice)) fail('Unknown tool_choice');
    } else if (record(choice)) {
      keys(choice,['type','name'],'tool_choice');
      if (choice.type !== 'function' || !functionName(choice.name) || !Array.isArray(approved.tools) || !(approved.tools as ObjectValue[]).some(t=>t.name===choice.name)) fail('Unapproved tool_choice');
    } else fail('Invalid tool_choice');
    approved.tool_choice=choice;
  }
  if (req.parallel_tool_calls !== undefined) {
    if (!hasFunctions || typeof req.parallel_tool_calls !== 'boolean') fail('Invalid parallel_tool_calls');
    approved.parallel_tool_calls=req.parallel_tool_calls;
  }
  const max=approved.max_output_tokens;
  if (!Number.isSafeInteger(max) || (max as number)<1 || (max as number)>config.policy.maxOutputTokens) fail('Bounded max_output_tokens required');
  return {body:approved,group,maxOutput:max as number,clientMode:mode,hasFunctions};
}
