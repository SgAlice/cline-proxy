import http from 'node:http';
import assert from 'node:assert/strict';
import { prepareResponsesCompatibility as prepare } from '../responses-compat.mjs';
process.env.HOST = '127.0.0.1';
process.env.PORT = '13661';
process.env.LOG_LEVEL = 'error';
let captured, calls = 0, handler;
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const ok = [chunk({ content: 'OK' }, 'stop')];
globalThis.fetch = async (url, options) => {
  calls++; captured = JSON.parse(options.body);
  if (!captured.stream) return Response.json({ success: true, data: { choices: [{ message: { content: 'CHAT_OK' } }], usage: { total_tokens: 3 } } });
  const chunks = handler ? handler(captured) : ok;
  return new Response(chunks.map(x => 'data: ' + JSON.stringify(x) + '\n\n').join('') + 'data: [DONE]\n\n');
};
await import('../proxy.mjs');
await new Promise(r => setTimeout(r, 60));
function request(body, path = '/v1/responses') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 13661, path, method: 'POST', headers: { Authorization: 'Bearer mock', 'Content-Type': 'application/json' } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', s => body += s); res.on('end', () => resolve({ status: res.statusCode, body }));
    }); req.setTimeout(5000, () => req.destroy(new Error('timeout'))); req.on('error', reject);
    req.end(JSON.stringify({ model: 'deepseek-v4.1-flash', ...body }));
  });
}
const fun = (name='lookup') => ({ type: 'function', name, strict: true, parameters: { type: 'object', properties: { q: { type: 'string' } } } });
const custom = (name='exec') => ({ type: 'custom', name, format: { type: 'grammar', syntax: 'lark', definition: 'start: /[\\s\\S]+/' } });
const ns = (name, tools) => ({ type: 'namespace', name, tools });
const additional = tools => ({ type: 'additional_tools', tools });
const agent = content => ({ type: 'agent_message', content });
const txt = text => ({ type: 'input_text', text });
const user = content => ({ role: 'user', content });
function output(r, stream) {
  assert.equal(r.status, 200, r.body);
  if (!stream) return JSON.parse(r.body).output;
  const events = r.body.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
  const done = events.find(e => e.type === 'response.completed'); assert.ok(done, r.body);
  assert.deepEqual(events.filter(e => e.type === 'response.output_item.done').map(e => e.item), done.response.output);
  return done.response.output;
}
const tests=[]; const test=(name,run)=>tests.push({name,run});
for (const stream of [false,true]) {
  const suffix = stream ? ' SSE' : ' JSON';
  test('delegation and additional tools'+suffix, async()=>{
    output(await request({stream,input:[additional([ns('functions',[custom(),fun()])]),agent([{type:'encrypted_content',encrypted_content:'DELEGATED_明文'}])]}),stream);
    assert.equal(captured.messages[0].content,'DELEGATED_明文');
    assert.deepEqual(captured.tools.map(t=>t.function.name),['functions__exec','functions__lookup']);
    assert.match(captured.tools[0].function.description,/Transport requirement/);
    assert.equal(captured.tools[1].function.strict,true);
  });
  for (const args of [JSON.stringify({input:'text("中文\\n");'}),'text("raw");',JSON.stringify('encoded text'),'{}']) {
    test('custom original input '+args+suffix,async()=>{
      handler=c=>[chunk({tool_calls:[{index:0,id:'call_custom',function:{name:c.tools[0].function.name,arguments:args.slice(0,3)}}]}),chunk({tool_calls:[{index:0,function:{arguments:args.slice(3)}}]},'tool_calls')];
      const out=output(await request({stream,tools:[ns('functions',[custom()])],input:[agent('use tool')]}),stream);
      assert.equal(out[0].type,'custom_tool_call');assert.equal(out[0].namespace,'functions');assert.equal(out[0].name,'exec');assert.equal(out[0].call_id,'call_custom');
      let expected=args;try{const p=JSON.parse(args);expected=typeof p==='string'?p:p.input??args;}catch{}
      assert.equal(out[0].input,expected);
    });
  }
  test('namespaced function and forced tool choice'+suffix,async()=>{
    handler=c=>[chunk({tool_calls:[{index:0,id:'call_f',function:{name:c.tools[0].function.name,arguments:'{"q":"x"}'}}]},'tool_calls')];
    const out=output(await request({stream,input:'go',tools:[ns('mcp',[fun()])],tool_choice:{type:'function',namespace:'mcp',name:'lookup'}}),stream);
    assert.equal(captured.tool_choice.function.name,'mcp__lookup');assert.equal(out[0].namespace,'mcp');assert.equal(out[0].arguments,'{"q":"x"}');
  });
  test('custom history and images'+suffix,async()=>{
    output(await request({stream,input:[additional([ns('functions',[custom()])]),user('go'),{type:'custom_tool_call',name:'exec',namespace:'functions',call_id:'a',input:'raw history'},{type:'custom_tool_call_output',call_id:'a',output:[txt('result'),{type:'input_image',image_url:'https://example.com/tool.png'}]},agent('continue')]}),stream);
    const a=captured.messages.find(x=>x.tool_calls);assert.equal(a.tool_calls[0].function.name,'functions__exec');assert.equal(JSON.parse(a.tool_calls[0].function.arguments).input,'raw history');
    assert.equal(captured.messages[2].tool_call_id,'a');assert.equal(captured.messages[3].content[1].image_url.url,'https://example.com/tool.png');
  });
  test('interleaved parallel function/custom'+suffix,async()=>{
    handler=c=>[chunk({tool_calls:[{index:1,id:'b',function:{name:c.tools[1].function.name,arguments:'{"input":'}},{index:0,id:'a',function:{name:c.tools[0].function.name,arguments:'{"q":'}}]}),chunk({tool_calls:[{index:0,function:{arguments:'"A"}'}},{index:1,function:{arguments:'"B"}'}}]},'tool_calls')];
    const out=output(await request({stream,input:'go',tools:[ns('functions',[fun(),custom()])]}),stream);
    assert.deepEqual(out.map(x=>x.call_id),['a','b']);assert.equal(out[1].input,'B');assert.equal(out[0].arguments,'{"q":"A"}');
  });
  test('reasoning roundtrip'+suffix,async()=>{
    handler=()=>[chunk({reasoning_content:'think'}),chunk({content:'OK'},'stop')];
    const out=output(await request({stream,input:'go'}),stream);assert.equal(out[0].encrypted_content,'clinepx1:dGhpbms=');
    handler=null;output(await request({stream,input:[user('go'),...out,user('continue')]}),stream);assert.equal(captured.messages[1].reasoning_content,'think');
  });
  test('plain and optional search'+suffix,async()=>{
    output(await request({stream,input:'plain',tools:[{type:'web_search'}]}),stream);assert.match(captured.messages[0].content,/unavailable/);assert.equal(captured.tools,undefined);
  });
  test('local shell'+suffix,async()=>{
    handler=c=>[chunk({tool_calls:[{index:0,id:'shell',function:{name:'local_shell',arguments:'{"command":["echo","ok"]}'}}]},'tool_calls')];
    const out=output(await request({stream,input:'go',tools:[{type:'local_shell'}]}),stream);assert.equal(out[0].type,'local_shell_call');assert.deepEqual(out[0].action.command,['echo','ok']);
  });
  test('unknown tool is error not completed'+suffix,async()=>{
    handler=()=>[chunk({tool_calls:[{index:0,id:'x',function:{name:'invented',arguments:'{}'}}]},'tool_calls')];
    const r=await request({stream,input:'go',tools:[fun()]});assert.equal(r.status,stream?200:502);assert.doesNotMatch(r.body,/response.completed/);if(stream)assert.match(r.body,/response.failed/);
  });
  test('truncated upstream not completed'+suffix,async()=>{
    handler=()=>[chunk({content:'partial'})];const r=await request({stream,input:'go'});assert.equal(r.status,stream?200:502);assert.doesNotMatch(r.body,/response.completed/);
  });
  test('DSML remains text not a tool'+suffix,async()=>{
    handler=()=>[chunk({content:'<｜DSML｜invoke name="exec">text</｜DSML｜invoke>'},'stop')];
    const out=output(await request({stream,input:'go',tools:[custom()]}),stream);assert.equal(out[0].type,'message');
  });
  test('chat regression'+suffix,async()=>{
    const r=await request({stream,messages:[{role:'user',content:'hello'}]},'/v1/chat/completions');assert.equal(r.status,200);if(!stream)assert.equal(JSON.parse(r.body).choices[0].message.content,'CHAT_OK');else assert.match(r.body,/\[DONE\]/);
  });
}
for(const [name,body] of [
  ['ciphertext',{input:[agent([{type:'encrypted_content',encrypted_content:'gAAAA'+'A'.repeat(100)}])]}],
  ['unknown input',{input:[{type:'unknown_item'}]}],['invalid input',{input:{foo:'bar'}}],['invalid item',{input:[null]}],
  ['unknown tools',{input:'go',tools:[{type:'computer_use'}]}],['forced search',{input:'go',tools:[{type:'web_search'}],tool_choice:{type:'web_search'}}],
  ['required search',{input:'go',tools:[{type:'web_search'}],tool_choice:'required'}],['previous response',{input:'go',previous_response_id:'r'}],
  ['bad custom history',{input:[{type:'custom_tool_call',name:'exec',input:{code:'bad'}}]}],
])test('reject '+name,async()=>{const n=calls;const r=await request(body);assert.equal(r.status,400,r.body);assert.equal(calls,n);});
test('alias collision roundtrip',async()=>{
  const tools=[fun('a__b'),ns('a',[fun('b')]),ns('invalid space',[custom('z')])];const r=prepare({tools});
  assert.equal(new Set(r.tools.map(t=>t.function.name)).size,3);
  for(const [i,t] of r.tools.entries()){assert.match(t.function.name,/^[\w-]{1,64}$/);const out=r.outputCall(t.function.name,i===2?'raw':'{}','id','item');assert.equal(out.name,['a__b','b','z'][i]);}
});
test('collaboration encryption annotation removed selectively',async()=>{
  const f=fun('spawn_agent');f.parameters.properties.message={type:'string',encrypted:true};
  const r=prepare({tools:[ns('collaboration',[f]),ns('other',[f])]});assert.equal(r.tools[0].function.parameters.properties.message.encrypted,undefined);assert.equal(r.tools[1].function.parameters.properties.message.encrypted,true);assert.equal(f.parameters.properties.message.encrypted,true);
});
test('legacy function envelope and nullable tools',async()=>{
  output(await request({input:'hi',tools:[{type:'function',function:fun()}]}),false);assert.equal(captured.tools[0].function.name,'lookup');output(await request({input:'hi',tools:null}),false);
});
let passed=0;
try { for(const t of tests){handler=null;await t.run();passed++;console.log('PASS '+t.name);}console.log(`${passed}/${tests.length} passed`);process.exit(0); }
catch(e){console.error(`FAIL ${tests[passed].name}`,e);process.exit(1);}
