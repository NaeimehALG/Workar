// Builds a 1080x1350 Instagram slide: illustration, kicker + headline on top, Workar logo bottom centre.
const { chromium } = require('playwright'); const fs = require('fs');
const logo = JSON.parse(fs.readFileSync('logo.json'));
const slides = JSON.parse(fs.readFileSync(process.argv[2]));
(async () => {
  const b = await chromium.launch(); 
  for (const s of slides) {
    const H = s.story ? 1920 : 1350; const p = await b.newPage({ viewport: { width: 1080, height: H }, deviceScaleFactor: 1 });
    if (!fs.existsSync(s.bg)) { console.log('skip', s.out); continue; }
    const bg = 'data:image/png;base64,' + fs.readFileSync(s.bg).toString('base64');
    const font = 'data:font/woff2;base64,' + fs.readFileSync('inter.woff2').toString('base64');
    await p.setContent(`<html><head><style>
      @font-face{font-family:Inter;src:url(${font}) format('woff2');font-weight:100 900;}
      html,body{margin:0;background:#FAF3EA;width:1080px;height:${H}px;overflow:hidden;font-family:Inter,sans-serif;}
      .bg{position:absolute;inset:${s.story?'120px 0 0 0':'0'};background:url(${bg}) center ${s.pos||'60%'}/cover no-repeat;}
      .top{position:absolute;inset:0 0 auto 0;height:${s.story?900:560}px;background:linear-gradient(180deg,rgba(250,243,234,.92) 0%,rgba(250,243,234,.72) 55%,rgba(250,243,234,0) 100%);}
      .bot{position:absolute;inset:auto 0 0 0;height:${s.story?420:260}px;background:linear-gradient(0deg,rgba(250,243,234,.95) 0%,rgba(250,243,234,.75) 45%,rgba(250,243,234,0) 100%);}
      .txt{position:absolute;left:84px;right:84px;top:${s.story?330:100}px;}
      .k{margin:0 0 22px;font-size:24px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:#9B7A55;}
      h1{margin:0;font-size:${s.size||(s.story?76:66)}px;text-wrap:balance;line-height:1.12;font-weight:700;letter-spacing:-.022em;color:#4A3526;max-width:880px;}
      .sub{margin:22px 0 0;font-size:${s.story?36:30}px;font-weight:500;color:#6B4F3A;}
      .logo{position:absolute;left:50%;bottom:${s.story?150:54}px;width:150px;transform:translateX(-50%);}
      .logo svg{display:block;width:100%;fill:#8B6A4C;}
      .n{position:absolute;right:60px;bottom:66px;font-size:22px;font-weight:600;color:#9B7A55;letter-spacing:.08em;}
    </style></head><body>
      <div class="bg"></div><div class="top"></div><div class="bot"></div>
      <div class="txt"><p class="k">${s.kicker}</p><h1>${s.title}</h1>${s.sub ? `<p class="sub">${s.sub}</p>` : ''}</div>
      <div class="logo"><svg viewBox="0 0 556 410"><g transform="translate(125,0)"><path d="${logo.mark}" fill-rule="evenodd"/></g><g transform="translate(0,312)"><path d="${logo.word}" fill-rule="evenodd"/></g></svg></div>
      ${s.n ? `<div class="n">${s.n}</div>` : ''}
    </body></html>`);
    await p.waitForTimeout(300);
    await p.screenshot({ path: s.out, type: 'jpeg', quality: 93 });
    await p.close(); console.log('made', s.out);
  }
  await b.close();
})();
