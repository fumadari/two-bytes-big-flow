// Two Bytes, Big Flow — Self-contained BG demo (no external deps)
// Toy-but-faithful mechanics: 2-phase intersection, 2-byte broadcasts, consensus gate, tiny logit push

// Canvas + UI handles
const canvas = document.getElementById('sim');
const ctx = canvas.getContext('2d');
const bgToggle = document.getElementById('bgToggle');
const compareToggle = document.getElementById('compareToggle');
const toast = document.getElementById('toast');
const badge = document.getElementById('badge');

// Minimal metrics elements
const p95El = document.getElementById('p95');
const flowEl = document.getElementById('flow');
const idleEl = document.getElementById('idle');

// Utility
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a=0, b=1) => a + Math.random() * (b - a);

// μ-law companding helpers
function muEncode(x, mu = 15) {
  x = clamp(x, -1, 1);
  const y = Math.sign(x) * Math.log(1 + mu * Math.abs(x)) / Math.log(1 + mu);
  return Math.round(y * 127); // int8
}
function muDecode(b, mu = 15) {
  const y = clamp(b / 127, -1, 1);
  return Math.sign(y) * ((1 + mu) ** Math.abs(y) - 1) / mu;
}

// Colors
const COL = {
  grid: '#1b244a',
  road: '#0d1230',
  lane: '#12183f',
  carH: '#6de5c9',
  carV: '#8fa8ff',
  red: '#ff6b6b',
  green: '#4ad57f',
  yellow: '#ffc066',
  text: '#e6ebff',
  muted: '#aab3cf',
  bubbleH: '#3de5bb',
  bubbleV: '#6c89ff',
  pktGlow: '#88ffd6',
  pktGlowV: '#b0bfff',
};

// Geometry (responsive)
let W=0, H=0, cx=0, cy=0, roadW=0, stopOffset=0, laneGap=0, nearGateDist=0;
function recomputeGeom(){
  const stage = document.getElementById('stage');
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.max(320, stage.clientWidth);
  const cssH = Math.max(240, stage.clientHeight);
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  W = cssW; H = cssH; cx = W/2; cy = H/2;
  const s = Math.min(W,H);
  roadW = clamp(s*0.42, 170, 320);
  stopOffset = clamp(s*0.16, 50, 140);
  laneGap = clamp(s*0.04, 16, 34);
  nearGateDist = clamp(s*0.16, 50, 120);
}

// Sim params
let params = {
  fps: 30,
  dt: 1, // step
  minGreen: 60,
  maxGreen: 180,
  switchThresh: 3, // cars
  cycleC: 4, // steps per cycle aggregation for bitrate
  packetLoss: 0.6,
  loadPerAxis: 0.9, // cars per second per axis
  burstiness: 0.4,
  TTL: 30, // steps
  tauFresh: 20,
  sigmaDist: 60,
  rhoMin: 0.2,
  kLowInfo: 20, // steps to stretch min green
  kConsensus: 1.5,
  deltaLogit: 0.7,
  clipA: 1.2,
  fairnessCap: 220, // max other wait before forcing switch
};

let state;
let embedMode = false;
let presetBG = null;
let embedId = null; // 'off' | 'on'
let compareStats = { off: null, on: null };

function resetSim() {
  state = {
    t: 0,
    cars: [], // each car: {axis:'H'|'V', dir:1|-1, x,y, v, nearGate, arrivedAt, waited, logit}
    phase: 'H',
    greenAge: 0,
    minGreen0: params.minGreen,
    lastCrossCount: 0,
    packets: { H: [], V: [] }, // {b0,b1,ts,age}
    agg: { H:{U:0,rho:0}, V:{U:0,rho:0} },
    metrics: {
      waits: [],
      flowCount: 0,
      steps: 0,
      greenIdleSteps: 0,
      greenSteps: 0,
      servedH: 0,
      servedV: 0,
      bitsSent: 0,
      agentsNear: 0,
    },
    shock: {active:false, axis:'H', until:0},
    effMinGreen: params.minGreen,
    vis: {
      packets: [], // {axis, x0,y0, x1,y1, t:0..1}
      pulses: {H:0, V:0},
      pushFlashes: [], // {x,y, axis, dir, life}
    }
  };
  // preload some cars to show queues quickly
  for (let i=0;i<10;i++) spawnCar('H');
  for (let i=0;i<10;i++) spawnCar('V');
}

