/** Minimal, deliberately bounded Chat Completions wire adapter.
 * Requests execute through the audited Responses API; local tools run in the client.
 */
type J = Record<string, unknown>;
const obj = (v: unknown): v is J => v !== null && typeof v === 'object' && !Array.isArray(v);
function outputParts(raw: J): { content: string | null; calls: J[] } {
  if (!Array.isArray(raw.output)) throw new Error('Chat adapter needs a complete Responses output array');
  const text: string[] = [], calls: J[] = [];
  for (const item of raw.output) {
    if (!obj(item)) throw new Error('Malformed Responses output item');
    if (item.type === 'reasoning') continue;
    if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string')
        throw new Error('Malformed function call from upstream');
      calls.push({id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments}});
      continue;
    }
    if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) throw new Error('Unsupported upstream output type');
    for (const c of item.content) {
      if (!obj(c) || c.type !== 'output_text' || typeof c.text !== 'string') throw new Error('Non-text upstream output');
      text.push(c.text);
    }
  }
  return {content:text.length ? text.join('') : null,calls};
}
export function chatResponse(raw: J): J {
  const {content,calls}=outputParts(raw);
  if (!obj(raw.usage) || !Number.isSafeInteger(raw.usage.input_tokens) || !Number.isSafeInteger(raw.usage.output_tokens))
    throw new Error('Chat completion missing usage');
  const usage=raw.usage;
  return {
    id:typeof raw.id==='string'?raw.id:'chatcmpl-quota-fuse',
    object:'chat.completion',created:Math.floor(Date.now()/1000),model:raw.model,
    choices:[{index:0,message:{role:'assistant',content,...(calls.length?{tool_calls:calls}:{})},finish_reason:calls.length?'tool_calls':'stop',logprobs:null}],
    usage:{prompt_tokens:usage.input_tokens,completion_tokens:usage.output_tokens,
      total_tokens:(usage.input_tokens as number)+(usage.output_tokens as number)}
  };
}
export function chatStreamDelta(event: string | undefined, data: unknown, model: string, toolIndices: Map<number,number>): string | null {
  if (!obj(data)) return null;
  let delta: J | null=null;
  if (event==='response.created') delta={role:'assistant'};
  if (event==='response.output_text.delta') {
    if (typeof data.delta!=='string') throw new Error('Invalid text delta');
    delta={content:data.delta};
  }
  if (event==='response.output_item.added' && obj(data.item) && data.item.type==='function_call') {
    if (!Number.isSafeInteger(data.output_index) || (data.output_index as number) < 0 ||
        typeof data.item.call_id!=='string' || typeof data.item.name!=='string' || toolIndices.has(data.output_index as number))
      throw new Error('Invalid streamed function call');
    const index=toolIndices.size;
    toolIndices.set(data.output_index as number,index);
    delta={tool_calls:[{index,id:data.item.call_id,type:'function',function:{name:data.item.name,arguments:''}}]};
  }
  if (event==='response.function_call_arguments.delta') {
    if (!Number.isSafeInteger(data.output_index) || !toolIndices.has(data.output_index as number) ||
        typeof data.delta!=='string') throw new Error('Invalid or unmatched streamed arguments');
    delta={tool_calls:[{index:toolIndices.get(data.output_index as number),function:{arguments:data.delta}}]};
  }
  if (!delta) return null;
  return 'data: '+JSON.stringify({id:'chatcmpl-quota-fuse',object:'chat.completion.chunk',
    created:Math.floor(Date.now()/1000),model,choices:[{index:0,delta,finish_reason:null,logprobs:null}]})+'\n\n';
}
export function chatStreamEnd(raw: J): string {
  const completion=chatResponse(raw);
  const choice=(completion.choices as J[])[0];
  const finish=choice.finish_reason;
  const usage=completion.usage;
  return 'data: '+JSON.stringify({id:completion.id,object:'chat.completion.chunk',created:completion.created,model:completion.model,
    choices:[{index:0,delta:{},finish_reason:finish,logprobs:null}],usage})+'\n\n'+'data: [DONE]\n\n';
}
