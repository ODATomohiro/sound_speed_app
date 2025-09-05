// 大きい波形＆自動スケール版
(() => {
  const els = {
    btnStart: document.getElementById('btnStart'),
    btnRefresh: document.getElementById('btnRefresh'),
    micSelect: document.getElementById('micSelect'),
    spkSelect: document.getElementById('spkSelect'),
    spkNote: document.getElementById('spkNote'),
    btnPulse: document.getElementById('btnPulse'),
    btnTestBeep: document.getElementById('btnTestBeep'),
    btnReset: document.getElementById('btnReset'),
    thresh: document.getElementById('thresh'),
    threshVal: document.getElementById('threshVal'),
    minGapMs: document.getElementById('minGapMs'),
    minGapVal: document.getElementById('minGapVal'),
    windowMs: document.getElementById('windowMs'),
    windowVal: document.getElementById('windowVal'),
    pulseMs: document.getElementById('pulseMs'),
    pulseVal: document.getElementById('pulseVal'),
    ampMode: document.getElementById('ampMode'),
    gainWrap: document.getElementById('gainWrap'),
    gain: document.getElementById('gain'),
    gainVal: document.getElementById('gainVal'),
    snapPeak: document.getElementById('snapPeak'),
    wave: document.getElementById('wave'),
    t1ms: document.getElementById('t1ms'),
    t2ms: document.getElementById('t2ms'),
    btnApplyT1: document.getElementById('btnApplyT1'),
    btnApplyT2: document.getElementById('btnApplyT2'),
    btnAuto: document.getElementById('btnAuto'),
    btnClearMarks: document.getElementById('btnClearMarks'),
    btnZoomReset: document.getElementById('btnZoomReset'),
    btnPng: document.getElementById('btnPng'),
    dist: document.getElementById('dist'),
    t1Val: document.getElementById('t1Val'),
    t2Val: document.getElementById('t2Val'),
    dtVal: document.getElementById('dtVal'),
    vMeasured: document.getElementById('vMeasured'),
    btnCompute: document.getElementById('btnCompute'),
    btnCsv: document.getElementById('btnCsv'),
  };

  function bindRange(input, outSpan) {
    const update = () => outSpan.textContent = Number(input.value).toFixed(input.step && input.step.includes('.') ? input.step.split('.')[1].length : 0);
    input.addEventListener('input', update);
    update();
  }
  bindRange(els.thresh, els.threshVal);
  bindRange(els.minGapMs, els.minGapVal);
  bindRange(els.windowMs, els.windowVal);
  bindRange(els.pulseMs, els.pulseVal);

  els.ampMode.addEventListener('change', ()=>{ els.gainWrap.style.display = (els.ampMode.value==='fixed') ? '' : 'none'; drawWave(); });
  els.gain.addEventListener('input', ()=>{ els.gainVal.textContent = Number(els.gain.value).toFixed(1) + '×'; drawWave(); });

  let audioCtx=null, sampleRate=48000, using=null;
  let micStream=null, micNode=null, workletNode=null, scriptNode=null;
  let outGain=null, outDest=null, outAudio=null;
  let started=false;

  let captured=new Float32Array(0), capturing=false;
  let viewStart=0, viewEnd=0;
  let t1Index=null, t2Index=null;
  let dragState=null, lastActive='t2';

  function enableAfterStart(on){
    [els.btnPulse, els.btnTestBeep, els.btnAuto, els.btnClearMarks, els.btnPng, els.btnCompute, els.btnCsv].forEach(b=>b.disabled=!on);
  }

  async function ensureAudioReady(){
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)(); await audioCtx.resume(); sampleRate = audioCtx.sampleRate;
    outGain = audioCtx.createGain(); outGain.gain.value=0.9;
    outDest = audioCtx.createMediaStreamDestination(); outGain.connect(outDest);
    outAudio = new Audio(); outAudio.autoplay = true; try{ outAudio.srcObject = outDest.stream; await outAudio.play(); }catch(e){}
    try {
      const code=`class MicCaptureProcessor extends AudioWorkletProcessor{process(inputs){const i=inputs[0];if(i&&i[0]&&i[0].length>0){const c=new Float32Array(i[0].length);c.set(i[0]);this.port.postMessage(c,[c.buffer]);}return true;}}registerProcessor('mic-capture-processor',MicCaptureProcessor);`;
      const url = URL.createObjectURL(new Blob([code],{type:'application/javascript'}));
      await audioCtx.audioWorklet.addModule(url); using='worklet';
    } catch(e){ using='script'; }
    if ('setSinkId' in HTMLMediaElement.prototype) els.spkNote.textContent='出力切替対応: 有効'; else els.spkNote.textContent='出力切替対応: 未対応';
  }

  async function refreshDevices(){
    const devs = await navigator.mediaDevices.enumerateDevices();
    const mics=devs.filter(d=>d.kind==='audioinput'); const spks=devs.filter(d=>d.kind==='audiooutput');
    els.micSelect.innerHTML=''; mics.forEach(d=>{ const o=document.createElement('option'); o.value=d.deviceId; o.textContent=d.label||`マイク (${d.deviceId.slice(0,6)})`; els.micSelect.appendChild(o); });
    els.spkSelect.innerHTML=''; if(spks.length){ spks.forEach(d=>{ const o=document.createElement('option'); o.value=d.deviceId; o.textContent=d.label||`スピーカー (${d.deviceId.slice(0,6)})`; els.spkSelect.appendChild(o); }); els.spkSelect.disabled=false; } else { const o=document.createElement('option'); o.textContent='（出力選択 未対応）'; els.spkSelect.appendChild(o); els.spkSelect.disabled=true; }
  }
  async function applySpeaker(){ if (outAudio && 'setSinkId' in HTMLMediaElement.prototype){ const id=els.spkSelect.value; if(id) { try { await outAudio.setSinkId(id); } catch(e){} } } }

  async function startMic(){
    await ensureAudioReady();
    try{ const tmp=await navigator.mediaDevices.getUserMedia({audio:true}); tmp.getTracks().forEach(t=>t.stop()); }catch{}
    await refreshDevices();
    const micId = els.micSelect.value;
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: micId?{exact:micId}:undefined, echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1 } });
    micNode = audioCtx.createMediaStreamSource(micStream);
    if (using==='worklet'){ workletNode=new AudioWorkletNode(audioCtx,'mic-capture-processor',{numberOfInputs:1,numberOfOutputs:0}); workletNode.port.onmessage=(e)=>onMicChunk(e.data); micNode.connect(workletNode); }
    else { scriptNode=audioCtx.createScriptProcessor(1024,1,1); scriptNode.onaudioprocess=(ev)=>{ const input=ev.inputBuffer.getChannelData(0); const c=new Float32Array(input.length); c.set(input); onMicChunk(c); }; micNode.connect(scriptNode); scriptNode.connect(audioCtx.destination); }
    await applySpeaker();
    started=true; enableAfterStart(true);
  }

  function onMicChunk(chunk){ if(!capturing) return; const merged=new Float32Array(captured.length+chunk.length); merged.set(captured,0); merged.set(chunk,captured.length); captured=merged; }

  function playPulse(ms=Number(els.pulseMs.value)||5){
    const src=audioCtx.createBufferSource(); const len=Math.max(1,Math.round(sampleRate*(ms/1000))); const buf=audioCtx.createBuffer(1,len,sampleRate); const d=buf.getChannelData(0);
    for(let i=0;i<len;i++){ const w=Math.random()*2-1; const env=1-i/len; d[i]=w*env*0.8; }
    const hpf=audioCtx.createBiquadFilter(); hpf.type='highpass'; hpf.frequency.value=200; src.buffer=buf; src.connect(hpf).connect(outGain); src.start();
  }

  function recordWithPulse(){
    const windowMs=Number(els.windowMs.value), pulseMs=Number(els.pulseMs.value);
    captured=new Float32Array(0); t1Index=t2Index=null; updateAll();
    capturing=true; playPulse(pulseMs);
    setTimeout(()=>{ capturing=false; setFullView(); resizeCanvasForDPR(); drawWave(); }, windowMs);
  }

  // ---------- Canvas helpers (DPR-aware CSS coords) ----------
  const ctx = els.wave.getContext('2d');
  function resizeCanvasForDPR(){
    const rect = els.wave.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const needW = Math.max(1, Math.floor(rect.width * dpr));
    const needH = Math.max(1, Math.floor(rect.height * dpr));
    if (els.wave.width !== needW || els.wave.height !== needH){
      els.wave.width = needW; els.wave.height = needH;
    }
    ctx.setTransform(1,0,0,1,0,0);
    ctx.scale(dpr, dpr); // draw in CSS pixel coordinates
  }
  function clientXToCanvasCssX(clientX){
    const rect = els.wave.getBoundingClientRect();
    return clientX - rect.left; // CSS px
  }

  // View & mapping (CSS width)
  function setFullView(){ viewStart=0; viewEnd=captured.length; }
  function clampView(){
    const len=captured.length, minWidth=Math.max(256, Math.floor(sampleRate*0.002));
    if(viewStart<0) viewStart=0; if(viewEnd>len) viewEnd=len;
    if(viewEnd-viewStart<minWidth){ const mid=(viewStart+viewEnd)/2; viewStart=Math.max(0,Math.floor(mid-minWidth/2)); viewEnd=Math.min(len,viewStart+minWidth); }
  }
  function xToIdxCss(xCss){
    const rect = els.wave.getBoundingClientRect();
    const Wcss = rect.width || 1;
    const span = (viewEnd - viewStart) || 1;
    const frac = Math.max(0, Math.min(1, xCss / Wcss));
    return Math.round(viewStart + frac * span);
  }
  function idxToXCss(idx){
    const rect = els.wave.getBoundingClientRect();
    const Wcss = rect.width || 1;
    const span = (viewEnd - viewStart) || 1;
    return Math.round((idx - viewStart) * Wcss / span);
  }

  // Drawing helpers
  function msOf(idx){ return (idx / sampleRate) * 1000; }
  function niceStep(spanMs){
    const steps=[0.1,0.2,0.5,1,2,5,10,20,50,100,200,500,1000,2000];
    for (let s of steps){ if (spanMs/ s <= 10) return s; } return 5000;
  }
  function maxAbsInRange(i0, i1){
    let m = 0;
    for(let i=i0;i<i1;i++){ const a = Math.abs(captured[i]||0); if (a>m) m=a; }
    return m;
  }

  function drawWave(){
    resizeCanvasForDPR();
    const rect = els.wave.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle='#0b1020'; ctx.fillRect(0,0,W,H);

    // horizontal grid (above axis area)
    const axisH = 26;
    ctx.strokeStyle='rgba(255,255,255,0.08)'; ctx.lineWidth=1;
    for(let y=0;y<=H-axisH;y+=50){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

    // time ticks bottom
    const startMs = msOf(viewStart), endMs = msOf(viewEnd), spanMs = endMs - startMs;
    const step = niceStep(spanMs);
    const firstTick = Math.ceil(startMs / step) * step;
    ctx.fillStyle='rgba(255,255,255,0.65)';
    ctx.strokeStyle='rgba(255,255,255,0.12)';
    ctx.font='12px system-ui';
    for(let t=firstTick; t<=endMs+1e-6; t+=step){
      const idx = Math.round(t/1000 * sampleRate);
      const x = idxToXCss(idx);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H-axisH); ctx.stroke();
      ctx.fillText(t.toFixed(step<1?1:(step<10?1:0)) + ' ms', x+3, H-8);
    }

    if (!captured.length){
      ctx.fillStyle='rgba(255,255,255,0.75)'; ctx.font='14px system-ui';
      ctx.fillText('②で記録後にクリック/入力できます。', 16, 24);
      return;
    }

    // amplitude scale (auto or fixed)
    const usableH = H-axisH;
    const headroom = 0.48; // fraction of usable height for peak
    let gain = 1;
    if (els.ampMode.value==='fixed'){
      gain = Number(els.gain.value) * usableH * 0.45; // px per full-scale
    } else {
      const maxAbs = (els.ampMode.value==='view') ? maxAbsInRange(viewStart, viewEnd) : maxAbsInRange(0, captured.length);
      const safe = Math.max(1e-6, maxAbs);
      gain = usableH * headroom / safe; // px per unit amplitude
    }

    // waveform min/max rendering in view
    const s=viewStart, e=viewEnd, span=Math.max(1,e-s);
    ctx.strokeStyle='#7dd3fc'; ctx.lineWidth=1.5; ctx.beginPath();
    for(let x=0;x<W;x++){
      const i0 = Math.floor(s + span*x/W);
      const i1 = Math.floor(s + span*(x+1)/W);
      let lo=1e9, hi=-1e9;
      for(let i=i0;i<i1;i++){ const v=captured[i]||0; if(v<lo)lo=v; if(v>hi)hi=v; }
      if (lo===1e9) { lo=0; hi=0; }
      const yLo= usableH/2 - lo*gain, yHi=usableH/2 - hi*gain;
      ctx.moveTo(x,yLo); ctx.lineTo(x,yHi);
    }
    ctx.stroke();

    // markers
    drawMarker(t1Index,'#22c55e','t1'); drawMarker(t2Index,'#f97316','t2');
    function drawMarker(idx,color,label){
      if(idx==null) return; if(idx<viewStart||idx>viewEnd) return;
      const x=idxToXCss(idx);
      ctx.strokeStyle=color; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,usableH); ctx.stroke();
      const ms = msOf(idx).toFixed(2);
      ctx.fillStyle=color; ctx.font='12px system-ui';
      ctx.fillText(`${label}:${ms} ms`, x+4, 14);
    }

    // footer
    ctx.fillStyle='rgba(255,255,255,0.7)'; ctx.font='12px system-ui';
    ctx.fillText(`表示: ${spanMs.toFixed(1)} ms  /  Fs: ${sampleRate} Hz`, 16, H-8);
  }

  // Envelope & snap
  function envelope(data){ const N=data.length; const abs=new Float32Array(N); for(let i=0;i<N;i++) abs[i]=Math.abs(data[i]); const win=Math.max(8, Math.round(sampleRate*0.0008)); const env=new Float32Array(N); let sum=0; for(let i=0;i<N;i++){ sum+=abs[i]; if(i>=win) sum-=abs[i-win]; env[i]=sum/Math.min(i+1,win); } return env; }
  function refinePeakNear(arr, idx, radius){ const N=arr.length; let best=idx, val=arr[idx]||0; for(let i=Math.max(0,idx-radius); i<=Math.min(N-1,idx+radius); i++){ if(arr[i]>val){ val=arr[i]; best=i; } } return best; }
  function maybeSnap(idx){ if(!els.snapPeak.checked || !captured.length) return idx; const env=envelope(captured); return refinePeakNear(env, idx, Math.round(sampleRate*0.002)); }

  // Interaction
  function placeAtIdx(idx){
    if (t1Index==null){ t1Index=maybeSnap(idx); lastActive='t1'; }
    else if (t2Index==null){ t2Index=maybeSnap(idx); lastActive='t2'; }
    else {
      const x = idxToXCss(idx);
      const d1 = Math.abs(x - idxToXCss(t1Index));
      const d2 = Math.abs(x - idxToXCss(t2Index));
      if (d1<=d2){ t1Index=maybeSnap(idx); lastActive='t1'; } else { t2Index=maybeSnap(idx); lastActive='t2'; }
    }
    drawWave(); updateAll();
  }

  els.wave.addEventListener('click', (ev)=>{
    if(!captured.length) return;
    const xCss = clientXToCanvasCssX(ev.clientX);
    placeAtIdx( xToIdxCss(xCss) );
  });
  els.wave.addEventListener('dblclick', (ev)=>{
    if(!captured.length) return;
    const xCss = clientXToCanvasCssX(ev.clientX);
    const idx = xToIdxCss(xCss);
    placeAtIdx(idx); placeAtIdx(idx);
  });

  els.wave.addEventListener('mousedown', (ev)=>{
    if(!captured.length) return;
    const xCss = clientXToCanvasCssX(ev.clientX);
    const tol=6;
    const near = (()=>{
      if(t1Index!=null && Math.abs(xCss-idxToXCss(t1Index))<=tol) return 't1';
      if(t2Index!=null && Math.abs(xCss-idxToXCss(t2Index))<=tol) return 't2';
      return null;
    })();
    if (near){ dragState={type:'marker', target:near}; lastActive=near; return; }
    dragState={type:'pan', startX:xCss, startViewStart:viewStart, startViewEnd:viewEnd};
  });
  window.addEventListener('mousemove', (ev)=>{
    if(!dragState) return;
    const xCss = clientXToCanvasCssX(ev.clientX);
    if (dragState.type==='marker'){
      const idx = xToIdxCss(xCss);
      if (dragState.target==='t1') t1Index = idx; else t2Index = idx;
      drawWave(); updateAll();
    } else if (dragState.type==='pan'){
      const dx = xCss - dragState.startX;
      const rect = els.wave.getBoundingClientRect(); const Wcss = rect.width || 1;
      const span = dragState.startViewEnd - dragState.startViewStart;
      const shift = Math.round(-dx * span / Wcss);
      viewStart = dragState.startViewStart + shift;
      viewEnd   = dragState.startViewEnd + shift;
      clampView(); drawWave();
    }
  });
  window.addEventListener('mouseup', ()=>{
    if (dragState && dragState.type==='marker' && els.snapPeak.checked){
      if (dragState.target==='t1') t1Index = maybeSnap(t1Index); else t2Index = maybeSnap(t2Index);
      drawWave(); updateAll();
    }
    dragState=null;
  });

  els.wave.addEventListener('wheel', (ev)=>{
    if(!captured.length) return;
    ev.preventDefault();
    const xCss = clientXToCanvasCssX(ev.clientX);
    const center = xToIdxCss(xCss);
    const factor = Math.exp(-ev.deltaY * 0.0015);
    const span = viewEnd - viewStart;
    let newSpan = Math.max(Math.floor(span / factor), Math.floor(sampleRate*0.002));
    const leftFrac = (center - viewStart) / span;
    viewStart = Math.round(center - newSpan * leftFrac);
    viewEnd   = viewStart + newSpan;
    clampView(); drawWave();
  }, {passive:false});

  window.addEventListener('keydown', (ev)=>{
    if(!captured.length) return; const step = ev.shiftKey ? 10 : 1;
    if (ev.key==='ArrowLeft'){ if(lastActive==='t2' && t2Index!=null) t2Index=Math.max(0,t2Index-step); else if(t1Index!=null) t1Index=Math.max(0,t1Index-step); drawWave(); updateAll(); }
    else if (ev.key==='ArrowRight'){ if(lastActive==='t2' && t2Index!=null) t2Index=Math.min(captured.length-1,t2Index+step); else if(t1Index!=null) t1Index=Math.min(captured.length-1,t1Index+step); drawWave(); updateAll(); }
    else if (ev.key==='r' || ev.key==='R'){ setFullView(); drawWave(); }
  });

  // Auto detect
  function autoDetect(){
    if(!captured.length) return;
    const thresh=Number(els.thresh.value), minGapMs=Number(els.minGapMs.value), minGapSamples=Math.round(sampleRate*(minGapMs/1000));
    const N=captured.length; const env=envelope(captured);
    let t1=null; for(let i=0;i<N;i++){ if(env[i]>thresh){ t1=i; break; } }
    if(t1===null){ alert('t1が検出できません'); return; }
    let t2=null; for(let i=t1+minGapSamples;i<N;i++){ if(env[i]>thresh){ t2=i; break; } }
    if(t2===null){ alert('t2が検出できません'); return; }
    t1Index=t1; t2Index=refinePeakNear(env,t2,Math.round(sampleRate*0.002)); focusBetween(); drawWave(); updateAll();
  }
  function focusBetween(){ if(t1Index==null||t2Index==null) return; const s=Math.min(t1Index,t2Index), e=Math.max(t1Index,t2Index); const pad=Math.round((e-s)*0.5)+Math.round(sampleRate*0.01); viewStart=Math.max(0,s-pad); viewEnd=Math.min(captured.length,e+pad); clampView(); }

  // Numbers & results
  function setMarkerMs(which, ms){
    if (!captured.length || !Number.isFinite(ms)) return;
    const idx = Math.max(0, Math.min(captured.length-1, Math.round(ms/1000 * sampleRate)));
    if (which==='t1'){ t1Index = els.snapPeak.checked ? refinePeakNear(envelope(captured), idx, Math.round(sampleRate*0.002)) : idx; lastActive='t1'; }
    else { t2Index = els.snapPeak.checked ? refinePeakNear(envelope(captured), idx, Math.round(sampleRate*0.002)) : idx; lastActive='t2'; }
    focusBetween(); drawWave(); updateAll();
  }
  function updateAll(){
    const ms1 = (t1Index!=null) ? (msOf(t1Index).toFixed(2)) : '–';
    const ms2 = (t2Index!=null) ? (msOf(t2Index).toFixed(2)) : '–';
    els.t1Val.textContent = ms1; els.t2Val.textContent = ms2;
    if(t1Index==null || t2Index==null){ els.dtVal.textContent='–'; els.vMeasured.textContent='–'; return; }
    const dt = Math.abs(t2Index - t1Index) / sampleRate; // s
    els.dtVal.textContent = (dt*1000).toFixed(2);
    const D = Number(els.dist.value);
    els.vMeasured.textContent = (D>0 && dt>0) ? (2*D/dt).toFixed(2) : '–';
  }

  // Auto recompute on D change
  els.dist.addEventListener('input', updateAll);
  els.dist.addEventListener('change', updateAll);

  // Wire UI
  els.btnStart.addEventListener('click', async ()=>{ try{ await startMic(); }catch(e){ alert('マイク開始に失敗: '+e); } });
  els.btnRefresh.addEventListener('click', async ()=>{ await refreshDevices(); await applySpeaker(); });
  els.btnPulse.addEventListener('click', ()=>{ if(!started) return; recordWithPulse(); });
  els.btnTestBeep.addEventListener('click', ()=>{ if(!started) return; playPulse(); });
  els.btnReset.addEventListener('click', ()=>{ captured=new Float32Array(0); t1Index=t2Index=null; setFullView(); drawWave(); updateAll(); });
  els.btnAuto.addEventListener('click', autoDetect);
  els.btnZoomReset.addEventListener('click', ()=>{ setFullView(); drawWave(); });
  els.btnApplyT1.addEventListener('click', ()=>{ const ms=parseFloat(els.t1ms.value); setMarkerMs('t1', ms); });
  els.btnApplyT2.addEventListener('click', ()=>{ const ms=parseFloat(els.t2ms.value); setMarkerMs('t2', ms); });
  els.btnPng.addEventListener('click', ()=>{ const a=document.createElement('a'); a.download='waveform.png'; a.href=els.wave.toDataURL('image/png'); a.click(); });
  els.btnCsv.addEventListener('click', ()=>{
    const dt = (t1Index!=null && t2Index!=null) ? Math.abs(t2Index - t1Index)/sampleRate : NaN;
    const D = Number(els.dist.value);
    const v = (Number.isFinite(dt)&&dt>0&&D>0) ? (2*D/dt) : NaN;
    let csv='sample_rate,window_ms,threshold,min_gap_ms,pulse_ms,amp_mode,gain\\n';
    csv += [sampleRate, els.windowMs.value, els.thresh.value, els.minGapMs.value, els.pulseMs.value, els.ampMode.value, (els.ampMode.value==='fixed'?els.gain.value:'')].join(',')+'\\n\\n';
    csv += 't1_ms,t2_ms,dt_ms,dist_m,v_measured_mps\\n';
    const t1ms = (t1Index!=null)?msOf(t1Index).toFixed(3):'';
    const t2ms = (t2Index!=null)?msOf(t2Index).toFixed(3):'';
    csv += [t1ms, t2ms, (Number.isFinite(dt)?(dt*1000).toFixed(3):''), D, (Number.isFinite(v)?v.toFixed(2):'')].join(',')+'\\n';
    csv += '\\nindex,amplitude\\n';
    for(let i=0;i<captured.length;i++){ csv += i+','+(captured[i].toFixed(6))+'\\n'; }
    const blob=new Blob([csv],{type:'text/csv'}); const a=document.createElement('a'); a.download='sound_speed_measurement.csv'; a.href=URL.createObjectURL(blob); a.click();
  });

  // Init
  function init(){ resizeCanvasForDPR(); drawWave(); }
  window.addEventListener('resize', ()=>{ drawWave(); });
  init();
})();
