const { chromium } = require('playwright'); const fs = require('fs');
const logo = JSON.parse(fs.readFileSync('logo.json'));
const font = 'data:font/woff2;base64,' + fs.readFileSync('inter.woff2').toString('base64');
const svg = `<svg viewBox="0 0 556 410"><g transform="translate(125,0)"><path d="${logo.mark}" fill-rule="evenodd"/></g><g transform="translate(0,312)"><path d="${logo.word}" fill-rule="evenodd"/></g></svg>`;
const scenes = JSON.parse(fs.readFileSync(process.argv[2]));
(async () => {
  const b = await chromium.launch();
  for (const s of scenes) {
    const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
    const end = s.end;
    await p.setContent(`<html><head><style>
      @font-face{font-family:Inter;src:url(${font}) format('woff2');font-weight:100 900;}
      html,body{margin:0;background:${end?'#FAF3EA':'transparent'};width:1080px;height:1920px;overflow:hidden;font-family:Inter,sans-serif;}
      .top{position:absolute;inset:0 0 auto 0;height:980px;background:linear-gradient(180deg,rgba(250,243,234,.95) 0%,rgba(250,243,234,.8) 55%,rgba(250,243,234,0) 100%);}
      .bot{position:absolute;inset:auto 0 0 0;height:420px;background:linear-gradient(0deg,rgba(250,243,234,.95) 0%,rgba(250,243,234,.7) 45%,rgba(250,243,234,0) 100%);}
      .txt{position:absolute;left:84px;right:84px;top:300px;}
      .k{margin:0 0 24px;font-size:28px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:#9B7A55;}
      h1{margin:0;font-size:${s.size||84}px;text-wrap:balance;line-height:1.1;font-weight:700;letter-spacing:-.022em;color:#4A3526;}
      .sub{margin:26px 0 0;font-size:40px;font-weight:500;color:#6B4F3A;line-height:1.3}
      .logo{position:absolute;left:50%;bottom:170px;width:150px;transform:translateX(-50%);} .logo svg{display:block;width:100%;fill:#8B6A4C;}
      .end{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;}
      .end .lg{width:360px} .end .lg svg{width:100%;fill:#8B6A4C;display:block}
      .end h2{margin:70px 0 0;font-size:88px;font-weight:700;color:#4A3526;letter-spacing:-.02em}
      .end p{margin:22px 0 0;font-size:40px;font-weight:500;color:#6B4F3A}
    </style></head><body>${end ? `<div class="end"><div class="lg">${svg}</div><h2>workar.me</h2><p>${s.sub}</p></div>` :
      `<div class="top"></div><div class="bot"></div><div class="txt"><p class="k">${s.kicker}</p><h1>${s.title}</h1>${s.sub?`<p class="sub">${s.sub}</p>`:''}</div><div class="logo">${svg}</div>`}</body></html>`);
    await p.waitForTimeout(300);
    await p.screenshot({ path: s.out, omitBackground: !end });
    await p.close(); console.log('made', s.out);
  }
  await b.close();
})();