// Spawning process (bursty Poisson)
function spawnProcess(axis) {
  const baseRate = params.loadPerAxis; // cars/s
  const dt = 1/params.fps; // seconds per frame (approx)
  let rate = baseRate;
  if (state.shock.active && state.shock.axis === axis) rate *= 2.2;
  // burstiness: mix Poisson with on/off process
  const on = Math.random() < (0.3 + 0.7*params.burstiness);
  const eff = lerp(1.0, on ? 1.8 : 0.5, params.burstiness);
  rate *= eff;
  const p = rate * dt; // Bernoulli approx
  if (Math.random() < p) spawnCar(axis);
}

function spawnCar(axis) {
  // Choose direction: for H, left->right or right->left; for V, up->down or down->up
  const dir = Math.random()<0.5 ? 1 : -1;
  const speed = 2 + Math.random()*0.5; // px per step (slow to show queues)
  let x,y;
  if (axis==='H') {
    y = cy + (dir===1? -laneGap: laneGap);
    x = dir===1? -W*0.1 - Math.random()*200 : W*1.1 + Math.random()*200;
  } else {
    x = cx + (dir===1? laneGap: -laneGap);
    y = dir===1? -H*0.1 - Math.random()*200 : H*1.1 + Math.random()*200;
  }
  state.cars.push({axis, dir, x, y, v: speed, nearGate:false, arrivedAt: state.t, waited:0, logit: 0});
}

// Broadcast: each near-gate car encodes urgency (queue depth/time waiting) and distance bin
function maybeBroadcast(car) {
  // near gate check
  const d = distToStop(car);
  const near = d <= nearGateDist;
  car.nearGate = near;
  if (!near) return;
  // urgency: blend of normalized queue length and waiting time
  const qLen = queueDepthAhead(car);
  const urg = clamp(0.7*norm(qLen, 0, 8) + 0.3*norm(car.waited, 0, 240), -1, 1);
  const b0 = muEncode(urg);
  const axisBit = (car.axis==='H'?0:1);
  const distBin = clamp(Math.floor((nearGateDist - d)/ (nearGateDist/127)), 0, 127);
  const b1 = (axisBit<<7) | distBin;
  // send with loss
  if (Math.random() < params.packetLoss) return; // dropped
  state.packets[car.axis].push({b0, b1, ts: state.t, age:0});
  state.metrics.bitsSent += 16; // two bytes
  // visual packet animation towards axis aggregator (sample to avoid overwhelm)
  const visProb = bgToggle.checked ? 0.45 : 0.12;
  if (Math.random() < visProb){
    const {x:x1, y:y1} = aggregatorPos(car.axis);
    const arr = state.vis.packets;
    if (arr.length > 40) arr.shift();
    arr.push({axis:car.axis, x0:car.x, y0:car.y-10, x1, y1, t:0});
  }
}

function norm(x, lo, hi){ return clamp((x-lo)/(hi-lo+1e-6), 0, 1)*2-1; } // [-1,1]

// Aggregate consensus per axis
function fusePackets(axis) {
  const pkts = state.packets[axis];
  const alive = [];
  let numAgents = 0;
  let sumW=0, sumUW=0;
  for (const p of pkts) {
    p.age = state.t - p.ts;
    if (p.age > params.TTL) continue;
    const u = muDecode(p.b0); // [-1,1]
    const distBin = p.b1 & 0x7F;
    const d = (1 - distBin/127) * nearGateDist; // invert encoding
    const w = Math.exp(-p.age/params.tauFresh) * Math.exp(-d/params.sigmaDist);
    sumW += w;
    sumUW += u*w;
    alive.push(p);
    numAgents++;
  }
  state.packets[axis] = alive;
  const U = sumW>0 ? clamp(sumUW/(sumW+1e-6), -1, 1) : 0;
  const rho = clamp(sumW / 12.0, 0, 1); // W_ref ~ 12
  state.agg[axis] = {U, rho};
  state.metrics.agentsNear = Math.max(state.metrics.agentsNear, numAgents);
}

