// Ported from /opt/commandcode-proxy/responses-compat.mjs; see LICENSE.commandcode.
import { createHash } from 'node:crypto';

const invalid = message => Object.assign(new Error(message), { statusCode: 400 });
const identity = (namespace, name) => JSON.stringify([namespace || '', name]);
const optionalHostedSearch = new Set(['web_search', 'web_search_preview', 'web_search_preview_2025_03_11']);

// CC can emit either JSON function arguments or the original free-form string
// for a custom tool. Preserve text; never turn arbitrary object fields into code.
function customInput(args) {
  let parsed = args;
  if (typeof args === 'string') {
    try { parsed = JSON.parse(args); }
    catch { return args; }
    if (typeof parsed === 'string') return parsed;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.input !== 'string') {
      // Custom input is free-form text, including JSON literals such as {}.
      // Preserve original wire text; do not extract/invent code from its keys.
      return args;
    }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.input === 'string') {
    return parsed.input;
  }
  const shape = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
  // Structural diagnostics only, never log arguments or arbitrary field names.
  const knownFields = shape === 'object' ? Object.keys(parsed).slice(0, 8).map(k =>
    ['input', 'code', 'cmd', 'command', 'text', 'content', 'arguments', '__arg1', 'value'].includes(k) ? k : 'other') : [];
  throw new Error(`Upstream custom tool arguments must contain a string input (shape=${shape}, fields=${shape === 'object' ? Object.keys(parsed).length : 0}, knownFields=${knownFields.join('|')}, input=${typeof parsed?.input}, code=${typeof parsed?.code}, cmd=${typeof parsed?.cmd})`);
}

// AI SDK's raw argument deltas can survive even when its final parsed input is
// empty. Keep them by call ID, never by arrival order or just the tool name.
export function createToolInputCollector({ maxBytes = 16 * 1024 * 1024, acceptName = () => true } = {}) {
  const pending = new Map();
  let totalBytes = 0;
  let starts = 0;
  let acceptedStarts = 0;
  let deltas = 0;
  return {
    observe(event) {
      const id = event.toolCallId ?? event.id;
      if (typeof id !== 'string' || !id) return;
      if (event.type === 'tool-input-start') {
        starts++;
        if (!acceptName(event.toolName)) return;
        acceptedStarts++;
        if (pending.has(id)) throw new Error('Duplicate upstream tool-input-start ID');
        pending.set(id, { name: event.toolName, parts: [], bytes: 0, deltaEvents: 0, deltaShape: '' });
      } else if (event.type === 'tool-input-delta') {
        deltas++;
        const state = pending.get(id);
        const delta = event.delta ?? event.inputTextDelta ?? event.text;
        if (state) {
          state.deltaEvents++;
          state.deltaShape = `delta:${typeof event.delta},inputTextDelta:${typeof event.inputTextDelta},text:${typeof event.text}`;
        }
        if (!state || typeof delta !== 'string') return;
        const bytes = Buffer.byteLength(delta);
        totalBytes += bytes;
        if (totalBytes > maxBytes) throw new Error('Upstream tool input exceeds the compatibility buffer limit');
        state.bytes += bytes;
        state.parts.push(delta);
      }
    },
    take(event) {
      const id = event.toolCallId ?? event.id;
      const state = pending.get(id);
      if (!state) return { diagnostic: `raw_start=missing,starts=${starts},accepted=${acceptedStarts},deltas=${deltas},pending=${pending.size}` };
      pending.delete(id);
      totalBytes -= state.bytes;
      if (!state.bytes) return { diagnostic: `raw_start=found,delta_events=${state.deltaEvents},${state.deltaShape}` };
      return { name: state.name, text: state.parts.join('') };
    },
  };
}

