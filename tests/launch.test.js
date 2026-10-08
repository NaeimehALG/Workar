const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function checkout({signedIn=true, owner='client', status='accepted', paid=false, fail=false}={}) {
  const calls=[];
  const ctx={module:{exports:{}}, process:{env:{STRIPE_SECRET_KEY:'test',SUPABASE_SERVICE_ROLE_KEY:'test',SUPABASE_URL:'https://example.test'}}, URL,URLSearchParams,
    require:()=>({userFromToken:async token=>signedIn && token==='test-token'?{id:'client'}:null}),
    fetch:async(url,opts)=>{calls.push({url,opts}); let data=[];
      if(url.includes('stripe.com')) data={url:'https://checkout.stripe.com/test'};
      if(url.includes('/requests?')) data=[{clientId:owner,status,paid,mentorId:'mentor',packageKey:'single'}];
      if(url.includes('/profiles?')) data=[{sessionRate:60}];
      return {ok:!fail || url.includes('stripe.com'),json:async()=>data};
    }};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,'api/create-checkout.js'),'utf8'),ctx);
  return {calls, async run(extra={}){const res={status(code){this.code=code;return this},json(body){this.body=body;return this}};
    await ctx.module.exports({method:'POST',headers:{authorization:'Bearer test-token'},body:{requestId:'booking',amountCents:1,successUrl:'https://www.workar.me/?paid=booking',cancelUrl:'https://www.workar.me/?payment=cancelled',...extra}},res);return res;}};
}
test('checkout rejects signed-out, other-client, pending and already-paid bookings before Stripe',async()=>{
  for(const [options,code] of [[{signedIn:false},401],[{owner:'someone-else'},403],[{status:'pending'},409],[{paid:true},400]]){
    const h=checkout(options),res=await h.run();assert.equal(res.code,code);assert.equal(h.calls.some(c=>c.url.includes('stripe.com')),false);
  }
});
test('checkout ignores browser amount and calculates mentor rate on server',async()=>{
  const h=checkout();assert.equal((await h.run()).code,200);
  const stripe=h.calls.find(c=>c.url.includes('stripe.com'));
  assert.equal(new URLSearchParams(stripe.opts.body).get('line_items[0][price_data][unit_amount]'),'6000');
});
test('checkout fails closed on database errors and external return URLs',async()=>{
  for(const [options,extra,code] of [[{fail:true},{},503],[{},{successUrl:'https://attacker.test/'},400],[{},{kind:'ai_credits',userId:'someone-else'},403]]){
    const h=checkout(options);assert.equal((await h.run(extra)).code,code);assert.equal(h.calls.some(c=>c.url.includes('stripe.com')),false);
  }
});
test('AI purchases are bound to authenticated account and fixed price',async()=>{
  const h=checkout();assert.equal((await h.run({kind:'ai_credits',userId:'client'})).code,200);
  const params=new URLSearchParams(h.calls.find(c=>c.url.includes('stripe.com')).opts.body);
  assert.equal(params.get('metadata[userId]'),'client');assert.equal(params.get('line_items[0][price_data][unit_amount]'),'499');
});
const meeting=require('../api/_meeting');
test('calendar export preserves UTC start/end and reminders across DST',()=>{
  const r={id:'booking',startsAt:'2026-11-01T01:30:00-07:00'};
  const ics=meeting.buildIcs({r,title:'Session',description:'Details',url:'https://meet.jit.si/room'});
  assert.match(ics,/DTSTART:20261101T083000Z/);assert.match(ics,/DTEND:20261101T091500Z/);
  assert.match(ics,/TRIGGER:-PT60M/);assert.match(ics,/TRIGGER:-PT15M/);
  assert.equal(new URL(meeting.googleCalendarLink({r,title:'Session',description:'Details'})).searchParams.get('dates'),'20261101T083000Z/20261101T091500Z');
});
test('Persian calendar text folds within UTF-8 limits and cannot inject an event',()=>{
  const ics=meeting.buildIcs({r:{id:'booking',startsAt:'2026-10-08T00:00:00Z'},title:'مشاوره 👩'.repeat(25),description:'hello\rBEGIN:VEVENT\r\nnew',url:'https://meet.jit.si/room'});
  assert.equal(ics.split('\r\n').filter(l=>l==='BEGIN:VEVENT').length,1);
  for(const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line)<=75);
  assert.ok(!ics.includes('\uFFFD'));
  const unfolded=ics.replace(/\r\n /g,'');assert.ok(unfolded.includes('SUMMARY:'+'مشاوره 👩'.repeat(25)));
});
test('invalid dates do not crash calendar downloads or create cancellation alarms',()=>{
  const input={r:{id:'booking',startsAt:'invalid'},title:'Session',description:''};
  assert.equal(meeting.buildIcs(input),null);assert.equal(meeting.googleCalendarLink(input),null);
  const cancelled=meeting.buildIcs({...input,r:{id:'booking',startsAt:'2026-10-08T00:00:00Z'},cancelled:true});
  assert.match(cancelled,/STATUS:CANCELLED/);assert.ok(!cancelled.includes('VALARM'));
});
function prejoinHarness(){
  const elements={}, requests=[], pending=[]; let active=null;
  const make=()=>({style:{},classList:{toggle(){}},setAttribute(){},getTracks(){return[]},querySelectorAll(){return[]},addEventListener(){},focus(){active=this},remove(){delete elements['pj-back']}});
  const ctx={uid:'client',cache:{requests:[{id:'booking',clientId:'client',mentorId:'mentor',status:'accepted',paid:true}]},myProfile:{name:'Client'},reqStage:()=>2,
    nameOf:()=> 'Mentor',av:()=>'',esc:s=>s,T:s=>s,SESSION_MIN:45,Date,
    document:{getElementById:id=>elements[id]||null,createElement:make,body:{appendChild(el){elements['pj-back']=el;for(const id of ['pj-join','pj-cancel','pj-mic','pj-cam','pj-video','pj-msg','pj-when']) elements[id]=make();}},addEventListener(){},removeEventListener(){},get activeElement(){return active}},
    navigator:{mediaDevices:{getUserMedia:constraints=>{requests.push(constraints);return new Promise((resolve,reject)=>pending.push({resolve,reject}));}}},window:{},setInterval:()=>1,clearInterval(){},cancelAnimationFrame(){},requestAnimationFrame:()=>1};
  vm.createContext(ctx);vm.runInContext(html.slice(html.indexOf('const PJ_IC ='),html.indexOf("document.addEventListener('click', e=>{\n  const b = e.target.closest ? e.target.closest('[data-call]')")),ctx);
  return {ctx,requests,pending};
}
function stream(){const track={stopped:false,stop(){this.stopped=true}};return {track,getTracks:()=>[track],getAudioTracks:()=>[],getVideoTracks:()=>[],addTrack(){}};}
test('closing call preview releases a camera request that finishes later',async()=>{
  const h=prejoinHarness(),opening=h.ctx.openPrejoin('booking','','video');h.ctx.pjClose();const s=stream();h.pending[0].resolve(s);await opening;assert.equal(s.track.stopped,true);
});
test('opening voice preview while old video permission loads cannot overwrite its stream',async()=>{
  const h=prejoinHarness(),first=h.ctx.openPrejoin('booking','','video'),second=h.ctx.openPrejoin('booking','','voice');
  assert.equal(h.requests[0].video,true);assert.equal(h.requests[1].video,false);
  const voice=stream();h.pending[1].resolve(voice);await second;const old=stream();h.pending[0].resolve(old);await first;
  assert.equal(old.track.stopped,true);assert.equal(voice.track.stopped,false);h.ctx.pjClose();assert.equal(voice.track.stopped,true);
});
test('call preview never asks for devices for a nonparticipant or unknown booking',async()=>{
  const h=prejoinHarness();h.ctx.uid='outsider';await h.ctx.openPrejoin('booking','','video');assert.equal(h.requests.length,0);
  h.ctx.uid='client';await h.ctx.openPrejoin('missing','','voice');assert.equal(h.requests.length,0);
});
function ticketHarness({saved=true,delivered=true,confirmed=true}={}){
  const source=fs.readFileSync(path.join(root,'api/agents.js'),'utf8');let n=0;
  const ctx={crypto:require('node:crypto'),process:{env:{SUPABASE_URL:'https://example.test'}},console:{error(){}},CAT_LABEL:{},
    fetch:async()=>({ok:saved}),M:{esc:s=>s,layout:()=>'',list:()=>'',sendMail:async()=>({ok:++n===1?delivered:confirmed})}};
  vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('async function createTicket('),source.indexOf('async function help(')),ctx);
  return ()=>ctx.createTicket({summary:'Camera problem'},{id:'client',email:'client@example.test'},null,[{role:'user',content:'Help'}]);
}
test('support never reports success when storage and team delivery both fail',async()=>{
  assert.equal((await ticketHarness({saved:false,delivered:false})()).ok,false);
});
test('support reports confirmation failure accurately while preserving a saved reference',async()=>{
  const result=await ticketHarness({confirmed:false})();assert.equal(result.ok,true);assert.equal(result.confirmationSent,false);assert.match(result.id,/^WK-[A-F0-9]{12}$/);
});
test('dashboard calendar links are shared by participants and hidden for unpaid or unrelated bookings',()=>{
  const source=html.slice(html.indexOf('function bookingCalendarData('),html.indexOf("document.addEventListener('click', e=>{\n  const button=e.target.closest"));
  const ctx={uid:'client',reqStage:r=>r.paid?2:1,reqInstant:r=>new Date(r.startsAt),nameOf:()=> 'نام منتور',SESSION_MIN:45,URLSearchParams,TextEncoder,Date};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  const r={id:'booking',mentorId:'mentor',clientId:'client',status:'accepted',paid:true,startsAt:'2026-10-08T01:00:00Z',meetingUrl:'https://meet.jit.si/room'};
  const event=ctx.bookingCalendarData(r);assert.equal(event.dates,'20261008T010000Z/20261008T014500Z');
  assert.match(ctx.bookingCalendarIcs(r,event),/DTSTART:20261008T010000Z/);
  ctx.uid='mentor';assert.ok(ctx.bookingCalendarData(r));ctx.uid='outsider';assert.equal(ctx.bookingCalendarData(r),null);
  ctx.uid='client';assert.equal(ctx.bookingCalendarData({...r,paid:false}),null);
});
test('payment webhook returns a retryable error when database rejects payment writes',async()=>{
  const crypto=require('node:crypto');
  const source=fs.readFileSync(path.join(root,'api/stripe-webhook.js'),'utf8');
  const payload=JSON.stringify({type:'checkout.session.completed',data:{object:{id:'cs_test',payment_status:'paid',metadata:{kind:'booking',requestId:'booking'}}}});
  const t=Math.floor(Date.now()/1000),sig=crypto.createHmac('sha256','test-secret').update(t+'.'+payload).digest('hex');
  const ctx={module:{exports:{}},require:name=>{if(name==='crypto')return crypto;if(name==='./_credits')return {};throw new Error('Confirmation must not run after failed payment write');},process:{env:{STRIPE_WEBHOOK_SECRET:'test-secret',SUPABASE_URL:'https://example.test',SUPABASE_SERVICE_ROLE_KEY:'test'}},console:{error(){}},Buffer,Date,fetch:async()=>({ok:false})};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  const req={method:'POST',headers:{'stripe-signature':`t=${t},v1=${sig}`},on(event,cb){if(event==='data')cb(payload);if(event==='end')cb();}};
  const res={status(code){this.code=code;return this},json(body){this.body=body;return this}};
  await ctx.module.exports(req,res);assert.equal(res.code,500);assert.equal(res.body.error,'update-failed');
});

