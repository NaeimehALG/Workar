(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkarPricing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  const SERVICES = [
    ['job_search_strategy','Job-search strategy','راهبرد جست‌وجوی کار'],
    ['newcomer_career_start','Starting a career in Canada','شروع مسیر کاری در کانادا'],
    ['career_switch','Career change','تغییر مسیر شغلی'],
    ['interview_prep','Interview practice','تمرین مصاحبه'],
    ['resume_review','Resume feedback','بازخورد رزومه'],
    ['linkedin_and_networking','LinkedIn & networking','لینکدین و شبکه‌سازی'],
    ['salary_negotiation','Salary negotiation','مذاکره حقوق'],
    ['promotion_and_growth','Career growth','رشد شغلی'],
    ['leadership','Leadership','رهبری'],
    ['certification_prep','Certification guidance','راهنمایی مدارک حرفه‌ای'],
    ['portfolio_review','Portfolio feedback','بازخورد نمونه‌کار']
  ];
  function services(list){ return [...new Set((Array.isArray(list)?list:[]).filter(k=>SERVICES.some(s=>s[0]===k)))]; }
  function recommend(input = {}, peers = []){
    const min = Math.max(30, Number(input.minimum)||30);
    const round = v=>Math.round(v/5)*5;
    const selected = services(input.services);
    const years = Math.max(0,Math.min(60,Number(input.years)||0));
    const practice = selected.some(s=>['interview_prep','salary_negotiation','leadership'].includes(s))?10:0;
    const review = selected.some(s=>['resume_review','linkedin_and_networking','portfolio_review','certification_prep'].includes(s))?5:0;
    const experience = years>=15?10:years>=8?5:0;
    const starting = round(min+practice+review+experience);
    const band = y=>Number(y)>=15?2:Number(y)>=8?1:0;
    const comparable = peers.filter(p=>p.id!==input.id && p.role==='mentor' && p.approved===true && input.field && p.field===input.field && band(p.experience)===band(years) && (!selected.length || services(p.helpsWith).some(k=>selected.includes(k))))
      .map(p=>Number(p.sessionRate)).filter(v=>Number.isFinite(v)&&v>=min&&v<=300).sort((a,b)=>a-b);
    const market = comparable.length>=5;
    const median = market?(comparable[Math.floor((comparable.length-1)/2)]+comparable[Math.floor(comparable.length/2)])/2:starting;
    const amount = Math.max(min,round(market?Math.max(starting-10,Math.min(starting+10,median)):starting));
    return {amount,low:Math.max(min,amount-5),high:amount+5,services:selected,source:market?'comparable-listings':'starting-guidance',comparableCount:comparable.length,minimum:min};
  }
  function boundedAIAmount(value, recommendation){
    const n=Number(value);
    return Number.isFinite(n)?Math.max(recommendation.low,Math.min(recommendation.high,Math.round(n/5)*5)):recommendation.amount;
  }
  return {SERVICES,services,recommend,boundedAIAmount};
});
