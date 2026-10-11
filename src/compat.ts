import type { ApprovedRequest } from './policy.ts';

type Obj = Record<string, any>;
export function toChatCompletion(raw: Obj): Obj {
  if (raw.status !== 'completed' || !Array.isArray(raw.output) || !raw.usage ||
      !Number.isSafeInteger(raw.usage.input_tokens) || !Number.isSafeInteger(raw.usage.output_tokens))
    throw new Error('Cannot create verified chat response');
  let content = '';
  const toolCalls: Obj[] = [];
  for (const item of raw.output) {
    if (item?.type === 'reasoning') continue; // Reasoning metadata is not rendered as text.
    if (item?.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string')
        throw new Error('Invalid function result');
      toolCalls.push({ id:item.call_id, type:'function', function:{name:item.name,arguments:item.arguments} });
      continue;
    }
    if (item?.type !== 'message' || !Array.isArray(item.content)) throw new Error('Unsupported chat output item');
    for (const part of item.content) {
      if (part?.type !== 'output_text' || typeof part.text !== 'string') throw new Error('Unsupported chat output part');
      content += part.text;
    }
  }
  if (!content && !toolCalls.length) throw new Error('Empty chat output');
  const message: Obj = { role:'assistant', content:content || null };
  if (toolCalls.length) message.tool_calls=toolCalls;
  return {
    id:raw.id || 'chatcmpl-unknown', object:'chat.completion',
    created:raw.created_at || Math.floor(Date.now()/1000), model:raw.model,
    choices:[{index:0,message,finish_reason:toolCalls.length ? 'tool_calls' : 'stop'}],
    usage:{prompt_tokens:raw.usage.input_tokens,completion_tokens:raw.usage.output_tokens,
      total_tokens:raw.usage.input_tokens+raw.usage.output_tokens}
  };
}
export class ChatStreamAdapter {
  private toolIndex = new Map<number,number>();
  private tools = 0;
  private hasText = false;
  readonly chunks: string[] = [];
  constructor(private readonly model: string) {}
  private emit(delta: Obj, reason: string | null = null, usage?: Obj): string {
    const chunk: Obj = {
      id:'chatcmpl-quota-fuse', object:'chat.completion.chunk',
      created:Math.floor(Date.now()/1000), model:this.model,
      choices:[{index:0,delta,finish_reason:reason}]
    };
    if (usage) chunk.usage=usage;
    return 'data: ' + JSON.stringify(chunk) + '\n\n';
  }
  event(kind: string | undefined, data: unknown): string {
    if (!data || typeof data !== 'object') return '';
    const part = data as Obj;
    if (kind === 'response.output_text.delta') {
      if (typeof part.delta !== 'string') throw new Error('Untrusted text stream');
      this.hasText = true;
      return this.emit({content:part.delta});
    }
    if (kind === 'response.output_item.added' && part.item?.type === 'function_call') {
      if (!Number.isSafeInteger(part.output_index) || typeof part.item.call_id !== 'string' ||
          typeof part.item.name !== 'string') throw new Error('Untrusted function stream');
      if (this.toolIndex.has(part.output_index)) throw new Error('Duplicate function stream');
      const index=this.tools++;
      this.toolIndex.set(part.output_index,index);
      return this.emit({tool_calls:[{index,id:part.item.call_id,type:'function',
        function:{name:part.item.name,arguments:part.item.arguments || ''}}]});
    }
    if (kind === 'response.function_call_arguments.delta') {
      if (!this.toolIndex.has(part.output_index) || typeof part.delta !== 'string')
        throw new Error('Unmatched function arguments');
      return this.emit({tool_calls:[{index:this.toolIndex.get(part.output_index),function:{arguments:part.delta}}]});
    }
    if (kind === 'response.output_item.added' && !['message','reasoning'].includes(part.item?.type))
      throw new Error('Unsupported chat stream item');
    if (kind === 'response.output_text.done' || kind === 'response.output_item.done' ||
        kind === 'response.created' || kind === 'response.in_progress' ||
        kind === 'response.content_part.added' || kind === 'response.content_part.done' ||
        kind === 'response.function_call_arguments.done' || kind === 'response.reasoning_summary_text.delta')
      return '';
    return '';
  }
  finish(raw: Obj, includeUsage: boolean): string {
    // Verify the complete Chat result before reporting success.
    const result=toChatCompletion(raw);
    const finishReason=result.choices[0].finish_reason;
    let data=this.emit({},finishReason);
    if (includeUsage) data += this.emit({},null,result.usage);
    return data + 'data: [DONE]\n\n';
  }
}