function distToStop(car){
  if (car.axis==='H') {
    const stopX = cx + (car.dir===1 ? -stopOffset : stopOffset);
    return Math.max(0, Math.abs(stopX - car.x));
  } else {
    const stopY = cy + (car.dir===1 ? -stopOffset : stopOffset);
    return Math.max(0, Math.abs(stopY - car.y));
  }
}

function queueDepthAhead(car){
  // count cars on same axis and approaching same stop line and closer to stop than this car
  let count=0;
  for (const c of state.cars){
    if (c===car || c.axis!==car.axis || c.dir!==car.dir) continue;
    const dSelf = distToStop(car), dOther = distToStop(c);
    if (dOther < dSelf && dOther <= nearGateDist + 50) count++;
  }
  return count;
}

function leadCar(axis){
  // select closest near-gate car at the active stop line for that axis
  let best=null, bestD=1e9;
  for (const c of state.cars){
    if (c.axis!==axis) continue;
    const d = distToStop(c);
    if (d < bestD && d<=nearGateDist) {best=c; bestD=d;}
  }
  return best;
}

// Phase scheduler
function schedulerStep() {
  const cur = state.phase;
  const other = cur==='H'? 'V':'H';
  state.greenAge += 1;
  const rho = state.agg[cur].rho;
  const Uother = state.agg[other].U;
  const qCur = axisQueue(cur), qOther = axisQueue(other);

  // track green/no-demand
  state.metrics.greenSteps++;
  if (qCur.totalNear === 0) state.metrics.greenIdleSteps++;

  const minG = params.minGreen + (bgToggle.checked? params.kLowInfo * (1 - rho): 0);
  state.effMinGreen = minG;
  const maxG = params.maxGreen;
  const qDiff = qOther.totalNear - qCur.totalNear; // "advantage" of other axis
  const thresh = params.switchThresh + (bgToggle.checked? (1 - rho)*1.5 : 0);

  let forceSwitch = false;
  if (state.greenAge < minG) return; // enforce min green
  if (qOther.maxWait > params.fairnessCap) forceSwitch = true;
  if (state.greenAge >= maxG) forceSwitch = true;

  if (!bgToggle.checked) {
    if (forceSwitch || qDiff > thresh) switchPhase();
    return;
  }
  // BG ON: use consensus to resist switching unless confident advantage
  const demoBoost = 1.4; // exaggerate for clarity when BG is ON
  const adjDiff = qDiff - (params.kConsensus*demoBoost) * Uother;
  if (forceSwitch || adjDiff > thresh) switchPhase();
}

function switchPhase(){
  state.phase = (state.phase==='H')? 'V':'H';
  state.greenAge = 0;
}

function axisQueue(axis){
  // compute total near-gate count and max wait on that axis
  let totalNear=0, maxWait=0;
  for (const c of state.cars){
    if (c.axis!==axis) continue;
    if (distToStop(c) <= nearGateDist+2) {
      totalNear++;
      maxWait = Math.max(maxWait, c.waited);
    }
  }
  return {totalNear, maxWait};
}

// Movement & crossing rules
function moveCars(){
  const speed = 2.0;
  for (const car of state.cars){
    let canGo = false;
    // check if at stop line and green
    const atStop = distToStop(car) < 5;
    const green = (car.axis === state.phase);
    if (green && atStop) {
      // probability to go depends on logistic(logit)
      const pGo = 1/(1+Math.exp(-car.logit));
      if (Math.random()<pGo) canGo = true;
    }
    if (!atStop) {
      // approach, but keep distance from car ahead
      const ahead = frontCar(car);
      let v = speed;
      if (ahead){
        const gap = distance(car, ahead);
        if (gap < 20) v = 0; else if (gap < 40) v *= 0.25; else if (gap < 60) v *= 0.6;
      }
      if (!green && willCross(car, v)) v = 0; // stop at red
      advance(car, v * car.dir);
    } else if (canGo) {
      // cross intersection
      advance(car, 12 * car.dir);
      // count crossing once
      state.metrics.flowCount++;
      if (car.axis==='H') state.metrics.servedH++; else state.metrics.servedV++;
      // reset logit and waited
      car.waited = 0; car.logit = 0; car.arrivedAt = state.t;
    } else {
      // at stop line but not going
      // nothing to do; will wait
    }
  }
  // remove cars that fully exited screen and respawn to sustain flow
  state.cars = state.cars.filter(c => inBounds(c));
}

