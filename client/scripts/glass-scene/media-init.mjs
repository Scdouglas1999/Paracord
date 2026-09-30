// Browser-side media for the cast. `mediaInitScript(config)` returns the source
// of an init script that Playwright installs before the app boots, so the app's
// own `getDisplayMedia` / `getUserMedia` calls receive these streams instead of
// a picker or Chromium's fake green test pattern.
//
//   display: true   getDisplayMedia → the warm/teal cave scene (Vincent's share)
//   camera:  true   getUserMedia({video}) → an animated portrait of `face`
//   voice:   'talking' | 'quiet'
//                   getUserMedia({audio}) → a speech-like synth (formant-filtered
//                   pulse train with syllable and phrase envelopes) or silence
//
// The app encodes and publishes these exactly as it would a real capture: the
// driver replaces the *source*, never the pipeline.

/* eslint-disable no-undef */
function installGlassMedia(config) {
  if (window !== window.top) return;
  if (window.__glassSceneMedia) return;
  const state = { config, displayFrames: 0, cameraFrames: 0, voiceLevel: 0, started: Date.now() };
  window.__glassSceneMedia = state;

  const devices = navigator.mediaDevices;
  if (!devices) return;
  const originalGetUserMedia = devices.getUserMedia ? devices.getUserMedia.bind(devices) : null;

  // ---------------------------------------------------------------- helpers
  const timers = [];
  function every(ms, fn) {
    // setInterval rather than requestAnimationFrame: a headless or background
    // page may never schedule animation frames, and a canvas nobody repaints
    // produces no frames for captureStream.
    const id = setInterval(fn, ms);
    timers.push(id);
    return id;
  }
  function makeCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  // ------------------------------------------------------ Vincent's screen
  function startDisplayScene() {
    const W = config.displayWidth || 1280;
    const H = config.displayHeight || 720;
    const fps = config.displayFps || 24;
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const S = config.scene;
    const paths = {};
    for (const key of Object.keys(S)) paths[key] = new Path2D(S[key]);
    const motes = Array.from({ length: 36 }, (_, i) => ({
      x: (i * 97) % 320, y: 40 + ((i * 53) % 100), r: 0.3 + ((i * 7) % 5) / 10, s: 0.6 + ((i * 13) % 10) / 10,
    }));
    let morkite = 212;
    every(3500, () => { morkite = morkite >= 250 ? 180 : morkite + 1; });

    function draw() {
      const t = (Date.now() - state.started) / 1000;
      ctx.save();
      ctx.scale(W / 320, H / 180);
      // Base cave air.
      let g = ctx.createLinearGradient(0, 0, 0, 180);
      g.addColorStop(0, '#0a1a1f'); g.addColorStop(0.6, '#12241f'); g.addColorStop(1, '#0b1511');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 320, 180);
      // Far ridge, drifting a little for parallax.
      ctx.save(); ctx.translate(Math.sin(t / 9) * 3, 0);
      ctx.fillStyle = '#10211c'; ctx.fill(paths.ridgeFar); ctx.restore();
      // Teal crystal light, shimmering.
      const teal = 0.42 + 0.12 * Math.sin(t * 1.3) + 0.05 * Math.sin(t * 3.7);
      g = ctx.createRadialGradient(45, 130, 0, 45, 130, 90);
      g.addColorStop(0, `rgba(95,240,220,${teal.toFixed(3)})`); g.addColorStop(1, 'rgba(95,240,220,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 320, 180);
      // Warm amber glow around the miner, breathing.
      const warm = 0.85 + 0.12 * Math.sin(t * 0.8);
      const gx = 205 + Math.sin(t / 5) * 4;
      g = ctx.createRadialGradient(gx, 112, 0, gx, 112, 147);
      g.addColorStop(0, `rgba(255,196,122,${warm.toFixed(3)})`);
      g.addColorStop(0.3, `rgba(240,130,58,${(warm * 0.53).toFixed(3)})`);
      g.addColorStop(1, 'rgba(240,130,58,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 320, 180);
      // Headlamp beam sweeping slowly.
      const sway = Math.sin(t / 3.2) * 16;
      ctx.fillStyle = 'rgba(255,226,176,0.13)';
      ctx.beginPath(); ctx.moveTo(209, 108); ctx.lineTo(320, 78 + sway); ctx.lineTo(320, 140 + sway * 0.6); ctx.closePath(); ctx.fill();
      // Dust in the beam and the air.
      for (const m of motes) {
        const x = (m.x + t * 4 * m.s) % 320;
        const y = m.y + Math.sin(t * m.s + m.x) * 3;
        const inBeam = x > 209 && Math.abs(y - (108 + ((x - 209) / 111) * (sway - 10))) < 30 * ((x - 209) / 111);
        ctx.fillStyle = inBeam ? 'rgba(255,236,200,0.7)' : 'rgba(200,240,230,0.22)';
        ctx.beginPath(); ctx.arc(x, y, m.r, 0, Math.PI * 2); ctx.fill();
      }
      // Ceiling and floor silhouettes.
      ctx.fillStyle = '#060d0f'; ctx.fill(paths.ceiling);
      ctx.fillStyle = '#07110e'; ctx.fill(paths.floor);
      // Crystals.
      const c = 0.85 + 0.15 * Math.sin(t * 2.1);
      ctx.fillStyle = `rgba(126,245,228,${c.toFixed(3)})`; ctx.fill(paths.crystalA);
      ctx.fillStyle = '#3fc8b8'; ctx.fill(paths.crystalB);
      // The miner, bobbing a pixel as he walks in place.
      ctx.save(); ctx.translate(0, Math.abs(Math.sin(t * 1.6)) * -1.2);
      ctx.fillStyle = '#040909'; ctx.fill(paths.body);
      ctx.beginPath(); ctx.arc(203.5, 108, 5.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff4de'; ctx.beginPath(); ctx.arc(209, 107.5, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      // HUD.
      ctx.globalAlpha = 0.65; ctx.fillStyle = '#e9f4ef';
      ctx.font = '600 6px ui-monospace, monospace';
      ctx.fillText(`MORKITE ${morkite}/250`, 232, 16);
      ctx.globalAlpha = 1;
      ctx.restore();
      state.displayFrames += 1;
    }
    draw();
    every(1000 / fps, draw);
    return canvas.captureStream(fps);
  }

  // ------------------------------------------------------ portrait camera
  function startCamera() {
    const W = 1280;
    const H = 720;
    const fps = 24;
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const a = config.face;
    const p = {
      torso: new Path2D('M6 64c2-14 13-20 26-20s24 6 26 20z'),
      neck: new Path2D('M27 37h10v8c0 3.2-10 3.2-10 0z'),
      hair: new Path2D(a.hair),
      fx: a.fx ? new Path2D(a.fx) : null,
      sx: a.sx ? new Path2D(a.sx) : null,
    };
    function draw() {
      const t = (Date.now() - state.started) / 1000;
      const level = state.voiceLevel;
      // Room behind: the face's own color, lit from the upper left.
      let g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, a.bg); g.addColorStop(1, '#141a22');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      g = ctx.createRadialGradient(W * 0.25, H * 0.1, 0, W * 0.25, H * 0.1, W * 0.6);
      g.addColorStop(0, 'rgba(255,214,170,0.18)'); g.addColorStop(1, 'rgba(255,214,170,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.save();
      const scale = H / 64 * 1.02;
      const bob = Math.sin(t * 1.1) * 4 + level * 6 * Math.sin(t * 9);
      const tilt = Math.sin(t * 0.55) * 0.025;
      ctx.translate(W / 2, H + 6);
      ctx.rotate(tilt);
      ctx.translate(-32 * scale, -64 * scale + bob);
      ctx.scale(scale, scale);
      ctx.fillStyle = a.shirt; ctx.fill(p.torso);
      ctx.fillStyle = a.neck; ctx.fill(p.neck);
      ctx.fillStyle = a.skin; ctx.beginPath(); ctx.ellipse(32, 28, 11, 12.5, 0, 0, Math.PI * 2); ctx.fill();
      // Mouth, opening with the voice.
      ctx.fillStyle = 'rgba(80,40,30,0.75)';
      ctx.beginPath(); ctx.ellipse(32, 35.2, 2.4, 0.35 + level * 1.6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = a.hairC; ctx.fill(p.hair);
      if (p.fx) { ctx.fillStyle = a.fxC; ctx.fill(p.fx); }
      if (p.sx) {
        ctx.strokeStyle = a.sxC; ctx.lineWidth = a.sw; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(p.sx);
      }
      ctx.restore();
      state.cameraFrames += 1;
    }
    draw();
    every(1000 / fps, draw);
    return canvas.captureStream(fps);
  }

  // ---------------------------------------------------------------- voice
  let audioContext = null;
  function voiceStream(mode) {
    audioContext = audioContext || new AudioContext({ sampleRate: 48000 });
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    const ac = audioContext;
    const out = ac.createMediaStreamDestination();
    if (mode !== 'talking') {
      // A live but silent track: the app still gets a microphone.
      const gain = ac.createGain(); gain.gain.value = 0;
      const osc = ac.createOscillator(); osc.connect(gain).connect(out); osc.start();
      return out.stream;
    }
    // Glottal pulse train through two moving formants, with a noise hiss for
    // consonants — reads as speech to an energy/VAD detector and to the ear.
    const source = ac.createOscillator(); source.type = 'sawtooth'; source.frequency.value = 118;
    const f1 = ac.createBiquadFilter(); f1.type = 'bandpass'; f1.Q.value = 6; f1.frequency.value = 650;
    const f2 = ac.createBiquadFilter(); f2.type = 'bandpass'; f2.Q.value = 9; f2.frequency.value = 1500;
    const voiced = ac.createGain(); voiced.gain.value = 0;
    const mix = ac.createGain(); mix.gain.value = 2.2;
    source.connect(f1); source.connect(f2); f1.connect(voiced); f2.connect(voiced); voiced.connect(mix);
    const noiseBuffer = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ac.createBufferSource(); noise.buffer = noiseBuffer; noise.loop = true;
    const hiss = ac.createBiquadFilter(); hiss.type = 'highpass'; hiss.frequency.value = 3500;
    const unvoiced = ac.createGain(); unvoiced.gain.value = 0;
    noise.connect(hiss).connect(unvoiced).connect(mix);
    mix.connect(out);
    source.start(); noise.start();

    const analyser = ac.createAnalyser(); analyser.fftSize = 512; mix.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    every(50, () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      state.voiceLevel = Math.min(1, Math.sqrt(sum / buf.length) * 4);
    });

    // Phrases of 4–10 syllables, 0.4–1.4 s pauses between them.
    let syllablesLeft = 0;
    function next() {
      const now = ac.currentTime;
      if (syllablesLeft <= 0) {
        syllablesLeft = 4 + Math.floor(Math.random() * 7);
        voiced.gain.setTargetAtTime(0, now, 0.03);
        unvoiced.gain.setTargetAtTime(0, now, 0.03);
        setTimeout(next, 400 + Math.random() * 1000);
        return;
      }
      syllablesLeft -= 1;
      const length = 0.14 + Math.random() * 0.16;
      source.frequency.setTargetAtTime(105 + Math.random() * 45, now, 0.05);
      f1.frequency.setTargetAtTime(350 + Math.random() * 500, now, 0.03);
      f2.frequency.setTargetAtTime(900 + Math.random() * 1400, now, 0.03);
      if (Math.random() < 0.3) {
        unvoiced.gain.setTargetAtTime(0.12, now, 0.01);
        unvoiced.gain.setTargetAtTime(0, now + 0.05, 0.02);
      }
      voiced.gain.setTargetAtTime(0.9, now + 0.03, 0.025);
      voiced.gain.setTargetAtTime(0.15, now + length * 0.8, 0.04);
      setTimeout(next, length * 1000);
    }
    next();
    return out.stream;
  }

  // ------------------------------------------------------------ overrides
  if (config.display) {
    let displayStream = null;
    devices.getDisplayMedia = async function glassGetDisplayMedia() {
      displayStream = displayStream && displayStream.getVideoTracks().some(tr => tr.readyState === 'live')
        ? displayStream
        : startDisplayScene();
      return new MediaStream(displayStream.getVideoTracks().map(track => track.clone()));
    };
  }

  devices.getUserMedia = async function glassGetUserMedia(constraints = {}) {
    const wantsVideo = Boolean(constraints.video);
    const wantsAudio = Boolean(constraints.audio);
    const tracks = [];
    if (wantsVideo) {
      if (config.camera) tracks.push(...startCamera().getVideoTracks());
      else if (originalGetUserMedia) tracks.push(...(await originalGetUserMedia({ video: constraints.video })).getVideoTracks());
    }
    if (wantsAudio) {
      if (config.voice) tracks.push(...voiceStream(config.voice).getAudioTracks());
      else if (originalGetUserMedia) tracks.push(...(await originalGetUserMedia({ audio: constraints.audio })).getAudioTracks());
    }
    if (tracks.length === 0 && originalGetUserMedia) return originalGetUserMedia(constraints);
    return new MediaStream(tracks);
  };
}

export function mediaInitScript(config) {
  return `(${installGlassMedia.toString()})(${JSON.stringify(config)});`;
}
