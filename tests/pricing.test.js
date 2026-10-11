const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const P=require('../pricing');
test('affordable service suggestions do not double-charge resume and LinkedIn',()=>{
  assert.equal(P.recommend({}).amount,30);
  assert.equal(P.recommend({services:['interview_prep']}).amount,40);
  assert.equal(P.recommend({services:['resume_review','linkedin_and_networking','resume_review']}).amount,35);
  assert.equal(P.recommend({services:['resume_review','linkedin_and_networking','interview_prep']}).amount,45);
  assert.equal(P.recommend({years:60}).amount,40);
});
test('only enough approved comparable listings activate a bounded market benchmark',()=>{
  const input={id:'self',field:'Engineering',years:2,services:['interview_prep']};
  const peer=i=>({id:String(i),role:'mentor',approved:true,field:'Engineering',experience:'2',helpsWith:['interview_prep'],sessionRate:200});
  assert.equal(P.recommend(input,[peer(1)]).source,'starting-guidance');
  const result=P.recommend(input,Array.from({length:5},(_,i)=>peer(i)));
  assert.equal(result.source,'comparable-listings');assert.equal(result.amount,50);
  const others=Array.from({length:5},(_,i)=>({...peer(i),approved:false}));
  assert.equal(P.recommend(input,others).source,'starting-guidance');
});
test('invalid services and AI outliers cannot bypass the recommendation band',()=>{
  const rec=P.recommend({services:['bogus','interview_prep']});
  assert.deepEqual(rec.services,['interview_prep']);
  assert.equal(P.boundedAIAmount(10000,rec),45);assert.equal(P.boundedAIAmount(-100,rec),35);
  assert.equal(P.boundedAIAmount('invalid',rec),40);
});
function harness({signedIn=true,role='mentor',failure=false,amount=1000}={}){
  let paidCalls=0;
  const mail={userFromToken:async()=>signedIn?{id:'mentor-1'}:null,fullProfile:async()=>({role}),rows:async()=>[]};
  const ai={askJSON:async()=>{paidCalls++;if(failure)throw Error('provider');return {amount,explanation:'Based on your services.'};}};
  const context={module:{exports:{}},require:n=>n==='./_mail'?mail:n==='./_ai'?ai:n==='../pricing'?P:n==='crypto'?require('crypto'):{},process:{env:{}},console};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../api/agents.js'),'utf8'),context);
  const res={code:0,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  return {res,paidCalls:()=>paidCalls,run:()=>context.module.exports({method:'POST',headers:{authorization:'Bearer test'},body:{task:'price_recommend',services:['interview_prep'],years:0}},res)};
}
test('price AI authenticates mentors and never calls provider for visitors or clients',async()=>{
  for(const opts of [{signedIn:false},{role:'client'}]){const h=harness(opts);await h.run();assert.ok([401,403].includes(h.res.code));assert.equal(h.paidCalls(),0);}
});
test('price AI clamps its amount and truthfully falls back on provider failure',async()=>{
  const ok=harness();await ok.run();assert.equal(ok.res.code,200);assert.equal(ok.res.body.amount,45);assert.equal(ok.res.body.ai,true);
  const fail=harness({failure:true});await fail.run();assert.equal(fail.res.code,200);assert.equal(fail.res.body.amount,40);assert.equal(fail.res.body.ai,false);
});
test('changing services refreshes the recommendation without overwriting a custom price',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
  const source=html.slice(html.indexOf('function wireRateWidgets(){'),html.indexOf('function getPackages()'));
  const node=value=>({value,textContent:'',innerHTML:'',style:{setProperty(){}},handlers:{},addEventListener(k,fn){this.handlers[k]=fn;},dispatchEvent(){}});
  const nodes={'.rate-w-range':node('55'),'input[type="hidden"]':node('55'),'.rate-number':node('55'),'.rate-w-val b':node(),'.rate-earnings':node(),'.rate-w-preview':node(),'.rate-rec-amount':node(),'.rate-rec-range':node(),'.rate-rec-source':node(),'.rate-ai-explanation':node(),'.rate-w-sug':node(),'.rate-ai':node()};
  nodes['.rate-w-range'].max='300';const check=node('interview_prep');check.checked=false;
  const w={dataset:{min:'30',years:'0'},querySelector:s=>nodes[s],querySelectorAll:s=>s.endsWith(':checked')?(check.checked?[check]:[]):[check]};
  const context={document:{querySelectorAll:()=>[w],querySelector:()=>null,getElementById:()=>null},window:{},WorkarPricing:P,uid:'mentor',myProfile:null,cache:{profiles:{}},state:{lang:'en'},pricingText:a=>a,mentorSharePct:()=>70,getPackages:()=>[],esc:a=>a,T:a=>a,Event:function(){}};
  vm.createContext(context);vm.runInContext(source,context);context.wireRateWidgets();
  check.checked=true;check.handlers.change();
  assert.equal(nodes['.rate-rec-amount'].textContent,'$40 CAD');assert.equal(nodes['input[type="hidden"]'].value,55);
  nodes['.rate-w-sug'].handlers.click();assert.equal(nodes['input[type="hidden"]'].value,40);
});
