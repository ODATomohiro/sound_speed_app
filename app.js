// 音速測定アプリ（Web Audio）Mac/Safari/Chrome フォールバック対応
(() => {
  const els = {
    btnStart: document.getElementById('btnStart'),
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
    btnPng: document.getElementById('btnPng'),
    dist: document.getElementById('dist'),
    tempC: document.getElementById('tempC'),
    dtVal: document.getElementById('dtVal'),
    vMeasured: document.getElementById('vMeasured'),
    vTheory: document.getElementById('vTheory'),
    btnCompute: document.getElementById('btnCompute'),
    btnCsv: document.getElementById('btnCsv'),
  };

  // 状態
  let audioCtx = null;
  let micStream = null;
  let micNode = null;
  let workletNode = null;
  let scriptNode = null;
  let outGain = null;
  let started = false;
  let sampleRate = 48000;
  let using = null; // 'worklet' | 'script'

  // 収録バッファ
  let captured = new Float32Array(0);
  let capturing = false;
  let t1Index = null;
  let t2Index = null;

  function bindRange(input, outSpan) {
    const update = () => outSpan.textContent = Number(input.value).toFixed(input.step && input.step.includes('.') ? input.step.split('.')[1].length : 0);
    input.addEventListener('input', update);
    update();
  }
  bindRange(els.thresh, els.threshVal);
  bindRange(els.minGapMs, els.minGapVal);
  bindRange(els.windowMs, els.windowVal);
  bindRange(els.pulseMs, els.pulseVal);

  async function ensureAudioReady() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    sampleRate = audioCtx.sampleRate;

    outGain = audioCtx.createGain();
    outGain.gain.value = 0.9;
    outGain.connect(audioCtx.destination);

    // Worklet を優先、失敗したら ScriptProcessor にフォールバック
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
    } catch (e) {
      using = 'script';
      console.warn('AudioWorklet が使えないため ScriptProcessor にフォールバックします:', e);
    }
  }

  async function startMic() {
    await ensureAudioReady();
    // getUserMedia（SafariはHTTPS/localhost必須）
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    });
    micNode = audioCtx.createMediaStreamSource(micStream);

    if (using === 'worklet') {
      workletNode = new AudioWorkletNode(audioCtx, 'mic-capture-processor', { numberOfInputs: 1, numberOfOutputs: 0 });
      workletNode.port.onmessage = (e) => onMicChunk(e.data);
      micNode.connect(workletNode);
    } else {
      // ScriptProcessor フォールバック
      const bufferSize = 1024;
      scriptNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);
      scriptNode.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        // コピーして転送
        const copy = new Float32Array(input.length);
        copy.set(input);
        onMicChunk(copy);
      };
      micNode.connect(scriptNode);
      scriptNode.connect(audioCtx.destination); // Safariで必要な場合あり
    }

    started = true;
    enableButtons(true);
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

  function resetAll() {
    captured = new Float32Array(0);
    t1Index = null; t2Index = null;
    drawWave(); updateDT();
  }

  function onMicChunk(chunk) {
    if (!capturing) return;
    const merged = new Float32Array(captured.length + chunk.length);
    merged.set(captured, 0);
    merged.set(chunk, captured.length);
    captured = merged;
  }

  function makePulseBuffer(ms = 5) {
    const length = Math.max(1, Math.round(sampleRate * (ms / 1000)));
    const buf = audioCtx.createBuffer(1, length, sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < length; i++) {
      const w = Math.random() * 2 - 1;
      const env = 1 - i / length;
      data[i] = w * env * 0.8;
    }
    return buf;
  }

  function playPulse(ms = 5) {
    const src = audioCtx.createBufferSource();
    src.buffer = makePulseBuffer(ms);
    const hpf = audioCtx.createBiquadFilter();
    hpf.type = 'highpass'; hpf.frequency.value = 200;
    src.connect(hpf).connect(outGain);
    src.start();
  }

  function recordWithPulse() {
    const windowMs = Number(els.windowMs.value);
    const pulseMs = Number(els.pulseMs.value);
    capturing = true;
    captured = new Float32Array(0);

    playPulse(pulseMs);

    setTimeout(() => {
      capturing = false;
      drawWave();
    }, windowMs);
  }

  function autoDetect() {
    if (!captured || captured.length === 0) return;
    const thresh = Number(els.thresh.value);
    const minGapMs = Number(els.minGapMs.value);
    const minGapSamples = Math.round(sampleRate * (minGapMs / 1000));

    const N = captured.length;
    const abs = new Float32Array(N);
    for (let i = 0; i < N; i++) abs[i] = Math.abs(captured[i]);
    const win = Math.max(8, Math.round(sampleRate * 0.0008));
    const env = new Float32Array(N);
    let sum = 0;
    for (let i = 0; i < N; i++) {
      sum += abs[i];
      if (i >= win) sum -= abs[i - win];
      env[i] = sum / Math.min(i + 1, win);
    }

    let t1 = null;
    for (let i = 0; i < N; i++) if (env[i] > thresh) { t1 = i; break; }
    if (t1 === null) { alert('発音（t1）が検出できません。しきい値/音量/録音窓を調整。'); return; }

    let t2 = null;
    for (let i = t1 + minGapSamples; i < N; i++) if (env[i] > thresh) { t2 = i; break; }
    if (t2 === null) { alert('反射（t2）が検出できません。距離/音量/しきい値を調整。'); return; }

    t1Index = t1;
    t2Index = refinePeakNear(env, t2, Math.round(sampleRate * 0.002));
    drawWave(); updateDT();
  }

  function refinePeakNear(arr, idx, radius) {
    const N = arr.length;
    let bestIdx = idx, bestVal = arr[idx] || 0;
    for (let i = Math.max(0, idx - radius); i <= Math.min(N - 1, idx + radius); i++) {
      if (arr[i] > bestVal) { bestVal = arr[i]; bestIdx = i; }
    }
    return bestIdx;
  }

  const ctx = els.wave.getContext('2d');
  function drawWave() {
    const W = els.wave.width, H = els.wave.height;
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle = '#0b1020'; ctx.fillRect(0,0,W,H);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
    for (let y=0; y<=H; y+=50) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

    if (!captured || captured.length === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '14px system-ui';
      ctx.fillText('ここに波形が表示されます（②で記録）', 16, 24); return;
    }
    const N = captured.length;
    ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor(N * x / W);
      const i1 = Math.floor(N * (x+1) / W);
      let lo = 1e9, hi = -1e9;
      for (let i = i0; i < i1; i++) { const v = captured[i] || 0; if (v < lo) lo = v; if (v > hi) hi = v; }
      const yLo = H/2 - lo * (H*0.45), yHi = H/2 - hi * (H*0.45);
      ctx.moveTo(x, yLo); ctx.lineTo(x, yHi);
    }
    ctx.stroke();

    drawMarker(t1Index, '#22c55e'); drawMarker(t2Index, '#f97316');
    function drawMarker(idx, color){ if (idx==null) return; const x = Math.round(idx * W / N); ctx.strokeStyle=color; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }

    ctx.fillStyle='rgba(255,255,255,0.7)'; ctx.font='12px system-ui';
    const totalMs = (N / sampleRate) * 1000; ctx.fillText(`長さ: ${totalMs.toFixed(1)} ms  /  サンプリング: ${sampleRate} Hz  /  入力: ${using||'unknown'}`, 16, H-10);
  }

  function xToIndex(x) {
    if (!captured || captured.length === 0) return 0;
    const W = els.wave.width, N = captured.length;
    const clamped = Math.max(0, Math.min(W, x));
    return Math.round(N * clamped / W);
  }

  let clickMode = null;
  els.btnSetT1.addEventListener('click', () => { clickMode = 't1'; });
  els.btnSetT2.addEventListener('click', () => { clickMode = 't2'; });
  els.btnClearMarks.addEventListener('click', () => { t1Index = null; t2Index = null; drawWave(); updateDT(); });

  els.wave.addEventListener('click', (ev) => {
    if (!clickMode) return;
    const rect = els.wave.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const idx = xToIndex(x);
    if (clickMode === 't1') t1Index = idx;
    if (clickMode === 't2') t2Index = idx;
    clickMode = null;
    drawWave(); updateDT();
  });

  function updateDT() {
    if (t1Index == null || t2Index == null || !captured || captured.length === 0) {
      els.dtVal.textContent = '–'; els.vMeasured.textContent = '–'; updateTheory(); return;
    }
    const dt = Math.abs(t2Index - t1Index) / sampleRate;
    els.dtVal.textContent = dt.toFixed(6);
    const D = Number(els.dist.value);
    if (D > 0 && dt > 0) els.vMeasured.textContent = (2*D/dt).toFixed(2); else els.vMeasured.textContent = '–';
    updateTheory();
  }

  function updateTheory() {
    const T = Number(els.tempC.value);
    els.vTheory.textContent = Number.isFinite(T) ? (331.3 + 0.606 * T).toFixed(2) : '–';
  }
  ['input','change'].forEach(evt => { els.tempC.addEventListener(evt, updateTheory); els.dist.addEventListener(evt, updateDT); });
  updateTheory();

  function savePNG(){ const a=document.createElement('a'); a.download='waveform.png'; a.href=els.wave.toDataURL('image/png'); a.click(); }
  function saveCSV(){
    const dt = (t1Index!=null&&t2Index!=null) ? Math.abs(t2Index - t1Index)/sampleRate : NaN;
    const D = Number(els.dist.value); const v = (Number.isFinite(dt)&&dt>0&&D>0)?(2*D/dt):NaN; const vth = 331.3 + 0.606*Number(els.tempC.value);
    let csv='sample_rate,window_ms,threshold,min_gap_ms,pulse_ms,input_path\\n';
    csv += [sampleRate, els.windowMs.value, els.thresh.value, els.minGapMs.value, els.pulseMs.value, using].join(',')+'\\n\\n';
    csv += 't1_index,t2_index,dt_s,dist_m,v_measured_mps,v_theory_mps\\n';
    csv += [t1Index??'', t2Index??'', Number.isFinite(dt)?dt.toFixed(6):'', D, Number.isFinite(v)?v.toFixed(2):'', vth.toFixed(2)].join(',')+'\\n';
    csv += '\\nindex,amplitude\\n';
    for (let i=0;i<captured.length;i++){ csv += i+','+ (captured[i].toFixed(6)) +'\\n'; }
    const blob=new Blob([csv],{type:'text/csv'}); const a=document.createElement('a'); a.download='sound_speed_measurement.csv'; a.href=URL.createObjectURL(blob); a.click();
  }

  els.btnStart.addEventListener('click', async () => {
    try { await startMic(); } catch (e) { alert('マイク開始に失敗: '+e+'\\n\\n(HTTPS/localhostでのアクセス、ブラウザのマイク許可、macOSのマイク許可を確認)'); }
  });
  els.btnPulse.addEventListener('click', () => { if (!started) return; resetAll(); recordWithPulse(); });
  els.btnTestBeep.addEventListener('click', () => { if (!started) return; playPulse(Number(els.pulseMs.value)); });
  els.btnReset.addEventListener('click', resetAll);
  els.btnAuto.addEventListener('click', autoDetect);
  els.btnCompute.addEventListener('click', updateDT);
  els.btnPng.addEventListener('click', savePNG);
  els.btnCsv.addEventListener('click', saveCSV);

  drawWave();
})();