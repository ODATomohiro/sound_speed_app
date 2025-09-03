// 音速測定アプリ Pro：クリック改善 + ズーム/パン + デバイス選択 + Worklet/Script フォールバック
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
    wave: document.getElementById('wave'),
    btnAuto: document.getElementById('btnAuto'),
    btnSetT1: document.getElementById('btnSetT1'),
    btnSetT2: document.getElementById('btnSetT2'),
    btnClearMarks: document.getElementById('btnClearMarks'),
    btnZoomReset: document.getElementById('btnZoomReset'),
    btnPng: document.getElementById('btnPng'),
    dist: document.getElementById('dist'),
    tempC: document.getElementById('tempC'),
    dtVal: document.getElementById('dtVal'),
    vMeasured: document.getElementById('vMeasured'),
    vTheory: document.getElementById('vTheory'),
    btnCompute: document.getElementById('btnCompute'),
    btnCsv: document.getElementById('btnCsv'),
  };

  let audioCtx=null, micStream=null, micNode=null, workletNode=null, scriptNode=null, outGain=null, outDest=null, outAudio=null;
  let started=false, sampleRate=48000, using=null; // 'worklet'|'script'
  let selectedMicId=null, selectedSpkId=null;
  // 収録データとビュー窓
  let captured = new Float32Array(0);
  let capturing = false;
  let viewStart = 0, viewEnd = 0; // [sample index, exclusive)
  let t1Index = null, t2Index = null;
  let clickMode = null; // 't1'|'t2'|null
  let dragState = null; // {type:'pan'|'marker', target:'t1'|'t2'|null, startX, startIdx, startViewStart, startViewEnd}

  // UI helpers
  function bindRange(input, outSpan) {
    const update = () => outSpan.textContent = Number(input.value).toFixed(input.step && input.step.includes('.') ? input.step.split('.')[1].length : 0);
    input.addEventListener('input', update);
    update();
  }
  bindRange(els.thresh, els.threshVal);
  bindRange(els.minGapMs, els.minGapVal);
  bindRange(els.windowMs, els.windowVal);
  bindRange(els.pulseMs, els.pulseVal);

  function setToggle(btn, on){
    btn.classList.toggle('toggle-on', !!on);
  }

  function enableButtons(on) {
    els.btnPulse.disabled = !on;
    els.btnTestBeep.disabled = !on;
    els.btnAuto.disabled = !on;
    els.btnSetT1.disabled = !on;
    els.btnSetT2.disabled = !on;
    els.btnClearMarks.disabled = !on;
    els.btnPng.disabled = !on;
    els.btnCompute.disabled = !on;
    els.btnCsv.disabled = !on;
  }

  // Audio init
  async function ensureAudioReady() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    sampleRate = audioCtx.sampleRate;

    outGain = audioCtx.createGain();
    outGain.gain.value = 0.9;

    // 出力: MediaStreamDestination 経由で <audio> に流して setSinkId 対応
    outDest = audioCtx.createMediaStreamDestination();
    outGain.connect(outDest);

    outAudio = new Audio();
    outAudio.autoplay = true;
    try {
      outAudio.srcObject = outDest.stream;
      await outAudio.play();
    } catch(e) {
      console.warn('outAudio.play() 失敗:', e);
    }

    // Worklet優先
    try {
      const workletCode = `
        class MicCaptureProcessor extends AudioWorkletProcessor {
          process(inputs) {
            const input = inputs[0];
            if (input && input[0] && input[0].length > 0) {
              const copy = new Float32Array(input[0].length);
              copy.set(input[0]);
              this.port.postMessage(copy, [copy.buffer]);
            }
            return true;
          }
        }
        registerProcessor('mic-capture-processor', MicCaptureProcessor);
      `;
      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(url);
      using = 'worklet';
    } catch(e) {
      using = 'script';
      console.warn('Worklet不可 -> ScriptProcessor フォールバック:', e);
    }

    // 出力デバイス選択可否
    if (typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype) {
      els.spkNote.textContent = '出力切替対応: 有効';
    } else {
      els.spkNote.textContent = '出力切替対応: 未対応（Chrome系以外では不可のことがあります）';
    }
  }

  // Device list
  async function refreshDevices() {
    let devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d=>d.kind==='audioinput');
    const spks = devices.filter(d=>d.kind==='audiooutput');

    // mic
    const micSel = els.micSelect;
    micSel.innerHTML = '';
    mics.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `マイク (${d.deviceId.slice(0,6)})`;
      micSel.appendChild(opt);
    });
    if (selectedMicId) micSel.value = selectedMicId;
    else selectedMicId = micSel.value;

    // speaker
    const spkSel = els.spkSelect;
    spkSel.innerHTML = '';
    if (spks.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = '（出力選択 未対応）';
      spkSel.appendChild(opt);
      spkSel.disabled = true;
    } else {
      spks.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `スピーカー (${d.deviceId.slice(0,6)})`;
        spkSel.appendChild(opt);
      });
      spkSel.disabled = false;
      if (selectedSpkId) spkSel.value = selectedSpkId;
      else selectedSpkId = spkSel.value;
    }
  }

  async function applySpeakerRoute() {
    if (!outAudio) return;
    if ('setSinkId' in HTMLMediaElement.prototype && selectedSpkId) {
      try {
        await outAudio.setSinkId(selectedSpkId);
      } catch(e) {
        console.warn('setSinkId 失敗:', e);
      }
    }
  }

  async function startMic() {
    await ensureAudioReady();

    // 先に一度 getUserMedia してデバイスラベルを解禁
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({audio:true});
      tmp.getTracks().forEach(t=>t.stop());
    } catch {}

    await refreshDevices();

    // mic 取得
    const constraints = {
      audio: {
        deviceId: selectedMicId ? {exact: selectedMicId} : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1
      }
    };
    micStream = await navigator.mediaDevices.getUserMedia(constraints);
    micNode = audioCtx.createMediaStreamSource(micStream);

    if (using === 'worklet') {
      workletNode = new AudioWorkletNode(audioCtx, 'mic-capture-processor', { numberOfInputs: 1, numberOfOutputs: 0 });
      workletNode.port.onmessage = (e) => onMicChunk(e.data);
      micNode.connect(workletNode);
    } else {
      scriptNode = audioCtx.createScriptProcessor(1024, 1, 1);
      scriptNode.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length); copy.set(input);
        onMicChunk(copy);
      };
      micNode.connect(scriptNode);
      scriptNode.connect(audioCtx.destination); // Safari で必要な場合あり
    }

    await applySpeakerRoute();

    started = true;
    enableButtons(true);
  }

  // Pulse
  function makePulseBuffer(ms = Number(els.pulseMs.value)||5) {
    const length = Math.max(1, Math.round(sampleRate * (ms / 1000)));
    const buf = audioCtx.createBuffer(1, length, sampleRate);
    const data = buf.getChannelData(0);
    for (let i=0;i<length;i++){ const w=Math.random()*2-1; const env=1-i/length; data[i]=w*env*0.8; }
    return buf;
  }
  function playPulse(ms) {
    const src = audioCtx.createBufferSource();
    src.buffer = makePulseBuffer(ms);
    const hpf = audioCtx.createBiquadFilter();
    hpf.type='highpass'; hpf.frequency.value=200;
    src.connect(hpf).connect(outGain);
    src.start();
  }

  // capture
  function onMicChunk(chunk){ if(!capturing) return; const merged = new Float32Array(captured.length + chunk.length); merged.set(captured,0); merged.set(chunk,captured.length); captured=merged; }

  function recordWithPulse() {
    const windowMs = Number(els.windowMs.value);
    const pulseMs = Number(els.pulseMs.value);
    captured = new Float32Array(0);
    t1Index = null; t2Index = null;
    capturing = true;
    playPulse(pulseMs);
    setTimeout(()=>{ capturing=false; setFullView(); drawWave(); }, windowMs);
  }

  // View (zoom/pan)
  function setFullView(){ viewStart = 0; viewEnd = captured.length; }
  function clampView(){
    const len = captured.length;
    const minWidth = Math.max(256, Math.floor(sampleRate*0.002)); // >= 2ms
    if (viewStart < 0) viewStart = 0;
    if (viewEnd > len) viewEnd = len;
    if (viewEnd - viewStart < minWidth) {
      const mid = (viewStart + viewEnd)/2;
      viewStart = Math.max(0, Math.floor(mid - minWidth/2));
      viewEnd = Math.min(len, viewStart + minWidth);
    }
  }
  function idxToX(idx){
    const W = els.wave.width;
    const span = (viewEnd - viewStart) || 1;
    return Math.round((idx - viewStart) * W / span);
  }
  function xToIdx(x){
    const W = els.wave.width;
    const span = (viewEnd - viewStart) || 1;
    const frac = Math.max(0, Math.min(1, x / W));
    return Math.round(viewStart + frac * span);
  }

  // Auto detect
  function autoDetect(){
    if (!captured.length) return;
    const thresh = Number(els.thresh.value);
    const minGapMs = Number(els.minGapMs.value);
    const minGapSamples = Math.round(sampleRate * (minGapMs / 1000));

    const N = captured.length;
    const abs = new Float32Array(N);
    for(let i=0;i<N;i++) abs[i]=Math.abs(captured[i]);
    const win = Math.max(8, Math.round(sampleRate*0.0008));
    const env = new Float32Array(N);
    let sum=0;
    for(let i=0;i<N;i++){ sum+=abs[i]; if(i>=win) sum-=abs[i-win]; env[i]=sum/Math.min(i+1,win); }

    let t1=null;
    for(let i=0;i<N;i++){ if(env[i]>thresh){ t1=i; break; } }
    if (t1===null){ alert('t1検出不可。しきい値/音量/録音窓を調整'); return; }

    let t2=null;
    for(let i=t1+minGapSamples;i<N;i++){ if(env[i]>thresh){ t2=i; break; } }
    if (t2===null){ alert('t2検出不可。距離/音量/しきい値を調整'); return; }

    t1Index=t1; t2Index=refinePeakNear(env,t2,Math.round(sampleRate*0.002));
    focusBetween(t1Index, t2Index);
    drawWave(); updateDT();
  }
  function refinePeakNear(arr, idx, radius){
    const N=arr.length; let best=idx, val=arr[idx]||0;
    for(let i=Math.max(0,idx-radius); i<=Math.min(N-1, idx+radius); i++){
      if(arr[i]>val){ val=arr[i]; best=i; }
    }
    return best;
  }

  function focusBetween(a,b){
    const s=Math.min(a,b), e=Math.max(a,b);
    const pad = Math.round((e-s)*0.5)+Math.round(sampleRate*0.01);
    viewStart = Math.max(0, s - pad);
    viewEnd = Math.min(captured.length, e + pad);
    clampView();
  }

  // Drawing
  const ctx = els.wave.getContext('2d');
  function drawWave(){
    const W=els.wave.width, H=els.wave.height;
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle='#0b1020'; ctx.fillRect(0,0,W,H);
    ctx.strokeStyle='rgba(255,255,255,0.08)'; ctx.lineWidth=1;
    for(let y=0;y<=H;y+=50){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

    if (!captured.length) {
      ctx.fillStyle='rgba(255,255,255,0.7)'; ctx.font='14px system-ui';
      ctx.fillText('ここに波形が表示されます（②で記録）', 16, 24);
      return;
    }

    // min/max plot in view window
    const s=viewStart, e=viewEnd, span=Math.max(1,e-s);
    ctx.strokeStyle='#7dd3fc'; ctx.lineWidth=1.5; ctx.beginPath();
    for(let x=0;x<W;x++){
      const i0 = Math.floor(s + span*x/W);
      const i1 = Math.floor(s + span*(x+1)/W);
      let lo=1e9, hi=-1e9;
      for(let i=i0;i<i1;i++){ const v=captured[i]||0; if(v<lo)lo=v; if(v>hi)hi=v; }
      const yLo=H/2 - lo*(H*0.45), yHi=H/2 - hi*(H*0.45);
      ctx.moveTo(x,yLo); ctx.lineTo(x,yHi);
    }
    ctx.stroke();

    // markers
    drawMarker(t1Index,'#22c55e'); drawMarker(t2Index,'#f97316');
    function drawMarker(idx,color){
      if(idx==null) return;
      if (idx<viewStart || idx>viewEnd) return;
      const x=idxToX(idx);
      ctx.strokeStyle=color; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
    }

    // footer text
    ctx.fillStyle='rgba(255,255,255,0.7)'; ctx.font='12px system-ui';
    const totalMs = (captured.length / sampleRate) * 1000;
    const viewMs = ((viewEnd - viewStart) / sampleRate) * 1000;
    ctx.fillText(`全長: ${totalMs.toFixed(1)} ms  /  表示: ${viewMs.toFixed(1)} ms  /  Fs: ${sampleRate} Hz  /  入力: ${using||'unknown'}`, 16, H-10);
  }

  // Marker interactions
  function nearMarkerX(x){
    const tol=6; // px
    const pairs = [];
    if(t1Index!=null){ const x1=idxToX(t1Index); pairs.push({target:'t1',x:x1,dist:Math.abs(x-x1)}); }
    if(t2Index!=null){ const x2=idxToX(t2Index); pairs.push({target:'t2',x:x2,dist:Math.abs(x-x2)}); }
    if(!pairs.length) return null;
    pairs.sort((a,b)=>a.dist-b.dist);
    return pairs[0].dist<=tol ? pairs[0].target : null;
  }

  function setClickMode(mode){
    clickMode = (clickMode===mode) ? null : mode;
    setToggle(els.btnSetT1, clickMode==='t1');
    setToggle(els.btnSetT2, clickMode==='t2');
  }

  // Events for canvas
  els.wave.addEventListener('dblclick', (ev)=>{
    if(!captured.length) return;
    const rect=els.wave.getBoundingClientRect(); const x=ev.clientX-rect.left;
    const idx = xToIdx(x);
    if (t1Index==null){ t1Index=idx; }
    else { t2Index=idx; focusBetween(t1Index,t2Index); }
    drawWave(); updateDT();
  });

  els.wave.addEventListener('mousedown', (ev)=>{
    if(!captured.length) return;
    const rect=els.wave.getBoundingClientRect(); const x=ev.clientX-rect.left;
    const idx = xToIdx(x);

    // marker drag if close
    const near = nearMarkerX(x);
    if (near){
      dragState = {type:'marker', target:near};
      return;
    }
    // set marker when in clickMode
    if (clickMode==='t1'){ t1Index=idx; setClickMode(null); drawWave(); updateDT(); return; }
    if (clickMode==='t2'){ t2Index=idx; setClickMode(null); drawWave(); updateDT(); return; }

    // otherwise pan
    dragState = {type:'pan', startX:x, startViewStart:viewStart, startViewEnd:viewEnd};
  });
  window.addEventListener('mousemove', (ev)=>{
    if(!dragState) return;
    const rect=els.wave.getBoundingClientRect(); const x=ev.clientX-rect.left;
    if (dragState.type==='marker'){
      const idx = xToIdx(x);
      if (dragState.target==='t1') t1Index=idx; else if (dragState.target==='t2') t2Index=idx;
      drawWave(); updateDT();
    } else if (dragState.type==='pan'){
      const dx = x - dragState.startX;
      const span = dragState.startViewEnd - dragState.startViewStart;
      const shift = Math.round(-dx * span / els.wave.width);
      viewStart = dragState.startViewStart + shift;
      viewEnd = dragState.startViewEnd + shift;
      clampView(); drawWave();
    }
  });
  window.addEventListener('mouseup', ()=>{ dragState=null; });

  // Wheel zoom
  els.wave.addEventListener('wheel', (ev)=>{
    if(!captured.length) return;
    ev.preventDefault();
    const rect=els.wave.getBoundingClientRect(); const x=ev.clientX-rect.left;
    const centerIdx = xToIdx(x);
    const factor = Math.exp(-ev.deltaY * 0.0015); // zoom in for negative deltaY
    const span = viewEnd - viewStart;
    let newSpan = Math.max(Math.floor(span / factor), Math.floor(sampleRate*0.002));
    const leftFrac = (centerIdx - viewStart) / span;
    viewStart = Math.round(centerIdx - newSpan * leftFrac);
    viewEnd   = viewStart + newSpan;
    clampView(); drawWave();
  }, {passive:false});

  // Buttons & keys
  els.btnSetT1.addEventListener('click', ()=>setClickMode('t1'));
  els.btnSetT2.addEventListener('click', ()=>setClickMode('t2'));
  els.btnClearMarks.addEventListener('click', ()=>{ t1Index=null; t2Index=null; drawWave(); updateDT(); });
  els.btnZoomReset.addEventListener('click', ()=>{ setFullView(); drawWave(); });
  window.addEventListener('keydown', (ev)=>{
    if (ev.key==='1'){ setClickMode('t1'); }
    else if (ev.key==='2'){ setClickMode('t2'); }
    else if (ev.key==='r' || ev.key==='R'){ setFullView(); drawWave(); }
    else if ((ev.metaKey||ev.ctrlKey) && ev.key.toLowerCase()==='z'){ // undo: clear last
      if (t2Index!=null) t2Index=null;
      else if (t1Index!=null) t1Index=null;
      drawWave(); updateDT();
    }
  });

  function updateDT(){
    if (t1Index==null || t2Index==null || !captured.length){
      els.dtVal.textContent='–'; els.vMeasured.textContent='–'; updateTheory(); return;
    }
    const dt = Math.abs(t2Index - t1Index) / sampleRate;
    els.dtVal.textContent = dt.toFixed(6);
    const D = Number(els.dist.value);
    els.vMeasured.textContent = (D>0 && dt>0) ? (2*D/dt).toFixed(2) : '–';
    updateTheory();
  }
  function updateTheory(){
    const T = Number(els.tempC.value);
    els.vTheory.textContent = Number.isFinite(T) ? (331.3 + 0.606*T).toFixed(2) : '–';
  }
  ['input','change'].forEach(evt=>{ els.tempC.addEventListener(evt, updateTheory); els.dist.addEventListener(evt, updateDT); });
  updateTheory();

  function savePNG(){ const a=document.createElement('a'); a.download='waveform.png'; a.href=els.wave.toDataURL('image/png'); a.click(); }
  function saveCSV(){
    const dt = (t1Index!=null && t2Index!=null) ? Math.abs(t2Index - t1Index)/sampleRate : NaN;
    const D = Number(els.dist.value);
    const v = (Number.isFinite(dt)&&dt>0&&D>0) ? (2*D/dt) : NaN;
    const vth = 331.3 + 0.606*Number(els.tempC.value);
    let csv='sample_rate,window_ms,threshold,min_gap_ms,pulse_ms,input_path\\n';
    csv += [sampleRate, els.windowMs.value, els.thresh.value, els.minGapMs.value, els.pulseMs.value, using].join(',')+'\\n\\n';
    csv += 't1_index,t2_index,dt_s,dist_m,v_measured_mps,v_theory_mps\\n';
    csv += [t1Index??'', t2Index??'', Number.isFinite(dt)?dt.toFixed(6):'', D, Number.isFinite(v)?v.toFixed(2):'', vth.toFixed(2)].join(',')+'\\n';
    csv += '\\nindex,amplitude\\n';
    for(let i=0;i<captured.length;i++){ csv += i+','+(captured[i].toFixed(6))+'\\n'; }
    const blob=new Blob([csv],{type:'text/csv'}); const a=document.createElement('a'); a.download='sound_speed_measurement.csv'; a.href=URL.createObjectURL(blob); a.click();
  }

  // Wire buttons
  els.btnStart.addEventListener('click', async ()=>{
    try { await startMic(); } catch(e){ alert('マイク開始に失敗: '+e); }
  });
  els.btnRefresh.addEventListener('click', async ()=>{
    selectedMicId = els.micSelect.value;
    selectedSpkId = els.spkSelect.value;
    await refreshDevices();
    await applySpeakerRoute();
  });
  els.micSelect.addEventListener('change', ()=>{ selectedMicId = els.micSelect.value; });
  els.spkSelect.addEventListener('change', async ()=>{ selectedSpkId = els.spkSelect.value; await applySpeakerRoute(); });

  els.btnPulse.addEventListener('click', ()=>{ if(!started) return; recordWithPulse(); });
  els.btnTestBeep.addEventListener('click', ()=>{ if(!started) return; playPulse(Number(els.pulseMs.value)); });
  els.btnReset.addEventListener('click', ()=>{ captured=new Float32Array(0); t1Index=t2Index=null; setFullView(); drawWave(); updateDT(); });
  els.btnAuto.addEventListener('click', autoDetect);
  els.btnCompute.addEventListener('click', updateDT);
  els.btnPng.addEventListener('click', savePNG);
  els.btnCsv.addEventListener('click', saveCSV);

  // 初期描画
  drawWave();
})();