function inBounds(c){
  return c.x>-200 && c.x<W+200 && c.y>-200 && c.y<H+200;
}

function frontCar(car){
  // find closest car ahead on same lane
  let best=null, bestDist=1e9;
  for (const c of state.cars){
    if (c===car || c.axis!==car.axis || c.dir!==car.dir) continue;
    const d = distance(car, c);
    if (d>0 && d<bestDist) {best=c; bestDist=d;}
  }
  return best;
}

function distance(a,b){
  if (a.axis==='H') return (b.x - a.x) * a.dir;
  return (b.y - a.y) * a.dir;
}

function willCross(c, vStep){
  // would cross the stop line under vStep?
  if (c.axis==='H'){
    const stopX = cx + (c.dir===1 ? -stopOffset : stopOffset);
    const nx = c.x + vStep;
    return (c.dir===1) ? (c.x < stopX && nx >= stopX) : (c.x > stopX && nx <= stopX);
  } else {
    const stopY = cy + (c.dir===1 ? -stopOffset : stopOffset);
    const ny = c.y + vStep;
    return (c.dir===1) ? (c.y < stopY && ny >= stopY) : (c.y > stopY && ny <= stopY);
  }
}

function advance(c, delta){
  if (c.axis==='H') c.x += delta; else c.y += delta;
}

// Tiny logit push near gate (BG ON). Only on active axis, lead car.
function applyBGPush(){
  if (!bgToggle.checked) return;
  const axis = state.phase;
  const lead = leadCar(axis);
  const cons = state.agg[axis];
  if (!lead || !lead.nearGate) return;
  if (cons.rho <= params.rhoMin) return;
  const push = clamp(cons.U, -1, 1) * params.deltaLogit * 1.6; // demo boost
  // safety: never push against red; we only push on active axis
  lead.logit = clamp(lead.logit + push, -params.clipA, params.clipA);
  if (push > 0.02) {
    state.vis.pushFlashes.push({x:lead.x, y:lead.y, axis, dir:lead.dir, life:18});
  }
}

// Update waits and logits for all cars
function updateWaits(){
  for (const c of state.cars){
    const atStop = distToStop(c) < 5;
    const green = (c.axis===state.phase);
    // increase waiting timer if near gate and not moving
    if (distToStop(c) <= nearGateDist) c.waited += 1;
    // baseline: base logit small; if at stop and green, gently rises with wait
    if (atStop && green){
      const base = clamp((c.waited/60) - 0.2, -1, 2); // baseline pressure
      c.logit = clamp(lerp(c.logit, base, 0.15), -params.clipA, params.clipA);
    } else if (!green && atStop) {
      // hard-stop on red: decrease logit
      c.logit = clamp(lerp(c.logit, -1.5, 0.4), -params.clipA, params.clipA);
    } else {
      // far away: decay to 0
      c.logit = lerp(c.logit, 0, 0.1);
    }
  }
}

// Update metrics periodically
let metricAccum = {flowWindow:0};
function updateMetrics(){
  const m = state.metrics;
  m.steps++;
  // estimate waits: capture per-crossing wait by sampling lead near gate that crosses
  // Here we approximate: sample waits of cars at near gate
  // For p95 we keep rolling window of waits of cars whose waited just reset after crossing
  // Already handled when crossing increments served counters; but we didn't record waits specifically.
  // Approx: every 30 steps, store the 95th percentile of current near-gate waits into array.
  if (m.steps % 30 === 0){
    const waits = state.cars.filter(c => c.nearGate).map(c => c.waited);
    if (waits.length>0) m.waits.push(percentile(waits, 0.95));
    if (m.waits.length>200) m.waits.shift();
  }
  // Near-gate flow per 1000 steps (normalized)
  metricAccum.flowWindow += 1;
  if (metricAccum.flowWindow >= 1000){
    metricAccum.flowWindow = 0;
  }

  // UI update every ~0.5s
  if (m.steps % 15 === 0){
    const p95 = m.waits.length? avg(m.waits.slice(-30)) : 0;
    p95El.textContent = p95.toFixed(1);

    const flowRate = (m.flowCount / Math.max(1, m.steps)) * 1000;
    flowEl.textContent = flowRate.toFixed(1);

    const idlePct = m.greenSteps>0? (m.greenIdleSteps/m.greenSteps*100):0;
    idleEl.textContent = idlePct.toFixed(1);
    if (embedMode){
      // report up to parent for compare badge
      try{
        window.parent.postMessage({type:'metrics', id: embedId, p95, flow: flowRate, idle: idlePct}, '*');
      }catch(e){}
    }
  }
}

