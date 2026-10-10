const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function frontend({status=200, signedIn=true, blocked=false}={}) {
  const html=fs.readFileSync('index.html','utf8');
  const start=html.indexOf('function cleanForSpeech');
  const end=html.indexOf('function startListening',start);
  let deviceCalls=0, audioCalls=0, fetchCalls=0;
  class Audio {
    play() {
      audioCalls++;
      if(blocked) return Promise.reject(Object.assign(new Error('tap required'),{name:'NotAllowedError'}));
      setTimeout(()=>this.onended?.(),0);
      return Promise.resolve();
    }
    pause() { this.onpause?.(); }
  }
  const context=vm.createContext({
    state:{lang:'en',coachMode:'interview',view:'coach'},
    sb:{auth:{getSession:async()=>({data:{session:signedIn?{access_token:'test-token'}:null}})}},
    Audio, SpeechSynthesisUtterance:class{}, URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:()=>{}},
    window:{speechSynthesis:{getVoices:()=>[],cancel(){},speak(){deviceCalls++;}}},
    document:{addEventListener(){}}, T:k=>k,toast(){},render(){},
    console:{warn(){}},
    fetch:async()=>{fetchCalls++;return {ok:status===200,status,text:async()=> '{}',blob:async()=> ({})};},
  });
  vm.runInContext(html.slice(start,end),context);
  return {context,run:text=>vm.runInContext('speakText('+JSON.stringify(text)+')',context),
    counters:()=>({deviceCalls,audioCalls,fetchCalls})};
}
test('mock uses natural audio without device speech',async()=>{
  const f=frontend();await f.run('Tell me about yourself.');
  assert.equal(f.context.state.voiceEngine,'natural');
  assert.deepEqual(f.counters(),{deviceCalls:0,audioCalls:1,fetchCalls:1});
});
test('mobile autoplay block asks for replay without robotic fallback',async()=>{
  const f=frontend({blocked:true});await f.run('What is your experience?');
  assert.equal(f.context.state.voiceEngine,'blocked');
  assert.equal(f.counters().deviceCalls,0);
});
test('server errors never silently switch mock to robotic voice and can be retried',async()=>{
  const f=frontend({status:500});await f.run('A question.');await f.run('A question.');
  assert.equal(f.context.state.voiceEngine,'error');
  assert.equal(f.counters().deviceCalls,0);assert.equal(f.counters().fetchCalls,2);
});
test('signed-out phone requests sign-in instead of reading robotically',async()=>{
  const f=frontend({signedIn:false});await f.run('A question.');
  assert.equal(f.context.state.voiceEngine,'signin');
  assert.equal(f.counters().deviceCalls,0);assert.equal(f.counters().fetchCalls,0);
});
function backend(status=200) {
  const calls=[];
  const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'public-test-key',OPENAI_API_KEY:'test-key'};
  const context=vm.createContext({process:{env},Buffer,Date,Math,fetch:async(url,options)=>{
    if(url.includes('/auth/v1/user'))return {ok:true,json:async()=>({id:'user-test',email:'test@example.com'})};
    calls.push(JSON.parse(options.body));
    const n=calls.length===1?status:200;
    return {ok:n===200,status:n,text:async()=> 'test error',arrayBuffer:async()=>new Uint8Array([1,2]).buffer};
  }});
  vm.runInContext(fs.readFileSync('api/tts.js','utf8').replace('export default async function handler','async function handler'),context);
  let code,headers={};
  const res={status(n){code=n;return this;},json(body){return body;},send(body){return body;},setHeader(k,v){headers[k]=v;}};
  return {calls,run:()=>context.handler({method:'POST',headers:{authorization:'Bearer test-token'},body:{text:'A question.',lang:'en'}},res),code:()=>code,headers};
}
test('natural speech uses marin and returns mobile-compatible MP3',async()=>{
  const b=backend();await b.run();assert.equal(b.calls[0].voice,'marin');
  assert.equal(b.calls[0].model,'gpt-4o-mini-tts');assert.equal(b.code(),200);
  assert.equal(b.headers['Content-Type'],'audio/mpeg');
});
test('unsupported voice can use compatible high-quality fallback',async()=>{
  const b=backend(400);await b.run();assert.equal(b.calls.length,2);
  assert.equal(b.calls[1].model,'tts-1-hd');assert.equal(b.calls[1].voice,'nova');
});
test('billing/rate limit failure does not trigger a second paid call',async()=>{
  const b=backend(429);await b.run();assert.equal(b.calls.length,1);assert.equal(b.code(),502);
});
