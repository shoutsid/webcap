/**
 * GET / — the product landing page. Radically simplified for conversion:
 * Hero → Preview → Features → Pricing → Buy. No newsletter or resource
 * sections. Every section either demonstrates value or drives conversion.
 */
import { DEFAULT_BAZAAR_CATALOG_URL, USDC_SCALE, WATCH_TOPUP_RUNS, watchTopUpPriceUsdcUnits, type WebcapConfig } from '../../config.js';
import { footer, termBar, topBar } from './chrome.js';
import { BASE_CSS, LANDING_CSS } from './css.js';
import { CHAIN_COPY } from './copy.js';
import { esc, usdUnits } from './format.js';

export function landingHtml(config: WebcapConfig): string {
  const base = config.publicBaseUrl;
  const bazaarCatalogUrl = config.bazaarCatalogUrl ?? DEFAULT_BAZAAR_CATALOG_URL;
  const copy = CHAIN_COPY[config.chain.name];
  const capturePrice = usdUnits(config.x402PriceUsdcUnits);
  const extractPrice = usdUnits(config.x402ExtractPriceUsdcUnits);
  const topUpUsd = (usdcUnits: number): string => `$${(usdcUnits / USDC_SCALE).toFixed(2)}`;
  const captureTopUpPrice = topUpUsd(watchTopUpPriceUsdcUnits('capture', config));
  const extractTopUpPrice = topUpUsd(watchTopUpPriceUsdcUnits('extract', config));
  const stripeConfigured = !!config.stripeSecretKey;

  const curlFlow = `<span class="c"># Capture any URL as PNG, JPEG, or PDF</span>
curl -X POST "${base}/v1/x402/capture" \\
  -H <span class="s">'content-type: application/json'</span> \\
  -d <span class="s">'{"url":"https://example.com/"}'</span>
<span class="ok">\u2192 200</span> {"artifact":{"format":"png","bytes":48291}}

<span class="c"># Extract structured data \u2014 title, headings, links, markdown</span>
curl -X POST "${base}/v1/x402/extract" \\
  -H <span class="s">'content-type: application/json'</span> \\
  -d <span class="s">'{"urls":["https://example.com/"]}'</span>
<span class="ok">\u2192 200</span> {"results":[{"url":"https://example.com/",
      "title":"Example Domain","markdown":"# Example Domain\\n..."}]}

<span class="c"># Free preview \u2014 no payment needed</span>
curl "${base}/v1/extract/preview?url=https://example.com/"
<span class="ok">\u2192 200</span> {"title":"Example Domain","wordCount":123}
<div class="term-note"><span class="c">How to pay:</span> x402 micropayments (USDC on Base, gasless). Free preview: <code>${base}/v1/extract/preview?url=...</code></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>webcap \u2014 web capture API \u2014 screenshots \u2014 extraction \u2014 monitoring</title>
<meta name="description" content="Screenshot any URL. Extract structured data. Monitor for changes. Developer API with pay-per-call pricing \u2014 no API keys, no accounts.">
<!-- Open Graph / Facebook -->
<meta property="og:type" content="website">
<meta property="og:url" content="${base}">
<meta property="og:title" content="webcap \u2014 web capture API \u2014 screenshots \u2014 extraction \u2014 monitoring">
<meta property="og:description" content="Screenshot any URL. Extract structured data. Monitor for changes. Developer API with pay-per-call pricing \u2014 no API keys, no accounts.">
<meta property="og:image" content="${base}/icon.png">
<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="webcap \u2014 web capture API \u2014 screenshots \u2014 extraction \u2014 monitoring">
<meta name="twitter:description" content="Screenshot any URL. Extract structured data. Monitor for changes. Developer API with pay-per-call pricing \u2014 no API keys, no accounts.">
<meta name="twitter:image" content="${base}/icon.png">
<link rel="canonical" href="${base}">
<link rel="icon" href="/icon.png">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebAPI",
  "name": "webcap",
  "description": "Web capture API: screenshot any URL as PNG/JPEG/PDF, extract structured data (title, headings, links, markdown), and monitor for changes with webhook alerts. Pay per call, no accounts needed.",
  "url": "${base}",
  "documentation": "${base}/openapi.json",
  "provider": {
    "@type": "Organization",
    "name": "webcap"
  },
  "offers": [
    {
      "@type": "Offer",
      "name": "Capture",
      "description": "Screenshot as PNG/JPEG/PDF + free OG metadata",
      "price": "0.001",
      "priceCurrency": "USD"
    },
    {
      "@type": "Offer",
      "name": "Extract",
      "description": "Structured text/JSON extraction from URLs",
      "price": "0.01",
      "priceCurrency": "USD"
    }
  ]
}
</script>
<style>${BASE_CSS}${LANDING_CSS}</style>
</head>
<body>
<script>
try{
  navigator.sendBeacon('/v1/track',new Blob([JSON.stringify({event:'landing_view',meta:{referrer:document.referrer||'direct'}})],{type:'application/json'}));
}catch(ex){}
</script>
${topBar(bazaarCatalogUrl, 'landing')}

<!-- ═══════════════════════════════════════════════════════════════
     HERO: ONE outcome, ONE CTA, ONE screenshot
     ═══════════════════════════════════════════════════════════════ -->
<main>
  <section class="hero wrap">
    <div class="hero-inner">
      <div>
        <p class="kicker"><span class="rec">\u25CF</span> ${copy.kicker}</p>
        <h1>Screenshot any URL.<br><span class="hl">Extract data. Monitor changes.</span></h1>
        <p class="lede">${copy.lede}</p>
        <div class="cta-row">
          <a class="btn" href="#preview">Try it free \u2193</a>
          <a class="btn ghost" href="https://github.com/shoutsid-lab/webcap" target="_blank" rel="noopener">\u{1F4BB} GitHub</a>
        </div>
        <div class="social-proof" id="social-proof"><span class="proof-icon">\u{1F7E2}</span> <span id="proof-text">Live metrics loading\u2026</span></div>
      </div>
      <div class="term" aria-label="curl example of the webcap API">
        ${termBar('webcap in action \u2014 screenshots, data, monitoring')}
        <pre><code>${curlFlow}</code></pre>
      </div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════
       SOCIAL PROOF: Trust signals immediately below fold
       ═══════════════════════════════════════════════════════════════ -->
  <section class="section wrap" id="proof">
    <div class="trust-bar">
      <div class="trust-item">
        <span class="trust-num" id="proof-captures">--</span>
        <span class="trust-label">Captures</span>
      </div>
      <div class="trust-item">
        <span class="trust-num" id="proof-extracts">--</span>
        <span class="trust-label">Extracts</span>
      </div>
      <div class="trust-item">
        <span class="trust-num">No API keys</span>
        <span class="trust-label">Required</span>
      </div>
      <div class="trust-item">
        <span class="trust-num">No accounts</span>
        <span class="trust-label">Needed</span>
      </div>
      <div class="trust-item">
        <span class="trust-num">Pay per call</span>
        <span class="trust-label">Card or crypto</span>
      </div>
    </div>
    <!-- Trust record ids 46929 (capture) / 46928 (extract) used to be embedded
         here as badge images. The kkj x402 Trust Index keys a record to the
         resource URL, and those two were observed against the pre-cutover
         ngrok host — after the domain cutover they advertised evidence for a
         domain we no longer serve, so they came out (with the .trust-strip
         rules in css.ts). The index derives its listings from the CDP Bazaar,
         which indexes a URL only after a paid call settles there, so re-add the
         badges with the new ids only once the index lists
         WEBCAP_PUBLIC_BASE_URL (see docs/operations/domain-cutover.md). -->
    <p class="hint" style="margin-top:var(--s3)">Independently observed trust: the third-party
      <a href="https://5.75.142.199.sslip.io/x402/best" target="_blank" rel="noopener">kkj x402 Trust Index</a>
      observes this service with live probes and signed evidence (observed, not a guarantee).
      Its records are keyed to the resource URL and derived from the CDP Bazaar, so this domain gets
      its own record once a paid call settles here.</p>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════
       INTERACTIVE PREVIEW: Try before you buy
       ═══════════════════════════════════════════════════════════════ -->
  <section class="section wrap" id="preview">
    <p class="eyebrow">Try it free</p>
    <h2>Extract any URL instantly</h2>
    <p class="hint">Paste a URL and see what webcap extracts \u2014 title, headings, links, markdown. Free: <code>GET /v1/extract/preview</code>. Full data: $0.01.</p>
    <div class="preview-cta">
      <form class="preview-form" id="preview-form">
        <div class="url-row">
          <input type="url" id="preview-url-input" name="url" inputmode="url" autocomplete="url"
            value="https://example.com/" placeholder="Paste any URL\u2026" required aria-label="URL to preview">
          <button class="btn" type="submit" id="preview-btn" data-no-track>Extract data \u2197</button>
        </div>
        <p class="form-note">No sign-up needed. Results appear below instantly. Full API: $0.01 per batch of 50 URLs. <strong>Pay with crypto (USDC on Base) \u2014 gasless, instant.</strong> <a href="/quickstart">Payment guide \u2197</a></p>
        <div class="quick-try">
          <span class="quick-try-label">Try:</span>
          <button type="button" class="quick-try-btn" data-url="https://example.com/">example.com</button>
          <button type="button" class="quick-try-btn" data-url="https://en.wikipedia.org/wiki/Web_scraping">Wikipedia</button>
          <button type="button" class="quick-try-btn" data-url="https://developer.mozilla.org/en-US/docs/Web/HTTP">MDN Docs</button>
          <button type="button" class="quick-try-btn" data-url="https://github.com/shoutsid-lab/webcap">GitHub repo</button>
          <button type="button" class="quick-try-btn" data-url="https://docs.python.org/3/">Python Docs</button>
        </div>
      </form>
      <div id="preview-results" class="preview-results" hidden></div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════
       FEATURES: What you get (benefit-led, not architecture-led)
       ═══════════════════════════════════════════════════════════════ -->
  <section class="section wrap" id="features">
    <p class="eyebrow">What you get</p>
    <h2>Everything you need to capture the web</h2>
    <p class="hint">One API. Three capabilities. Pay only for what you use.</p>
    <div class="features-grid">
      <div class="feature-card">
        <div class="feature-icon">\u{1F4F7}</div>
        <h3>Capture</h3>
        <p>Screenshot any URL as PNG, JPEG, or PDF. Includes OG metadata for free.</p>
        <span class="feature-price">${esc(capturePrice)}/URL</span>
      </div>
      <div class="feature-card featured">
        <div class="feature-icon">\u{1F4CA}</div>
        <h3>Extract</h3>
        <p>Structured JSON: title, headings, links, paragraphs, markdown. Batch up to 50 URLs.</p>
        <span class="feature-price">${esc(extractPrice)}/batch</span>
      </div>
      <div class="feature-card">
        <div class="feature-icon">\u{1F514}</div>
        <h3>Monitor</h3>
        <p>Scheduled re-captures with webhook alerts. Detect any change, get notified.</p>
        <span class="feature-price">from ${esc(captureTopUpPrice)}/${WATCH_TOPUP_RUNS} runs</span>
      </div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════
       HOW IT WORKS: 3 clear steps
       ═══════════════════════════════════════════════════════════════ -->
  <section class="section wrap" id="how">
    <p class="eyebrow">How it works</p>
    <h2>3 steps. No sign-up.</h2>
    <ol class="steps">
      <li><b>Call the API.</b>
        <p>POST <code>/v1/x402/capture</code> or <code>/v1/x402/extract</code>. The server answers with a payment challenge.</p></li>
      <li><b>Pay.</b>
        <p>Pay with <strong>crypto (x402 USDC on Base)</strong> \u2014 instant, gasless, no accounts. Copy the command, paste in terminal, sign once. <a href="/quickstart">Payment guide</a>.</p></li>
      <li><b>Get your result.</b>
        <p>Instant response. Artifact served immediately. On-chain settlement for crypto payments.</p></li>
    </ol>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════
       PRICING: Transparent, simple
       ═══════════════════════════════════════════════════════════════ -->
  <section class="section wrap" id="pricing">
    <p class="eyebrow">Pricing</p>
    <h2>Pay per call. No accounts.</h2>
    <p class="hint">Flat per-call prices. Compute costs covered \u2014 you pay only
      for the capture, ${copy.settlement}. Pay with <strong>crypto (x402 USDC)</strong>. No minimums, no accounts. <a href="/buy">Buy credits</a>.</p>
    <div class="price-grid">
      <div class="price">
        <h3>Capture</h3>
        <div class="amount">${esc(capturePrice)} <small>/ URL</small></div>
        <p>PNG, JPEG or PDF screenshot. OG metadata is free: <code>GET /v1/og</code>.</p>
        <span class="tag">POST /v1/x402/capture</span>
      </div>
      <div class="price featured">
        <span class="flag">Most popular</span>
        <h3>Extract</h3>
        <div class="amount">${esc(extractPrice)} <small>/ URL batch</small></div>
        <p>Title, headings, links, markdown. Batch up to 50 URLs per payment.</p>
        <span class="tag">POST /v1/x402/extract</span>
      </div>
      <div class="price">
        <h3>Video</h3>
        <div class="amount">${esc(usdUnits(config.x402VideoPriceUsdcUnits))} <small>/ URL</small></div>
        <p>Full-page scroll capture as WebM video. For demos and archiving.</p>
        <span class="tag">POST /v1/x402/video</span>
      </div>
      <div class="price">
        <h3>Capture watch</h3>
        <div class="amount">${esc(captureTopUpPrice)} <small>/ ${WATCH_TOPUP_RUNS} runs</small></div>
        <p>${WATCH_TOPUP_RUNS} scheduled re-captures of a URL. Change-detection webhook on every diff.</p>
        <span class="tag">${WATCH_TOPUP_RUNS} × ${esc(capturePrice)} — POST /v1/x402/watches/topup</span>
      </div>
      <div class="price">
        <h3>Extract watch</h3>
        <div class="amount">${esc(extractTopUpPrice)} <small>/ ${WATCH_TOPUP_RUNS} runs</small></div>
        <p>${WATCH_TOPUP_RUNS} scheduled re-extractions (title, headings, links, markdown). Webhook on change.</p>
        <span class="tag">${WATCH_TOPUP_RUNS} × ${esc(extractPrice)} — POST /v1/x402/watches/topup</span>
      </div>
    </div>
    <p class="hint" style="margin-top:var(--s5)">Also: <code>POST /v1/x402/audit</code> \u2014 SEO + link health for $0.001/URL. Full spec: <code><a href="/openapi.json">GET /openapi.json</a></code></p>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════
       CTA BANNER: Final conversion push
       ═══════════════════════════════════════════════════════════════ -->
  <section class="section wrap" id="cta">
    <div class="cta-banner">
      <div class="cta-content">
        <h2>Start capturing the web today</h2>
        <p>No accounts. No API keys. Pay per-call with crypto.</p>
      </div>
      <div class="cta-actions">
        <a class="btn" href="#preview">Try it free \u2193</a>
        <a class="btn ghost" href="/buy">Buy credits \u2192</a>
      </div>
    </div>
  </section>

  <!-- ═══════════════════════════════════════════════════════════════
       RESOURCES: Compact links
       ═══════════════════════════════════════════════════════════════ -->
  <section class="section wrap" id="resources">
    <div class="link-strip">
      <a href="${bazaarCatalogUrl}" target="_blank" rel="noopener">CDP Bazaar listing <span class="arr">\u2197</span></a>
      <a href="/buy">Buy credits <span class="arr">\u2192</span></a>
      <a href="/openapi.json">/openapi.json <span class="arr">\u2192</span></a>
      <a href="/quickstart">quickstart guide <span class="arr">\u2192</span></a>
      <a href="/og-debugger">OG debugger <span class="arr">\u2192</span></a>
      <a href="/compare">vs alternatives <span class="arr">\u2192</span></a>
    </div>
  </section>
</main>
${footer(bazaarCatalogUrl)}

<script>
(function(){
  var base='${base}';
  var stripeConfigured=${stripeConfigured};
  /* --- social proof --- */
  fetch('/v1/status').then(function(r){return r.json();}).then(function(s){
    var el=document.getElementById('social-proof');
    var txt=document.getElementById('proof-text');
    var cap=document.getElementById('proof-captures');
    var ext=document.getElementById('proof-extracts');
    if(!el||!txt)return;
    var captures=0,extracts=0;
    if(s.endpoints&&s.endpoints.topHits){
      s.endpoints.topHits.forEach(function(e){
        if(e.endpoint&&e.endpoint.indexOf('/capture')!==-1)captures+=e.hits;
        if(e.endpoint&&e.endpoint.indexOf('/extract')!==-1)extracts+=e.hits;
      });
    }
    if(cap&&captures>0)cap.textContent=captures.toLocaleString();
    if(ext&&extracts>0)ext.textContent=extracts.toLocaleString();
    var parts=[];
    if(captures>0)parts.push(captures.toLocaleString()+' captures');
    if(extracts>0)parts.push(extracts.toLocaleString()+' extracts');
    if(parts.length===0)parts.push('API ready');
    parts.push('No API keys');
    parts.push('No accounts');
    txt.textContent=parts.join(' \u00B7 ');
    el.querySelector('.proof-icon').textContent='\u2713';
  }).catch(function(){
    var el=document.getElementById('social-proof');
    var txt=document.getElementById('proof-text');
    if(!el||!txt)return;
    txt.textContent='API ready \u00B7 No API keys \u00B7 No accounts';
    el.querySelector('.proof-icon').textContent='\u2713';
  });

  /* --- preview form --- */
  var form=document.getElementById('preview-form');
  if(!form)return;
  function doPreviewFetch(url){
    var ac;if(typeof AbortController!=='undefined'){ac=new AbortController();setTimeout(function(){ac.abort();},45000);}
    return fetch('/v1/extract/preview?url='+encodeURIComponent(url),ac?{signal:ac.signal}:undefined)
      .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();});
  }
  form.addEventListener('submit',function(e){
    e.preventDefault();
    var input=document.getElementById('preview-url-input');
    var btn=document.getElementById('preview-btn');
    var results=document.getElementById('preview-results');
    var url=input?input.value.trim():'';
    if(!url)return;
    if(!/^https?:\\/\\//i.test(url))url='https://'+url;
    try{navigator.sendBeacon('/v1/track',new Blob([JSON.stringify({event:'preview_submit',meta:{url:url}})],{type:'application/json'}));}catch(ex){}
    if(btn){btn.disabled=true;btn.textContent='Loading\u2026';}
    if(results){results.hidden=false;results.innerHTML='<div class="pr-loading"><span class="pr-spinner"></span> Fetching preview\u2026<span style="display:block;font-size:11px;color:var(--faint);margin-top:4px">Extracting title, headings, links, and markdown</span></div>';}
    function onSuccess(d){
      var p=d.preview||{};
      var h='';
      var hCount=(p.headings||[]).length;
      var lCount=(p.links||[]).length;
      var wCount=p.wordCount||0;
      
      const curlCmd = \`curl -X POST '\${base}/v1/x402/extract' -H 'content-type: application/json' -d '{"urls":["\${url}"]}'\`;
      /* --- header --- */
      h+='<div class="pr-header"><span class="pr-url">'+esc(p.title||url)+'</span>';
      if(d.truncated)h+='<span class="pr-badge">preview</span>';
      h+='</div>';
      if(p.description)h+='<p class="pr-desc">'+esc(p.description)+'</p>';
      /* --- UPGRADE CTA: Copy command as primary, buy credits as secondary --- */
      h+='<div class="pr-upgrade pr-upgrade-top">';
      h+='<div class="pr-upgrade-body">';
      h+='<div class="pr-upgrade-title"><span class="pr-upgrade-icon">\u{1F513}</span> Unlock full data \u2014 $0.01</div>';
      h+='<p style="margin:6px 0 10px;font-size:13px;color:var(--muted)">Get ALL '+hCount+' headings, ALL '+lCount+' links, full markdown, paragraphs, images, and page classification. <strong>Batch up to 50 URLs per payment.</strong></p>';
      h+='</div>';
      h+='<div class="pr-upgrade-actions" style="display:flex;flex-direction:column;gap:8px;width:100%">';
      /* PRIMARY: Copy command button \u2014 instant path to try paid API */
      h+='<button class="pr-copy-main" data-curl="'+esc(curlCmd)+'" style="display:flex;align-items:center;justify-content:center;gap:8px;padding:16px 24px;font-size:16px;font-weight:800;background:var(--accent);color:var(--accent-ink);border:none;border-radius:var(--r-m);cursor:pointer;font-family:var(--mono);width:100%;box-shadow:0 4px 16px rgba(37,99,235,.35);transition:all .15s ease;letter-spacing:-0.3px">\u{1F4CB} Copy command \u2014 paste in terminal, get full data</button>';
      /* SECONDARY: Buy credits link */
      h+='<a href="'+esc(base)+'/buy" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:12px 20px;text-decoration:none;font-weight:600;background:var(--panel);color:var(--accent);border:1px solid var(--accent);border-radius:var(--r-m);font-size:13px;font-family:var(--mono);width:100%">\u{1F48E} Buy credits with crypto \u2192</a>';
      h+='</div>';
      /* mini how-it-works inline */
      h+='<div style="display:flex;gap:8px;margin-top:10px;font-size:11px;color:var(--faint);align-items:center;flex-wrap:wrap">';
      h+='<span>\u{1F4CB} Copy</span><span>\u2192</span><span>\u{1F4BB} Paste in terminal</span><span>\u2192</span><span>\u{1F48E} Sign to pay</span><span>\u2192</span><span>\u2705 Get full data</span>';
      h+='</div>';
      h+='<div class="pr-copy-toast" id="copy-toast" hidden>\u2713 Copied! Paste in your terminal and run.</div>';
      h+='<div class="pr-pay-instructions" id="pr-pay-instructions" hidden>';
      h+='<div style="padding:16px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-m);margin-top:12px">';
      h+='<p style="font-weight:700;margin:0 0 12px;font-size:14px">\u2705 Command copied! Here\u2019s what to do:</p>';
      h+='<div style="display:flex;gap:12px;margin-bottom:12px">';
      h+='<div style="flex:1;padding:12px;background:var(--bg);border:1px solid var(--line);border-radius:var(--r-s)">';
      h+='<p style="font-weight:700;margin:0 0 4px;font-size:13px;color:var(--accent)">Step 1: Paste in terminal</p>';
      h+='<p style="margin:0;font-size:12px;color:var(--muted)">The curl command is on your clipboard. Paste and run it.</p>';
      h+='</div>';
      h+='<div style="flex:1;padding:12px;background:var(--bg);border:1px solid var(--line);border-radius:var(--r-s)">';
      h+='<p style="font-weight:700;margin:0 0 4px;font-size:13px;color:var(--accent)">Step 2: Sign the payment</p>';
      h+='<p style="margin:0;font-size:12px;color:var(--muted)">Server returns payment instructions. Sign once with your wallet.</p>';
      h+='</div>';
      h+='</div>';
      h+='</div></div>';
      /* --- USER-SPECIFIC COMPARISON: show what they're missing --- */
      h+='<div class="pr-auto-demo" id="pr-auto-demo" style="padding:16px 18px;background:rgba(37,99,235,.04);border:1px solid rgba(37,99,235,.15);border-radius:var(--r-m)">';
      h+='<span class="pr-label" style="color:var(--accent);font-weight:700">\u{1F4CA} What you got vs what you\\'re missing</span>';
      h+='<table style="width:100%;border-collapse:collapse;margin-top:10px;font-family:var(--mono);font-size:12px">';
      h+='<tr style="border-bottom:1px solid rgba(37,99,235,.1)"><td style="padding:5px 0;color:var(--faint);font-size:11px"></td><td style="padding:5px 10px;color:var(--faint);text-align:center;font-size:11px">Preview (free)</td><td style="padding:5px 10px;color:var(--accent);text-align:center;font-weight:700;font-size:11px">Full extract ($0.01)</td></tr>';
      h+='<tr style="border-bottom:1px solid rgba(37,99,235,.1)"><td style="padding:5px 0;color:var(--muted)">Title</td><td style="padding:5px 10px;text-align:center">\u2713 '+esc((p.title||'').slice(0,30))+'</td><td style="padding:5px 10px;text-align:center;color:var(--ok)">\u2713 '+esc((p.title||'').slice(0,30))+'</td></tr>';
      h+='<tr style="border-bottom:1px solid rgba(37,99,235,.1)"><td style="padding:5px 0;color:var(--muted)">Headings</td><td style="padding:5px 10px;text-align:center">'+hCount+' shown</td><td style="padding:5px 10px;text-align:center;color:var(--ok)">all of them</td></tr>';
      h+='<tr style="border-bottom:1px solid rgba(37,99,235,.1)"><td style="padding:5px 0;color:var(--muted)">Links</td><td style="padding:5px 10px;text-align:center">'+lCount+' shown</td><td style="padding:5px 10px;text-align:center;color:var(--ok)">all of them</td></tr>';
      h+='<tr style="border-bottom:1px solid rgba(37,99,235,.1)"><td style="padding:5px 0;color:var(--muted)">Word count</td><td style="padding:5px 10px;text-align:center">'+wCount+'</td><td style="padding:5px 10px;text-align:center;color:var(--ok)">full count</td></tr>';
      h+='<tr style="border-bottom:1px solid rgba(37,99,235,.1)"><td style="padding:5px 0;color:var(--muted)">Full markdown</td><td style="padding:5px 10px;text-align:center">\u2717 truncated</td><td style="padding:5px 10px;text-align:center;color:var(--ok)">\u2713 complete</td></tr>';
      h+='<tr style="border-bottom:1px solid rgba(37,99,235,.1)"><td style="padding:5px 0;color:var(--muted)">Paragraphs</td><td style="padding:5px 10px;text-align:center">\u2717</td><td style="padding:5px 10px;text-align:center;color:var(--ok)">\u2713 all</td></tr>';
      h+='<tr style="border-bottom:1px solid rgba(37,99,235,.1)"><td style="padding:5px 0;color:var(--muted)">Images</td><td style="padding:5px 10px;text-align:center">\u2717</td><td style="padding:5px 10px;text-align:center;color:var(--ok)">\u2713 all</td></tr>';
      h+='<tr><td style="padding:5px 0;color:var(--muted)">Page classification</td><td style="padding:5px 10px;text-align:center">\u2717</td><td style="padding:5px 10px;text-align:center;color:var(--ok)">\u2713 type + confidence</td></tr>';
      h+='</table>';
      h+='<p style="margin-top:10px;font-size:12px;color:var(--muted)">\u{1F4A1} One $0.01 payment gets you EVERYTHING: all headings, all links, full markdown, paragraphs, images, and page classification. <strong>One payment covers up to 50 URLs.</strong></p>';
      h+='</div>';
      /* --- TERMINAL COMMAND BOX: Show the exact curl command with one-click copy --- */
      h+='<div class="pr-terminal" style="margin-top:16px;border:1px solid var(--line);border-radius:var(--r-m);overflow:hidden">';
      h+='<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--panel);border-bottom:1px solid var(--line)">';
      h+='<span style="font-size:11px;font-weight:600;color:var(--muted)">Terminal \u2014 paste this command to get full data</span>';
      h+='<button class="pr-copy-main" data-curl="'+esc(curlCmd)+'" style="padding:4px 12px;font-size:11px;font-weight:700;background:var(--accent);color:var(--accent-ink);border:none;border-radius:var(--r-s);cursor:pointer;font-family:var(--mono);transition:all .15s ease">\u{1F4CB} Copy</button>';
      h+='</div>';
      h+='<pre style="margin:0;padding:12px 14px;font-size:12px;line-height:1.5;background:var(--bg);overflow-x:auto;color:var(--text)"><code>'+esc(curlCmd)+'</code></pre>';
      h+='</div>';
      /* --- preview data BELOW the CTA: users can see what they got --- */
      if(p.headings&&p.headings.length){
        h+='<div class="pr-section"><span class="pr-label">Headings ('+hCount+(d.truncated?' preview \u2014 more in full extract':'')+') '+'</span><ul>';
        p.headings.slice(0,8).forEach(function(heading){h+='<li><span class="pr-h'+heading.level+'">H'+heading.level+'</span> '+esc(heading.text)+'</li>';});
        h+='</ul></div>';
      }
      if(p.links&&p.links.length){
        h+='<div class="pr-section"><span class="pr-label">Links ('+p.links.length+(d.truncated?' shown':'')+')</span>';
        h+='<div class="pr-links">';
        p.links.slice(0,6).forEach(function(link){h+='<a href="'+esc(link.href)+'" target="_blank" rel="noopener">'+esc(link.text||link.href)+'</a>';});
        if(p.links.length>6)h+='<span class="pr-more">+'+(p.links.length-6)+' more</span>';
        h+='</div></div>';
      }
      if(p.wordCount)h+='<div class="pr-section"><span class="pr-label">Words</span> '+p.wordCount+(d.truncated?' (truncated)':'')+'</div>';
      /* --- secondary actions at bottom: repeat the copy CTA for users who scrolled down --- */
      h+='<div class="pr-bottom-actions">';
      h+='<button class="pr-copy-main" data-curl="'+esc(curlCmd)+'" style="display:inline-flex;align-items:center;gap:8px;padding:14px 28px;font-size:15px;font-weight:800;background:var(--accent);color:var(--accent-ink);border:none;border-radius:var(--r-m);cursor:pointer;font-family:var(--mono);box-shadow:0 4px 16px rgba(37,99,235,.35);transition:all .15s ease">\u{1F4CB} Copy command \u2014 paste in terminal, get full data</button>';
      h+='</div>';
      h+='<div class="pr-try-another"><button class="btn-sm pr-try-btn" data-url="https://en.wikipedia.org/wiki/Web_scraping">Wikipedia</button> <button class="btn-sm pr-try-btn" data-url="https://developer.mozilla.org/en-US/docs/Web/HTTP">MDN Docs</button> <button class="btn-sm pr-try-btn" data-url="https://github.com/shoutsid-lab/webcap">GitHub repo</button> <button class="btn-sm pr-try-btn" data-url="https://docs.python.org/3/">Python Docs</button></div>';
      if(results){results.innerHTML=h;results.scrollIntoView({behavior:'smooth',block:'start'});}
      /* --- primary copy button(s) (top + bottom) --- */
      var allCopyBtns=results?results.querySelectorAll('.pr-copy-main'):[];
      allCopyBtns.forEach(function(mainCopyBtn){
        mainCopyBtn.addEventListener('click',function(){
          var curl=mainCopyBtn.getAttribute('data-curl')||'';
          /* Track the copy attempt IMMEDIATELY (before clipboard) to ensure
             curl_copy events are never lost if clipboard API fails or is denied */
          try{navigator.sendBeacon('/v1/track',new Blob([JSON.stringify({event:'curl_copy',meta:{url:url,source:'preview_success'}})],{type:'application/json'}));}catch(ex){}
          try{navigator.sendBeacon('/v1/track',new Blob([JSON.stringify({event:'upgrade_click',meta:{url:url,source:'preview_results_copy'}})],{type:'application/json'}));}catch(ex){}
          if(navigator.clipboard){navigator.clipboard.writeText(curl).then(function(){
            allCopyBtns.forEach(function(b){b.textContent='\u2713 Copied! Now paste in your terminal';b.style.background='#16a34a';b.style.boxShadow='0 4px 16px rgba(22,163,74,.35)';});
            setTimeout(function(){allCopyBtns.forEach(function(b){b.textContent='\u{1F4CB} Copy command \u2014 paste in terminal, get full data';b.style.background='';b.style.boxShadow='';});},4000);
            var toast=results?results.querySelector('#copy-toast'):null;
            if(toast){toast.hidden=false;setTimeout(function(){toast.hidden=true;},5000);}
          }).catch(function(){
            /* Clipboard denied \u2014 fallback: select text for manual copy */
            mainCopyBtn.textContent='Right-click \u2192 Copy link address';
            setTimeout(function(){mainCopyBtn.textContent='\u{1F4CB} Copy command \u2014 paste in terminal, get full data';},3000);
          });}
        });
      });
      try{navigator.sendBeacon('/v1/track',new Blob([JSON.stringify({event:'preview_result_success',meta:{url:url,wordCount:p.wordCount||0,headingCount:(p.headings||[]).length,linkCount:(p.links||[]).length}})],{type:'application/json'}));}catch(ex){}
    }
    function onFail(err){
      var errMsg=String(err);
      var hint='';
      var friendlyMsg='Preview failed';
      if(errMsg.indexOf('Failed to fetch')!==-1||errMsg.indexOf('AbortError')!==-1){
        friendlyMsg='Request timed out';
        hint='<p class="pr-hint">The site took too long to respond. This can happen with heavy pages or sites that block automated requests. Try a simpler URL, or use the paid API for reliable capture.</p>';
      }else if(errMsg.indexOf('429')!==-1||errMsg.indexOf('rate')!==-1){
        friendlyMsg='Rate limited';
        hint='<p class="pr-hint">Too many requests. Wait a minute and try again, or use the paid API for unlimited access.</p>';
      }else if(errMsg.indexOf('404')!==-1||errMsg.indexOf('not found')!==-1){
        friendlyMsg='URL not found';
        hint="<p class='pr-hint'>The page doesn't exist. Check the URL and try again. Make sure it starts with <code>https://</code>.</p>";
      }else if(errMsg.indexOf('502')!==-1){
        friendlyMsg='Site blocked capture';
        hint='<p class="pr-hint">This site blocks automated requests. The paid API uses advanced browser-level capture that handles most blocking. Try it with the full extract.</p>';
      }else if(errMsg.indexOf('network')!==-1||errMsg.indexOf('ENOTFOUND')!==-1){
        friendlyMsg='DNS resolution failed';
        hint="<p class='pr-hint'>The domain couldn't be resolved. Check for typos in the URL.</p>";
      }
      var retryBtn='<button class="btn-sm pr-retry-btn" data-url="https://example.com/">Try example.com</button> <button class="btn-sm pr-retry-btn" data-url="https://en.wikipedia.org/wiki/Web_scraping">Try Wikipedia</button> <button class="btn-sm pr-retry-btn" data-url="https://developer.mozilla.org/en-US/docs/Web/HTTP">Try MDN</button> <button class="btn-sm pr-retry-btn" data-url="'+url+'">Retry this URL</button>';
      /* --- upgrade CTA on error: Copy command + buy credits --- */
      var errCta='';
      const errCurlCmd = \`curl -X POST '\${base}/v1/x402/extract' -H 'content-type: application/json' -d '{"urls":["\${url}"]}'\`;

      errCta+='<div class="pr-upgrade">';
      errCta+='<div class="pr-upgrade-body">';
      errCta+='<div class="pr-upgrade-title"><span class="pr-upgrade-icon">\u{1F513}</span> Unlock full data \u2014 $0.01</div>';
      errCta+='<p style="margin:4px 0 8px;font-size:12px;color:var(--muted)">Full markdown, all headings & links, images, paragraphs, and page classification. <strong>Batch up to 50 URLs per payment.</strong> No accounts needed.</p>';
      errCta+='</div>';
      errCta+='<div class="pr-upgrade-actions" style="display:flex;flex-direction:column;gap:8px;width:100%">';
      /* PRIMARY: Copy command button \u2014 instant path to try paid API */
      errCta+='<button class="pr-copy-main" data-curl="'+esc(errCurlCmd)+'" style="display:flex;align-items:center;justify-content:center;gap:8px;padding:16px 24px;font-size:16px;font-weight:800;background:var(--accent);color:var(--accent-ink);border:none;border-radius:var(--r-m);cursor:pointer;font-family:var(--mono);width:100%;box-shadow:0 4px 16px rgba(37,99,235,.35);transition:all .15s ease;letter-spacing:-0.3px">\u{1F4CB} Copy command \u2014 paste in terminal, get full data</button>';
      /* SECONDARY: Buy credits link */
      errCta+='<a href="'+esc(base)+'/buy" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:12px 20px;text-decoration:none;font-weight:600;background:var(--panel);color:var(--accent);border:1px solid var(--accent);border-radius:var(--r-m);font-size:13px;font-family:var(--mono);width:100%">\u{1F48E} Buy credits with crypto \u2192</a>';
      errCta+='</div>';
      /* mini how-it-works inline */
      errCta+='<div style="display:flex;gap:8px;margin-top:10px;font-size:11px;color:var(--faint);align-items:center;flex-wrap:wrap">';
      errCta+='<span>\u{1F4CB} Copy</span><span>\u2192</span><span>\u{1F4BB} Paste in terminal</span><span>\u2192</span><span>\u{1F48E} Sign to pay</span><span>\u2192</span><span>\u2705 Get full data</span>';
      errCta+='</div>';
      errCta+='</div>';
      errCta+='<div class="pr-copy-toast" id="copy-toast" hidden>\u2713 Copied! Paste in your terminal and run.</div>';
      /* --- TERMINAL COMMAND BOX on error: show the command even when preview fails --- */
      var errTerminal='<div class="pr-terminal" style="margin-top:16px;border:1px solid var(--line);border-radius:var(--r-m);overflow:hidden"><div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--panel);border-bottom:1px solid var(--line)"><span style="font-size:11px;font-weight:600;color:var(--muted)">Terminal \u2014 paste this command to get full data</span><button class="pr-copy-main" data-curl="'+esc(errCurlCmd)+'" style="padding:4px 12px;font-size:11px;font-weight:700;background:var(--accent);color:var(--accent-ink);border:none;border-radius:var(--r-s);cursor:pointer;font-family:var(--mono);transition:all .15s ease">\u{1F4CB} Copy</button></div><pre style="margin:0;padding:12px 14px;font-size:12px;line-height:1.5;background:var(--bg);overflow-x:auto;color:var(--text)"><code>'+esc(errCurlCmd)+'</code></pre></div>';
      /* Put the error FIRST — users need to understand what went wrong before seeing solutions */
      var errHtml='<div class="pr-error"><span class="pr-error-icon">\u26A0\uFE0F</span> <strong>'+esc(friendlyMsg)+'</strong>: '+esc(errMsg)+' '+hint+'<div class="pr-error-actions">'+retryBtn+'<a href="/v1/extract/preview?url='+encodeURIComponent(url)+'" target="_blank" class="pr-error-link">View raw JSON \u2197</a></div></div>';
      /* --- DEMO PREVIEW: Show what webcap CAN extract, even when the user's URL fails --- */
      var demoHtml='<div id="err-demo-section" style="margin-top:16px;padding:16px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-l)"><p style="margin:0 0 10px;font-size:13px;color:var(--muted)"><strong>\u{1F4CA} Here\u2019s what a full extract looks like</strong> (Hacker News \u2014 example output)</p><div id="err-demo-code" style="font-family:var(--mono);font-size:12px;line-height:1.6;color:var(--text);white-space:pre-wrap;max-height:300px;overflow-y:auto;padding:12px;background:var(--bg);border:1px solid var(--line);border-radius:var(--r-s)">Loading demo\u2026</div></div>';
      if(results){results.innerHTML=errHtml+errCta+errTerminal+demoHtml;results.scrollIntoView({behavior:'smooth',block:'start'});}
      /* --- load demo on error state --- */
      var errDemoCode=document.getElementById('err-demo-code');
            if(errDemoCode){
        fetch('/v1/demo').then(function(r){return r.json();}).then(function(d){
          var results2=d.results||[];
          if(!results2.length){errDemoCode.textContent='No demo available';return;}
          // Correctly extract the first item in the results array
          var item=results2[0];
          if(!item){errDemoCode.textContent='No demo data found';return;}
          
          var out='';
          out+='URL: '+(item.url||'')+'\\n';
          out+='Title: '+(item.title||'')+'\\n';
          out+='Description: '+(item.description||'').slice(0,120)+'...\\n\\n';
          out+='Headings ('+((item.headings||[]).length)+'):\\n';
          (item.headings||[]).slice(0,6).forEach(function(h){out+='  H'+h.level+': '+h.text+'\\n';});
          out+='\\nLinks ('+((item.links||[]).length)+'):\\n';
          (item.links||[]).slice(0,5).forEach(function(l){out+='  '+(l.text||l.href).slice(0,50)+'\\n';});
          out+='\\nWord count: '+(item.wordCount||0)+'\\n';
          out+='Paragraphs: '+((item.paragraphs||[]).length)+'\\n';
          out+='Images: '+((item.images||[]).length)+'\\n';
          out+='\\n--- Full markdown (first 500 chars) ---\\n';
          out+=(item.markdown||'').slice(0,500)+'...\\n';
          errDemoCode.textContent=out;
        }).catch(function(){errDemoCode.textContent='Demo unavailable.';});
      }

      var retryEls=results?results.querySelectorAll('.pr-retry-btn'):null;
      if(retryEls){retryEls.forEach(function(el){el.addEventListener('click',function(){
        var tryUrl=el.getAttribute('data-url')||'https://example.com/';
        var input2=document.getElementById('preview-url-input');
        if(input2)input2.value=tryUrl;
        form.dispatchEvent(new Event('submit'));
      });});}
      /* --- primary copy button (big) on error state --- */
      var errMainCopyBtn=results?results.querySelector('.pr-copy-main'):null;
      if(errMainCopyBtn){errMainCopyBtn.addEventListener('click',function(){
        var curl=errMainCopyBtn.getAttribute('data-curl')||'';
        /* Track IMMEDIATELY before clipboard */
        try{navigator.sendBeacon('/v1/track',new Blob([JSON.stringify({event:'curl_copy',meta:{url:url,source:'preview_error'}})],{type:'application/json'}));}catch(ex){}
        try{navigator.sendBeacon('/v1/track',new Blob([JSON.stringify({event:'upgrade_click',meta:{url:url,source:'preview_error_copy'}})],{type:'application/json'}));}catch(ex){}
        if(navigator.clipboard){navigator.clipboard.writeText(curl).then(function(){
          errMainCopyBtn.textContent='\u2713 Copied! Now paste in your terminal';errMainCopyBtn.style.background='#16a34a';errMainCopyBtn.style.boxShadow='0 4px 16px rgba(22,163,74,.35)';
          setTimeout(function(){errMainCopyBtn.textContent='\u{1F4CB} Copy command';errMainCopyBtn.style.background='';errMainCopyBtn.style.boxShadow='';},4000);
          var toast=results?results.querySelector('#copy-toast'):null;
          if(toast){toast.hidden=false;setTimeout(function(){toast.hidden=true;},5000);}
        }).catch(function(){
          errMainCopyBtn.textContent='Right-click \u2192 Copy link address';
          setTimeout(function(){errMainCopyBtn.textContent='\u{1F4CB} Copy command';},3000);
        });}
      });}
      /* --- api docs link tracking on error state --- */
      var errDocsLink=results?results.querySelector('.pr-upgrade-link'):null;
      if(errDocsLink){errDocsLink.addEventListener('click',function(){
        try{navigator.sendBeacon('/v1/track',new Blob([JSON.stringify({event:'upgrade_click',meta:{url:url,source:'preview_error'}})],{type:'application/json'}));}catch(ex){}
      });}
      /* classify error type for analytics */
      var errorType='other';
      if(errMsg.indexOf('502')!==-1)errorType='capture_failed';
      else if(errMsg.indexOf('429')!==-1||errMsg.indexOf('rate')!==-1)errorType='rate_limited';
      else if(errMsg.indexOf('Failed to fetch')!==-1||errMsg.indexOf('AbortError')!==-1)errorType='network_timeout';
      else if(errMsg.indexOf('404')!==-1||errMsg.indexOf('not found')!==-1)errorType='not_found';
      else if(errMsg.indexOf('422')!==-1)errorType='invalid_url';
      else if(errMsg.indexOf('403')!==-1)errorType='blocked';
      else if(errMsg.indexOf('ENOTFOUND')!==-1||err.name==='TypeError')errorType='dns_error';
      try{navigator.sendBeacon('/v1/track',new Blob([JSON.stringify({event:'preview_result_error',meta:{url:url,error:errMsg,errorType:errorType}})],{type:'application/json'}));}catch(ex){}
    }
    doPreviewFetch(url)
      .then(function(d){onSuccess(d);})
      .catch(function(err){onFail(err);})
      .finally(function(){
        if(btn){btn.disabled=false;btn.textContent='Extract \u2197';}
      });
  });
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

  /* --- Quick-try buttons --- */
  var quickBtns=document.querySelectorAll('.quick-try-btn');
  if(quickBtns){quickBtns.forEach(function(btn){btn.addEventListener('click',function(){
    var tryUrl=btn.getAttribute('data-url')||'';
    var input2=document.getElementById('preview-url-input');
    if(input2&&tryUrl)input2.value=tryUrl;
    form.dispatchEvent(new Event('submit'));
  });});}

  /* --- CTA click tracking --- */
  /* Only track navigation CTAs (hero, bottom banner), NOT the preview form
     submit button (which already fires preview_submit) or dynamically
     generated buttons in preview results (which have their own handlers). */
  document.querySelectorAll('.btn:not([data-no-track]):not(form .btn)').forEach(function(btn){
    btn.addEventListener('click',function(){
      try{navigator.sendBeacon('/v1/track',new Blob([JSON.stringify({event:'cta_click',meta:{text:btn.textContent||'',href:btn.getAttribute('href')||''}})],{type:'application/json'}));}catch(ex){}
      /* Also fire upgrade_click for Buy credits buttons */
      if(btn.getAttribute('data-upgrade')){
        try{navigator.sendBeacon('/v1/track',new Blob([JSON.stringify({event:'upgrade_click',meta:{source:'hero_cta',text:btn.textContent||'',href:btn.getAttribute('href')||''}})],{type:'application/json'}));}catch(ex){}
      }
    });
  });
})();
</script>
</body>
</html>`;
}