// Visual updates
function updateVisuals(){
  // animate packet particles
  const speed = 0.08; // progress per frame
  const next = [];
  for (const p of state.vis.packets){
    p.t += speed;
    if (p.t >= 1){
      // pulse the corresponding gauge
      state.vis.pulses[p.axis] = 1.0;
    } else next.push(p);
  }
  state.vis.packets = next;
  // decay pulses
  state.vis.pulses.H *= 0.85;
  state.vis.pulses.V *= 0.85;
  // decay push flashes
  const pf=[]; for (const f of state.vis.pushFlashes){ f.life -= 1; if (f.life>0) pf.push(f);} state.vis.pushFlashes = pf;
}

function avg(a){ return a.reduce((s,x)=>s+x,0)/a.length; }
function percentile(arr, p){
  const a = [...arr].sort((x,y)=>x-y);
  const idx = clamp(Math.floor((a.length-1)*p), 0, a.length-1);
  return a[idx];
}

// Rendering
function draw(){
  ctx.clearRect(0,0,W,H);
  drawRoads();
  drawSignals();
  drawConsensusGauges();
  drawPacketAnimations();
  drawCars();
  drawPushFlashes();
}

function drawRoads(){
  // roads
  ctx.fillStyle = COL.road;
  ctx.fillRect(cx-roadW/2, 0, roadW, H);
  ctx.fillRect(0, cy-roadW/2, W, roadW);
  // center box
  ctx.fillStyle = COL.grid;
  ctx.fillRect(cx-roadW/2, cy-roadW/2, roadW, roadW);
  // stop lines
  ctx.strokeStyle = '#fff7'; ctx.lineWidth = 2; ctx.setLineDash([6,6]);
  // vertical lane stop lines (for H axis)
  ctx.beginPath();
  ctx.moveTo(cx-stopOffset, cy-roadW/2); ctx.lineTo(cx-stopOffset, cy+roadW/2);
  ctx.moveTo(cx+stopOffset, cy-roadW/2); ctx.lineTo(cx+stopOffset, cy+roadW/2);
  ctx.stroke();
  // horizontal lane stop lines (for V axis)
  ctx.beginPath();
  ctx.moveTo(cx-roadW/2, cy-stopOffset); ctx.lineTo(cx+roadW/2, cy-stopOffset);
  ctx.moveTo(cx-roadW/2, cy+stopOffset); ctx.lineTo(cx+roadW/2, cy+stopOffset);
  ctx.stroke(); ctx.setLineDash([]);
}

function drawSignals(){
  // show current green axis
  const isH = state.phase==='H';
  // signal circles
  drawLight(cx - stopOffset, cy - roadW/2 - 18, isH);
  drawLight(cx + stopOffset, cy + roadW/2 + 18, isH);
  drawLight(cx - roadW/2 - 18, cy - stopOffset, !isH);
  drawLight(cx + roadW/2 + 18, cy + stopOffset, !isH);

  // min-green stretch bar (subtle): only show if stretched > 6 steps
  const base = params.minGreen, eff = state.effMinGreen;
  if (eff - base > 6){
    const pct = clamp(state.greenAge / Math.max(1, eff), 0, 1);
    const barW = 160, barH = 6;
    const x = cx - barW/2, y = 14;
    ctx.fillStyle = '#223'; ctx.fillRect(x, y, barW, barH);
    const baseW = Math.min(barW, barW * Math.min(1, base/eff));
    ctx.fillStyle = '#3a4d9a'; ctx.fillRect(x, y, baseW*pct, barH);
    const stretchW = barW - baseW;
    ctx.fillStyle = '#5cd7ffcc';
    ctx.fillRect(x+baseW, y, stretchW*pct, barH);
  }
}

function drawLight(x,y,green){
  ctx.beginPath();
  ctx.arc(x,y,10,0,Math.PI*2);
  ctx.fillStyle = green? COL.green : COL.red;
  ctx.fill();
}

