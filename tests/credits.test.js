const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
function harness({fail=false, invalidResponse=false}={}) {
  const calls = [], receipts = new Map();
  let balance = 5;
  const env = {SUPABASE_URL:'https://database.test',SUPABASE_SERVICE_ROLE_KEY:'service-test',STRIPE_WEBHOOK_SECRET:'signature-test'};
  const fetch = async (url, options) => {
    calls.push({url, options});
    if (fail) return {ok:false};
    const b = JSON.parse(options.body);
    // Database contract model; actual SQL is tested separately against PostgreSQL.
    if (!receipts.has(b.p_session_id)) {
      receipts.set(b.p_session_id,b); balance += b.p_credits;
      return {ok:true,json:async()=>invalidResponse ? null : {applied:true}};
    }
    return {ok:true,json:async()=>({applied:false})};
  };
  const creditContext = {module:{exports:{}},process:{env},fetch};
  vm.createContext(creditContext);
  vm.runInContext(fs.readFileSync(path.join(root,'api/_credits.js'),'utf8'),creditContext);
  const context = {module:{exports:{}},process:{env},Buffer,Date,console:{error(){}},
    require:name=>name==='crypto'?crypto:creditContext.module.exports,
    fetch:async()=>{throw new Error('Credit fulfillment must use the transaction RPC');}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root,'api/stripe-webhook.js'),'utf8'),context);
  return {calls, get balance(){return balance;}, async run({type='checkout.session.completed',payment_status='paid',id='cs_purchase',metadata={kind:'ai_credits',userId:'user',credits:'20'},badSignature=false}={}) {
    const payload=JSON.stringify({id:crypto.randomUUID(),type,data:{object:{id,payment_status,metadata}}});
    const t=Math.floor(Date.now()/1000);
    const sig=crypto.createHmac('sha256','signature-test').update(t+'.'+payload).digest('hex');
    const req={method:'POST',headers:{'stripe-signature':`t=${t},v1=${badSignature?'bad':sig}`},
      on(event,cb){if(event==='data')cb(payload);if(event==='end')cb();}};
    const res={status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await context.module.exports(req,res);return res;
  }};
}
test('signed retries and both event types use the same session key',async()=>{
  const h=harness();
  for(const options of [{},{},{type:'checkout.session.async_payment_succeeded'}]) {
    assert.equal((await h.run(options)).code,200);
  }
  assert.equal(h.balance,25);
  for(const call of h.calls) {
    assert.equal(call.url,'https://database.test/rest/v1/rpc/grant_ai_credit_purchase');
    assert.equal(call.options.method,'POST');
    assert.equal(call.options.headers.Authorization,'Bearer service-test');
    assert.deepEqual(JSON.parse(call.options.body),{p_session_id:'cs_purchase',p_user_id:'user',p_credits:20});
  }
});
test('simultaneous callbacks delegate deduplication to the database',async()=>{
  const h=harness();
  const results=await Promise.all(Array.from({length:20},()=>h.run()));
  assert.ok(results.every(r=>r.code===200));
  assert.equal(h.balance,25);
});
test('different purchases add credits independently',async()=>{
  const h=harness();await h.run();await h.run({id:'cs_other'});
  assert.equal(h.balance,45);
});
test('unpaid, missing-payment-status and unrelated events do not grant credits',async()=>{
  const h=harness();
  for(const opts of [{payment_status:'unpaid'},{payment_status:null},{type:'checkout.session.expired'}])
    assert.equal((await h.run(opts)).code,200);
  assert.equal(h.calls.length,0);
});
test('invalid signature never calls the credit store',async()=>{
  const h=harness();assert.equal((await h.run({badSignature:true})).code,400);
  assert.equal(h.calls.length,0);
});
test('malformed purchase metadata cannot become a default credit grant or booking',async()=>{
  for(const metadata of [{kind:'ai_credits',credits:'20'},{kind:'ai_credits',userId:'user'},
    ...['0','-1','1.5','NaN','10001'].map(credits=>({kind:'ai_credits',userId:'user',credits}))]) {
    const h=harness();assert.equal((await h.run({metadata})).code,500);assert.equal(h.calls.length,0);
  }
});
test('failed transactions and malformed RPC acknowledgments remain retryable',async()=>{
  for(const options of [{fail:true},{invalidResponse:true}]) {
    const h=harness(options);assert.equal((await h.run()).code,500);
  }
});
test('AI debits use the latest database balance and do not overwrite a purchase',async()=>{
  let balance=2, debits=0;
  const context={module:{exports:{}},process:{env:{ANTHROPIC_API_KEY:'test'}},
    require:name=> name==='./_mail'?{
      userFromToken:async()=>({id:'user',email:'user@example.test'}),
      rows:async()=>[{aiCredits:balance}],
      patch:async()=>{throw Error('Cannot overwrite balance');}
    }: name==='./_ai'?{
      callClaude:async()=>{balance+=20;return {};},textOf:()=> 'Reply'
    }:{
      consume:async()=>{debits++;return --balance;}
    }};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'api/ai.js'),'utf8'),context);
  const res={status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await context.module.exports({method:'POST',headers:{authorization:'Bearer test'},body:{prompt:'Help'}},res);
  assert.equal(res.code,200);assert.equal(res.body.aiCreditsRemaining,21);assert.equal(debits,1);
});
test('AI requests losing a race for the last credit do not return a free reply',async()=>{
  const context={module:{exports:{}},process:{env:{ANTHROPIC_API_KEY:'test'}},require:name=>
    name==='./_mail'?{userFromToken:async()=>({id:'user'}),rows:async()=>[{aiCredits:1}]}:
    name==='./_ai'?{callClaude:async()=>({}),textOf:()=> 'Reply'}:{consume:async()=>null}};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'api/ai.js'),'utf8'),context);
  const res={status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await context.module.exports({method:'POST',headers:{},body:{prompt:'Help'}},res);
  assert.equal(res.code,402);assert.equal(res.body.text,undefined);
});