// A per-request registry: never guess how to split a flattened name, and never
// share aliases across clients. Custom tools cross the function-only CC wire as
// {input: string}, then become native Responses custom_tool_call items again.
export function prepareResponsesCompatibility(request, { onRawInputRecovery } = {}) {
  const entries = new Map();
  const aliases = new Map();
  const definitions = new Map();
  const alternateNames = new Map();
  const omittedHostedTools = new Set();
  const preferredNames = new Map();
  const input = Array.isArray(request.input) ? request.input : [];
  function reserve(name, namespace) {
    if (typeof name !== 'string') return;
    const preferred = namespace ? `${namespace}__${name}` : name;
    if (!preferredNames.has(preferred)) preferredNames.set(preferred, new Set());
    preferredNames.get(preferred).add(identity(namespace, name));
  }
  function reserveTools(tools, namespace) {
    if (!Array.isArray(tools)) return;
    for (const tool of tools) {
      if (tool?.type === 'namespace') reserveTools(tool.tools, tool.name);
      else if (tool?.type === 'function' || tool?.type === 'custom') reserve(tool.name, namespace || tool.namespace);
    }
  }
  reserveTools(request.tools);
  for (const item of input) {
    if (item?.type === 'additional_tools') reserveTools(item.tools);
    else if (item?.type === 'function_call' || item?.type === 'custom_tool_call') reserve(item.name, item.namespace);
  }

  function register(name, namespace, type) {
    if (typeof name !== 'string' || !name || (namespace != null && typeof namespace !== 'string')) {
      throw invalid('Responses tools require a non-empty name and an optional string namespace');
    }
    const key = identity(namespace, name);
    const previous = entries.get(key);
    if (previous) {
      if (previous.type !== type) throw invalid('Conflicting Responses tool types for the same name');
      return previous;
    }
    // Reserve cc_tool_ for encoded names, including collisions with root tools.
    const readable = `${namespace || ''}_${name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
    const legacyAlias = 'cc_tool_' + readable + '_' + createHash('sha256').update(key).digest('hex').slice(0, 20);
    const preferred = namespace ? `${namespace}__${name}` : name;
    const alias = /^[A-Za-z0-9_-]{1,64}$/.test(preferred) && !preferred.startsWith('cc_tool_')
      && preferredNames.get(preferred)?.size === 1 ? preferred : legacyAlias;
    if (aliases.has(alias)) throw invalid('Responses tool alias collision');
    const entry = { name, namespace: namespace || undefined, type, alias };
    entries.set(key, entry);
    aliases.set(alias, entry);
    // Accept only known, unambiguous names from the declared catalog. Some
    // models copy the original tool spelling from Codex's system instructions.
    for (const spelling of [name, legacyAlias, ...(namespace ? [`${namespace}.${name}`, `${namespace}__${name}`] : [])]) {
      if (!alternateNames.has(spelling)) alternateNames.set(spelling, entry);
      else if (alternateNames.get(spelling) !== entry) alternateNames.set(spelling, null);
    }
    return entry;
  }

  function addTools(tools, namespace) {
    if (!Array.isArray(tools)) throw invalid('Responses tools must be an array');
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') throw invalid('Invalid Responses tool definition');
      if (!namespace && optionalHostedSearch.has(tool.type)) {
        // Merely advertising a hosted capability must not break ordinary chat.
        // CC does not implement OpenAI's hosted search protocol. Do not invent
        // an executable function or pretend a search occurred.
        omittedHostedTools.add(tool.type);
        continue;
      }
      if (tool.type === 'namespace') {
        if (namespace || typeof tool.name !== 'string' || !tool.name) {
          throw invalid('Nested or unnamed Responses namespaces are not supported');
        }
        addTools(tool.tools, tool.name);
        continue;
      }
      if (tool.type !== 'function' && tool.type !== 'custom') {
        throw invalid(`Unsupported Responses tool type: ${tool.type}`);
      }
      const entry = register(tool.name, namespace || tool.namespace, tool.type);
      let description = tool.description || '';
      if (entry.namespace) description = `Responses tool ${entry.namespace}.${entry.name}.\n${description}`;
      let parameters = tool.parameters || { type: 'object', properties: {} };
      if (tool.type === 'custom') {
        if (tool.format?.type === 'grammar') {
          description += `\nInput grammar (${tool.format.syntax || 'text'}):\n${tool.format.definition || ''}`;
        }
        description += '\nTransport requirement: this tool is exposed as a JSON function. Supply exactly {"input":"<complete raw tool text>"}. Put all free-form code/text inside the input string, not in top-level code/cmd/command fields. Do not JSON-encode the input string a second time.';
        parameters = {
          type: 'object', properties: { input: { type: 'string', description: 'Exact free-form tool input' } },
          required: ['input'], additionalProperties: false,
        };
      } else if (entry.namespace === 'collaboration' && ['spawn_agent', 'send_message', 'followup_task'].includes(entry.name)) {
        // OpenAI's encrypted schema annotation is not a portable JSON Schema
        // feature. Request plaintext for delegation authored through this bridge.
        parameters = structuredClone(parameters);
        if (parameters.properties?.message) delete parameters.properties.message.encrypted;
      }
      // Later additional_tools declarations may update an existing definition.
      definitions.set(entry.alias, { type: 'function', function: { name: entry.alias, description, parameters,
        ...(tool.type === 'function' && tool.strict !== undefined ? { strict: tool.strict } : {}) } });
    }
  }
  if (request.tools != null) addTools(request.tools);
  for (const item of input) if (item?.type === 'additional_tools') addTools(item.tools);
  // Full stateless history may include a tool that is no longer offered.
  for (const item of input) {
    if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
      register(item.name, item.namespace, item.type === 'custom_tool_call' ? 'custom' : 'function');
    }
  }

  const normalizedInput = input.flatMap(item => {
    if (item?.type === 'additional_tools') return [];
    if (item?.type === 'agent_message') {
      let content = item.content;
      if (Array.isArray(content)) content = content.map(part => {
        if (part?.type !== 'encrypted_content') return part;
        // Some third-party Codex routes use this field for the original text.
        // This is a representation conversion, NOT cryptographic decryption.
        if (typeof part.encrypted_content !== 'string') throw invalid('Invalid agent_message encrypted_content');
        if (/^gAAAA[A-Za-z0-9_-]{70,}={0,2}$/.test(part.encrypted_content.trim())) {
          throw invalid('Encrypted Codex agent_message cannot be decrypted by this proxy. Disable message encryption on the parent agent route before spawning; resend the task in plaintext.');
        }
        return { type: 'input_text', text: part.encrypted_content };
      });
      if (typeof content !== 'string' && !Array.isArray(content)) throw invalid('agent_message requires content');
      if (Array.isArray(content) && content.some(p => p && !['input_text', 'text', 'input_image'].includes(p.type))) {
        throw invalid('Unsupported agent_message content type');
      }
      return [{ type: 'message', role: 'user', content }];
    }
    if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
      const entry = entries.get(identity(item.namespace, item.name));
      if (entry.type === 'custom' && typeof item.input !== 'string') throw invalid('custom_tool_call requires string input');
      return [{ ...item, type: 'function_call', name: entry.alias,
        arguments: entry.type === 'custom' ? JSON.stringify({ input: item.input }) : item.arguments }];
    }
    if (item?.type === 'custom_tool_call_output') return [{ ...item, type: 'function_call_output' }];
    return [item];
  });

  function toolChoice(choice) {
    if (choice === 'required' && omittedHostedTools.size && !definitions.size) {
      throw invalid('tool_choice=required cannot be satisfied: OpenAI-hosted web search is unavailable on this gateway');
    }
    if (choice == null || typeof choice === 'string') return choice;
    if (optionalHostedSearch.has(choice.type)) {
      throw invalid('Explicit OpenAI-hosted web search is unavailable on this gateway; use a supplied client-side search tool');
    }
    if (!['function', 'custom'].includes(choice.type)) throw invalid('Unsupported Responses tool_choice');
    const entry = entries.get(identity(choice.namespace, choice.name));
    if (!entry || !definitions.has(entry.alias)) throw invalid('tool_choice references an undeclared tool');
    return { type: 'function', function: { name: entry.alias } };
  }

  function outputCall(name, args, callId, id, status = 'completed', rawInput) {
    const entry = aliases.get(name) || alternateNames.get(name);
    if (!entry) throw new Error(`Upstream returned an undeclared or ambiguous tool name: ${String(name).slice(0, 100)}`);
    const base = { id, call_id: callId, name: entry?.name || name, status };
    if (entry?.namespace) base.namespace = entry.namespace;
    if (entry?.type === 'custom') {
      let input;
      try { input = customInput(args); }
      catch (error) {
        const rawEntry = rawInput && (aliases.get(rawInput.name) || alternateNames.get(rawInput.name));
        if (rawEntry !== entry || typeof rawInput?.text !== 'string') {
          if (rawInput?.diagnostic) error.message += ` [${rawInput.diagnostic}]`;
          throw error;
        }
        // Recover only original text for this exact declared tool/call. Do not
        // infer JavaScript from cmd/code objects or extract code from DSML prose.
        input = customInput(rawInput.text);
        onRawInputRecovery?.();
      }
      return { ...base, type: 'custom_tool_call', input };
    }
    return { ...base, type: 'function_call', arguments: typeof args === 'string' ? args : JSON.stringify(args || {}) };
  }

  return { input: Array.isArray(request.input) ? normalizedInput : request.input,
    tools: [...definitions.values()], toolChoice: toolChoice(request.tool_choice), outputCall,
    isCustomTool: name => (aliases.get(name) || alternateNames.get(name))?.type === 'custom',
    capabilityNotice: omittedHostedTools.size
      ? 'Gateway capability notice: OpenAI-hosted web_search is unavailable on this route and has not been executed. Use an explicitly supplied client-side browsing/search tool if available. Never claim to have searched the web without real tool results.'
      : null,
    omittedHostedTools: [...omittedHostedTools] };
}