function drawConsensusGauges(){
  // two gauges near top corners
  drawGauge(90, 60, state.agg.H.U, state.agg.H.rho, 'H', state.vis.pulses.H);
  drawGauge(W-90, 60, state.agg.V.U, state.agg.V.rho, 'V', state.vis.pulses.V);
}

function drawGauge(x, y, U, rho, label, pulse=0){
  const r = 36; const t = 6;
  ctx.save();
  ctx.translate(x,y);
  ctx.beginPath();
  ctx.arc(0,0,r,0,Math.PI*2);
  ctx.strokeStyle = '#2a346a'; ctx.lineWidth = t; ctx.stroke();
  // outer ring confidence
  ctx.beginPath();
  ctx.arc(0,0,r+6+pulse*3, -Math.PI/2, -Math.PI/2 + rho*2*Math.PI);
  ctx.strokeStyle = COL.accent; ctx.lineWidth = 3 + pulse*2; ctx.globalAlpha = 0.8;
  ctx.stroke(); ctx.globalAlpha = 1;
  // needle for U
  const ang = (U*0.5 + 0.5) * 2*Math.PI; // map [-1,1] to [0,2π]
  ctx.beginPath();
  ctx.moveTo(0,0); ctx.lineTo((r-8)*Math.cos(ang), (r-8)*Math.sin(ang));
  ctx.strokeStyle = COL.accent2; ctx.lineWidth = 2; ctx.stroke();
  // text
  ctx.fillStyle = COL.text; ctx.font='bold 12px sans-serif'; ctx.textAlign='center';
  ctx.fillText(`${label}`, 0, 4);
  ctx.restore();
}

function drawPacketAnimations(){
  for (const p of state.vis.packets){
    const t = p.t;
    const x = p.x0 + (p.x1 - p.x0)*t;
    const y = p.y0 + (p.y1 - p.y0)*t;
    // trail
    ctx.strokeStyle = p.axis==='H'? COL.pktGlow : COL.pktGlowV;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.moveTo(p.x0, p.y0); ctx.lineTo(x,y); ctx.stroke();
    ctx.globalAlpha = 1;
    // packet dot
    ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2);
    ctx.fillStyle = p.axis==='H'? COL.bubbleH : COL.bubbleV; ctx.fill();
    // no 2B label to reduce clutter
  }
}

function drawPushFlashes(){
  for (const f of state.vis.pushFlashes){
    const a = f.life/18;
    const len = 28*(1-a*0.2);
    const w = 10;
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.axis==='H' ? 0 : Math.PI/2);
    // orientation by dir
    const dir = f.dir>0 ? 1 : -1;
    ctx.scale(dir,1);
    ctx.globalAlpha = 0.6*a;
    ctx.fillStyle = '#7ef7c9';
    ctx.beginPath();
    ctx.moveTo(8, -w/2); ctx.lineTo(8+len, 0); ctx.lineTo(8, w/2); ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1; ctx.restore();
  }
}

function aggregatorPos(axis){
  return axis==='H' ? {x:90, y:60} : {x:W-90, y:60};
}

function drawCars(){
  for (const c of state.cars){
    const w=14,h=8;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.axis==='H'?0:Math.PI/2);
    ctx.fillStyle = c.axis==='H'? COL.carH : COL.carV;
    ctx.fillRect(-w/2,-h/2,w,h);
    ctx.restore();

    // 2-byte bubble for near-gate cars
    if (c.nearGate){
      const urg = clamp(0.7*norm(queueDepthAhead(c),0,8) + 0.3*norm(c.waited,0,240), -1, 1);
      const b0 = muEncode(urg);
      const distBin = clamp(Math.floor((nearGateDist - distToStop(c))/ (nearGateDist/127)), 0, 127);
      drawBubble(c.x, c.y - 14, b0, distBin, c.axis);
    }
  }
}

