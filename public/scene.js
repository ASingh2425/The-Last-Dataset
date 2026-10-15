(() => {
  'use strict';
  const canvas = document.getElementById('hero-scene');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let width = 1, height = 1, dpr = 1, mode = 'hero', quality = 'high', clarity = false;
  let mouseX = 0.52, mouseY = 0.42, targetX = 0.52, targetY = 0.42, lastMouse = 0, mouseSpeed = 0;
  let active = true, lastFrame = 0, loopScheduled = false, lurchAmount = 0, soundOn = false, audioContext = null, audioNodes = null;
  let particles = [], zombies = [], buildings = [], fires = [];
  const rand = (min, max) => min + Math.random() * (max - min);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  function initScene() {
    const count = quality === 'low' || clarity || reducedMotion ? 42 : 105;
    particles = Array.from({ length: count }, () => ({ x: Math.random(), y: Math.random(), r: rand(.4, 1.7), vx: rand(-.006, .006), vy: rand(.006, .035), a: rand(.1, .6), phase: rand(0, Math.PI * 2) }));
    zombies = Array.from({ length: clarity ? 7 : 13 }, (_, i) => ({ x: rand(.05, .95), y: rand(.55, .99), depth: rand(.4, 1), phase: rand(0, Math.PI * 2), speed: rand(.003, .012), turn: 0, lurch: 0, eyes: 0, width: rand(8, 19), height: rand(26, 56), toward: i % 2 ? 1 : -1 }));
    buildings = Array.from({ length: 45 }, (_, i) => ({ x: i / 45 + rand(-.01, .01), w: rand(.012, .04), h: rand(.07, .25), seed: Math.random() }));
    fires = Array.from({ length: 7 }, () => ({ x: rand(.1, .9), y: rand(.58, .9), r: rand(18, 58), phase: rand(0, 6) }));
  }
  function resize() {
    width = Math.max(1, window.innerWidth); height = Math.max(1, window.innerHeight);
    dpr = Math.min(window.devicePixelRatio || 1, quality === 'low' || clarity ? 1 : 1.45);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    initScene(); draw(performance.now(), true);
  }
  function drawSky(t) {
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, '#070b0e'); sky.addColorStop(.4, '#121b1d'); sky.addColorStop(.72, '#252723'); sky.addColorStop(1, '#080c0d');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, width, height);
    const fireGlow = ctx.createRadialGradient(width * .77, height * .64, 1, width * .77, height * .64, width * .48);
    fireGlow.addColorStop(0, 'rgba(198,91,48,.24)'); fireGlow.addColorStop(.36, 'rgba(132,64,42,.1)'); fireGlow.addColorStop(1, 'rgba(8,12,13,0)');
    ctx.fillStyle = fireGlow; ctx.fillRect(0, 0, width, height);
    const deadLight = ctx.createRadialGradient(width * .31, height * .35, 1, width * .31, height * .35, width * .54);
    deadLight.addColorStop(0, 'rgba(96,125,118,.085)'); deadLight.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = deadLight; ctx.fillRect(0, 0, width, height);
    // A ruined skyline with manually drawn silhouette buildings and occasional emergency lights.
    const baseY = height * .7;
    buildings.forEach((building, index) => {
      const x = building.x * width - (mouseX - .5) * 23 * building.seed;
      const w = building.w * width + 3;
      const h = building.h * height;
      ctx.fillStyle = index % 7 === 0 ? '#0b1112' : '#0a0f11';
      ctx.beginPath(); ctx.moveTo(x, baseY); ctx.lineTo(x, baseY - h);
      ctx.lineTo(x + w * .2, baseY - h - rand(0, 4)); ctx.lineTo(x + w * .36, baseY - h + 5);
      ctx.lineTo(x + w * .61, baseY - h - rand(0, 8)); ctx.lineTo(x + w * .78, baseY - h + 2);
      ctx.lineTo(x + w, baseY - h * .88); ctx.lineTo(x + w, baseY); ctx.closePath(); ctx.fill();
      if (index % 5 === 0) {
        ctx.fillStyle = `rgba(223,112,67,${.08 + .08 * Math.sin(t * .002 + building.seed * 10)})`;
        ctx.fillRect(x + w * .44, baseY - h * .58, Math.max(1, w * .07), Math.max(2, h * .12));
      }
    });
    // Canted electrical pylons and one damaged power line.
    ctx.strokeStyle = 'rgba(104,121,112,.22)'; ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      const x = width * (.11 + i * .26), y = height * (.54 + (i % 2) * .05), ph = height * .14;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 10, y - ph); ctx.lineTo(x + 22, y - ph - 7); ctx.lineTo(x + 14, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 17, y - ph * .65); ctx.lineTo(x + 29, y - ph * .65); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(106,127,116,.3)'; ctx.beginPath(); ctx.moveTo(0, height * .52); ctx.bezierCurveTo(width * .27, height * .43, width * .68, height * .55, width, height * .44); ctx.stroke();
    // Ground silhouette.
    ctx.fillStyle = '#080c0d'; ctx.beginPath(); ctx.moveTo(0, height * .77);
    for (let x = 0; x <= width + 60; x += 60) ctx.lineTo(x, height * (.76 + .025 * Math.sin(x * .018) + .012 * Math.sin(x * .051)));
    ctx.lineTo(width, height); ctx.lineTo(0, height); ctx.closePath(); ctx.fill();
    fires.forEach((fire) => {
      const flicker = .76 + .24 * Math.sin(t * .009 + fire.phase) * Math.cos(t * .004 + fire.phase);
      const x = fire.x * width, y = fire.y * height;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, fire.r * 2);
      gradient.addColorStop(0, `rgba(244,129,66,${.14 * flicker})`); gradient.addColorStop(.3, `rgba(211,76,44,${.09 * flicker})`); gradient.addColorStop(1, 'rgba(123,49,33,0)');
      ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(x, y, fire.r * 2, 0, Math.PI * 2); ctx.fill();
    });
  }
  function drawZombie(z, t) {
    const x = z.x * width + Math.sin(t * .0003 + z.phase) * 8 * z.depth;
    const base = z.y * height + Math.sin(t * .0008 + z.phase) * 2;
    const scale = .36 + z.depth * .92, head = Math.max(3, z.width * .26) * scale;
    const bodyH = z.height * scale, bodyW = z.width * scale;
    const lurch = z.lurch > 0 ? Math.sin((1 - z.lurch) * Math.PI) * 12 * scale : 0;
    const swing = Math.sin(t * .004 * (z.depth + .3) + z.phase) * 5 * scale;
    ctx.save(); ctx.translate(x + lurch, base); ctx.scale(z.toward, 1);
    ctx.fillStyle = `rgba(5,9,10,${.38 + z.depth * .56})`;
    // Stiff neck, hunched torso and uneven arms.
    ctx.beginPath(); ctx.ellipse(0, -bodyH - head * .65, head * .72, head, -.14, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-bodyW * .35, -bodyH); ctx.quadraticCurveTo(-bodyW * .95, -bodyH * .81, -bodyW * .65, -bodyH * .37); ctx.lineTo(-bodyW * .45, -bodyH * .2); ctx.lineTo(bodyW * .45, -bodyH * .15); ctx.quadraticCurveTo(bodyW * .8, -bodyH * .5, bodyW * .45, -bodyH); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = `rgba(5,9,10,${.55 + z.depth * .4})`; ctx.lineWidth = Math.max(2, bodyW * .19); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-bodyW * .32, -bodyH * .8); ctx.lineTo(-bodyW * .72 - swing, -bodyH * .45); ctx.lineTo(-bodyW * .92 - swing, -bodyH * .24); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bodyW * .28, -bodyH * .82); ctx.lineTo(bodyW * .7 + swing, -bodyH * .56); ctx.lineTo(bodyW * .82 + swing, -bodyH * .35); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-bodyW * .24, -bodyH * .17); ctx.lineTo(-bodyW * .31 - swing, 0); ctx.moveTo(bodyW * .21, -bodyH * .14); ctx.lineTo(bodyW * .35 + swing, 0); ctx.stroke();
    const eyeGlow = Math.max(z.eyes, z.lurch > 0 ? .95 : 0);
    if (eyeGlow > .01) {
      ctx.fillStyle = `rgba(255,66,55,${eyeGlow * .9})`; ctx.shadowColor = '#fa3434'; ctx.shadowBlur = 13 * eyeGlow;
      ctx.fillRect(-head * .41, -bodyH - head * .67, Math.max(1.5, head * .22), Math.max(1.2, head * .15));
      ctx.fillRect(head * .08, -bodyH - head * .67, Math.max(1.5, head * .22), Math.max(1.2, head * .15)); ctx.shadowBlur = 0;
    }
    ctx.restore();
  }
  function drawAsh(t, delta) {
    const parallaxX = (mouseX - .5) * 16, parallaxY = (mouseY - .5) * 8;
    particles.forEach((p) => {
      p.x += p.vx * delta * .022; p.y += p.vy * delta * .022;
      if (p.y > 1.03) { p.y = -.02; p.x = Math.random(); }
      if (p.x < -.02) p.x = 1.02; if (p.x > 1.02) p.x = -.02;
      const pulse = .72 + .28 * Math.sin(t * .001 + p.phase);
      ctx.fillStyle = p.a > .46 && mode === 'hero' ? `rgba(230,138,89,${p.a * pulse * .72})` : `rgba(187,203,188,${p.a * pulse * .55})`;
      ctx.beginPath(); ctx.arc(p.x * width + parallaxX * p.r, p.y * height + parallaxY * p.r, p.r * (quality === 'low' ? 1 : 1.3), 0, Math.PI * 2); ctx.fill();
    });
  }
  function drawFog(t) {
    for (let i = 0; i < 4; i++) {
      const y = height * (.56 + i * .105);
      const x = width * (.5 + .17 * Math.sin(t * .00005 + i * 2.2)) + (mouseX - .5) * (i + 1) * 6;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, width * (.22 + i * .035));
      grad.addColorStop(0, `rgba(125,143,129,${.038 + i * .009})`); grad.addColorStop(1, 'rgba(60,76,67,0)');
      ctx.fillStyle = grad; ctx.fillRect(0, y - height * .2, width, height * .4);
    }
  }
  function drawTorch() {
    const x = mouseX * width, y = mouseY * height;
    const reach = Math.max(width, height) * (clarity ? .45 : .62);
    const darkness = clarity ? .28 : .54;
    const gradient = ctx.createRadialGradient(x, y, 10, x, y, reach);
    gradient.addColorStop(0, 'rgba(0,0,0,0)'); gradient.addColorStop(.22, 'rgba(0,0,0,0.02)'); gradient.addColorStop(.55, `rgba(0,0,0,${darkness * .42})`); gradient.addColorStop(1, `rgba(0,0,0,${darkness})`);
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
    const beam = ctx.createRadialGradient(x, y, 0, x, y, Math.min(width, height) * .21);
    beam.addColorStop(0, 'rgba(230,215,164,.09)'); beam.addColorStop(.48, 'rgba(202,192,150,.035)'); beam.addColorStop(1, 'rgba(202,192,150,0)');
    ctx.fillStyle = beam; ctx.fillRect(x - reach, y - reach, reach * 2, reach * 2);
    // Restrained flashlight cone; the canvas remains behind all controls and title copy.
    const angle = Math.atan2(y - height * .72, x - width * .5);
    ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
    const cone = ctx.createLinearGradient(0, 0, reach * .8, 0);
    cone.addColorStop(0, 'rgba(239,220,168,.025)'); cone.addColorStop(1, 'rgba(219,210,166,0)');
    ctx.fillStyle = cone; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(reach * .75, -reach * .2); ctx.lineTo(reach * .75, reach * .2); ctx.closePath(); ctx.fill(); ctx.restore();
  }
  function drawMapAmbient(t) {
    const sky = ctx.createLinearGradient(0, 0, 0, height); sky.addColorStop(0, 'rgba(3,7,8,.05)'); sky.addColorStop(1, 'rgba(2,5,6,.2)');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, width, height);
    // These atmosphere layers complement the SVG's authored terrain without obscuring controls.
    for (let i = 0; i < 3; i++) {
      const x = width * (.4 + .3 * Math.sin(t * .00005 + i * 2.1));
      const y = height * (.6 + i * .09);
      const fog = ctx.createRadialGradient(x, y, 0, x, y, width * .24);
      fog.addColorStop(0, 'rgba(155,178,154,.045)'); fog.addColorStop(1, 'rgba(155,178,154,0)');
      ctx.fillStyle = fog; ctx.fillRect(0, y - height * .2, width, height * .4);
    }
    drawAsh(t, 16);
  }
  function draw(time, force = false) {
    if (!active && !force) return;
    const delta = lastFrame ? Math.min(50, time - lastFrame) : 16; lastFrame = time;
    mouseX += (targetX - mouseX) * .08; mouseY += (targetY - mouseY) * .08;
    ctx.clearRect(0, 0, width, height);
    if (mode === 'hero') {
      drawSky(time); drawFog(time);
      if (!clarity) zombies.forEach((z) => {
        const cursorDistance = Math.hypot(z.x - mouseX, z.y - mouseY);
        if (cursorDistance < .2) z.toward = mouseX < z.x ? -1 : 1;
        if (mouseSpeed > .35 && cursorDistance < .38) { z.lurch = Math.max(z.lurch, 1); z.eyes = 1; }
        if (z.lurch > 0) { z.lurch = Math.max(0, z.lurch - delta / 1200); z.eyes = Math.max(0, z.eyes - delta / 1800); }
        else z.eyes = Math.max(0, z.eyes - delta / 1000);
        z.x += z.speed * delta * z.toward * .02;
        if (z.x < -.1) z.x = 1.1; if (z.x > 1.1) z.x = -.1;
        drawZombie(z, time);
      });
      drawAsh(time, delta);
      if (mouseSpeed > .75) lurchAmount = 1;
      if (lurchAmount > 0) { lurchAmount = Math.max(0, lurchAmount - delta / 900); }
      drawTorch();
      if (!clarity && !reducedMotion && lurchAmount > .1) {
        const g = ctx.createRadialGradient(mouseX * width, mouseY * height, 10, mouseX * width, mouseY * height, width * .5);
        g.addColorStop(0, `rgba(151,22,28,${lurchAmount * .1})`); g.addColorStop(1, 'rgba(151,22,28,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, width, height);
      }
    } else if (mode === 'map') drawMapAmbient(time);
    else { drawAsh(time, delta * .35); }
    mouseSpeed *= .92;
  }
  function scheduleLoop() {
    if (loopScheduled || reducedMotion || !active) return;
    loopScheduled = true;
    requestAnimationFrame((time) => { loopScheduled = false; draw(time); scheduleLoop(); });
  }
  function onPointerMove(event) {
    const now = performance.now();
    const x = event.clientX / Math.max(1, width), y = event.clientY / Math.max(1, height);
    const speed = Math.hypot(x - targetX, y - targetY) / Math.max(1, now - lastMouse) * 1000;
    mouseSpeed = Math.max(mouseSpeed, speed); targetX = clamp(x, 0, 1); targetY = clamp(y, 0, 1); lastMouse = now;
    const reticle = document.querySelector('.torch-reticle');
    if (reticle) { reticle.style.left = `${event.clientX - 11}px`; reticle.style.top = `${event.clientY - 11}px`; reticle.style.opacity = mode === 'hero' && !clarity ? '.8' : '0'; }
  }
  function lurch() {
    lurchAmount = reducedMotion || clarity ? .25 : 1;
    zombies.forEach((z) => { if (Math.hypot(z.x - mouseX, z.y - mouseY) < .65) { z.lurch = 1; z.eyes = 1; } });
    if (soundOn) playGrowl();
  }
  function setMode(next) {
    mode = next;
    const reticle = document.querySelector('.torch-reticle');
    if (reticle) reticle.style.opacity = mode === 'hero' && !clarity ? '.8' : '0';
    if (active) { lastFrame = 0; draw(performance.now(), true); scheduleLoop(); }
  }
  function setQuality(next) { quality = next; resize(); }
  function setClarity(next) { clarity = !!next; resize(); const reticle = document.querySelector('.torch-reticle'); if (reticle) reticle.style.opacity = mode === 'hero' && !clarity ? '.8' : '0'; }
  function initAudio() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return false;
    if (audioContext) return true;
    audioContext = new AudioCtor();
    const master = audioContext.createGain(); master.gain.value = 0.2; master.connect(audioContext.destination);
    const drone = audioContext.createOscillator(); drone.type = 'sine'; drone.frequency.value = 42;
    const droneGain = audioContext.createGain(); droneGain.gain.value = .035; drone.connect(droneGain); droneGain.connect(master); drone.start();
    const hum = audioContext.createOscillator(); hum.type = 'triangle'; hum.frequency.value = 61;
    const humGain = audioContext.createGain(); humGain.gain.value = .009; hum.connect(humGain); humGain.connect(master); hum.start();
    const sampleCount = audioContext.sampleRate * 2;
    const buffer = audioContext.createBuffer(1, sampleCount, audioContext.sampleRate);
    const data = buffer.getChannelData(0); for (let i = 0; i < sampleCount; i++) data[i] = (Math.random() * 2 - 1) * .45;
    const noise = audioContext.createBufferSource(); noise.buffer = buffer; noise.loop = true;
    const noiseFilter = audioContext.createBiquadFilter(); noiseFilter.type = 'lowpass'; noiseFilter.frequency.value = 320;
    const noiseGain = audioContext.createGain(); noiseGain.gain.value = .011;
    noise.connect(noiseFilter); noiseFilter.connect(noiseGain); noiseGain.connect(master); noise.start();
    audioNodes = { master, drone, droneGain, hum, humGain, noise, noiseGain };
    return true;
  }
  function setSound(enabled) {
    soundOn = !!enabled;
    if (soundOn) {
      if (!initAudio()) { soundOn = false; return false; }
      audioContext.resume?.(); audioNodes.master.gain.setTargetAtTime(.2, audioContext.currentTime, .25);
    } else if (audioContext && audioNodes) audioNodes.master.gain.setTargetAtTime(0, audioContext.currentTime, .25);
    return soundOn;
  }
  function playGrowl() {
    if (!soundOn || !audioContext) return;
    const osc = audioContext.createOscillator(); const gain = audioContext.createGain();
    osc.type = 'sawtooth'; osc.frequency.setValueAtTime(80, audioContext.currentTime); osc.frequency.exponentialRampToValueAtTime(28, audioContext.currentTime + .55);
    gain.gain.setValueAtTime(.0001, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.026, audioContext.currentTime + .09); gain.gain.exponentialRampToValueAtTime(.0001, audioContext.currentTime + .7);
    osc.connect(gain); gain.connect(audioNodes.master); osc.start(); osc.stop(audioContext.currentTime + .75);
  }
  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerdown', (event) => {
    if (mode === 'hero' && event.isPrimary) { lurch(); }
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    active = !document.hidden;
    if (active) { lastFrame = 0; scheduleLoop(); }
  });
  window.addEventListener('resize', resize);
  window.TLDScene = { setMode, setQuality, setClarity, setSound, lurch };
  resize();
  scheduleLoop();
})();