function drawBubble(x,y,b0,dbin,axis){
  const color = axis==='H'? COL.bubbleH : COL.bubbleV;
  ctx.save();
  ctx.translate(x,y);
  ctx.fillStyle = '#0009';
  ctx.strokeStyle = color; ctx.lineWidth=1;
  ctx.beginPath();
  ctx.roundRect?.( -18, -10, 36, 18, 4 );
  if (!ctx.roundRect){ ctx.rect(-18,-10,36,18); }
  ctx.fill(); ctx.stroke();
  // bar for |b0|
  const mag = Math.abs(b0)/127;
  ctx.fillStyle = color;
  ctx.fillRect(-16, -6, 32*mag, 4);
  // dist bin text
  ctx.fillStyle = COL.muted; ctx.font='9px monospace'; ctx.textAlign='center';
  ctx.fillText(dbin.toString(), 0, 8);
  ctx.restore();
}

// Main loop
let lastTs = performance.now();
function tick(ts){
  const dt = (ts - lastTs)/ (1000/params.fps);
  lastTs = ts;
  // step once per frame (fixed dt)
  step();
  draw();
  requestAnimationFrame(tick);
}

function step(){
  state.t += 1;
  // spawn
  spawnProcess('H');
  spawnProcess('V');

  // reset near flags
  for (const c of state.cars) c.nearGate=false;

  // broadcasts
  for (const c of state.cars) maybeBroadcast(c);
  fusePackets('H');
  fusePackets('V');

  // waits & base logits
  updateWaits();
  // BG push
  applyBGPush();
  // move
  moveCars();
  // schedule
  schedulerStep();
  // metrics
  updateMetrics();
  // visuals
  updateVisuals();

  // shock decay
  if (state.shock.active && state.t > state.shock.until) state.shock.active=false;
}

// Minimal UI: tap-to-toggle + switch
function showToast(msg){
  toast.textContent = msg; toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(()=>{ toast.hidden = true; }, 1200);
}
canvas.addEventListener('click', ()=>{
  if (embedMode) return;
  bgToggle.checked = !bgToggle.checked;
  showToast(bgToggle.checked? 'BG ON' : 'BG OFF');
});
bgToggle.addEventListener('change', ()=>{
  if (embedMode) return;
  showToast(bgToggle.checked? 'BG ON' : 'BG OFF');
});

// Boot
function init(){
  // URL params: embed=1 for iframe mode, bg=1 to start with BG
  const usp = new URLSearchParams(location.search);
  embedMode = usp.get('embed') === '1';
  presetBG = usp.get('bg');
  embedId = usp.get('id');

  recomputeGeom();
  window.addEventListener('resize', recomputeGeom);

  if (embedMode){
    document.querySelector('.topbar')?.classList.add('hidden');
    document.querySelector('.footnote')?.classList.add('hidden');
    compareToggle?.closest('.toggleWrap')?.classList.add('hidden');
    // lock BG per preset
    bgToggle.checked = presetBG === '1';
    bgToggle.disabled = true;
    canvas.title = '';
    badge.hidden = false; badge.textContent = bgToggle.checked? 'BG ON' : 'BG OFF';
  } else {
    bgToggle.checked = false;
    // compare mode wiring
    compareToggle.addEventListener('change', ()=>{
      const on = compareToggle.checked;
      document.getElementById('stage').style.display = on? 'none':'block';
      document.getElementById('compare').classList.toggle('hidden', !on);
      if (on){
        const off = document.getElementById('frameOff');
        const onf = document.getElementById('frameOn');
        off.src = location.pathname + '?embed=1&bg=0&id=off';
        onf.src = location.pathname + '?embed=1&bg=1&id=on';
      }
    });
    // default to compare ON
    compareToggle.checked = true;
    compareToggle.dispatchEvent(new Event('change'));
    // receive metrics from iframes
    window.addEventListener('message', (ev)=>{
      const d = ev.data || {};
      if (d.type === 'metrics' && (d.id==='off' || d.id==='on')){
        compareStats[d.id] = d;
        updateCompareBadge();
      }
    });
  }

  resetSim();
  requestAnimationFrame(tick);
}

function updateCompareBadge(){
  const el = document.getElementById('cmpBadge');
  const off = compareStats.off, on = compareStats.on;
  if (!el) return;
  if (!off || !on){ el.textContent = 'BG advantage: —'; return; }
  // Use throughput flow (/1k steps) as simple intuitive metric
  const adv = ((on.flow - off.flow) / Math.max(1e-6, off.flow)) * 100;
  const sign = adv>=0 ? '+' : '';
  el.textContent = `BG advantage: ${sign}${adv.toFixed(0)}% throughput`;
}

init();
