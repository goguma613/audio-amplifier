// ==UserScript==
// @name         🔊 브라우저 소리 증폭기 (Audio Amplifier)
// @name:en      Audio Amplifier for Browser
// @namespace    https://github.com/goguma613/audio-amplifier
// @version      1.0.2
// @description  영상/오디오 소리를 최대 500%까지 증폭. 클리핑 방지 리미터, VU미터, 3밴드 EQ·음성 부스트, 사이트별 설정 기억.
// @description:en  Amplify video/audio up to 500% with a clipping limiter, VU meter, 3-band EQ, voice-boost preset and per-site memory.
// @author       goguma613
// @match        *://*.youtube.com/*
// @match        *://*.youtube-nocookie.com/*
// @match        *://*.twitch.tv/*
// @match        *://*.vimeo.com/*
// @match        *://*.tv.naver.com/*
// @match        *://*.tv.kakao.com/*
// @match        *://*.afreecatv.com/*
// @match        *://*.chzzk.naver.com/*
// @exclude      *://*.netflix.com/*
// @exclude      *://*.disneyplus.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/goguma613/audio-amplifier/main/audio-amplifier.user.js
// @downloadURL  https://raw.githubusercontent.com/goguma613/audio-amplifier/main/audio-amplifier.user.js
// @homepageURL  https://github.com/goguma613/audio-amplifier
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%234f9dff'%3E%3Cpath d='M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1c2.9.9 5 3.5 5 6.7s-2.1 5.8-5 6.7v2.1c4-.9 7-4.5 7-8.8s-3-7.9-7-8.8z'/%3E%3C/svg%3E
// ==/UserScript==

/*
 * 브라우저 소리 증폭기
 * ─────────────────────────────────────────────────────────────
 * 단일 파일 안에서 역할별 모듈로 분리:
 *   ConfigManager  - 사이트(hostname)별 설정 저장/로드 (GM_getValue/SetValue)
 *   AudioEngine    - element당 Web Audio 그래프 생성·관리 (핵심)
 *   VideoObserver  - MutationObserver로 video/audio 등장 감지
 *   UIManager      - Shadow DOM 플로팅 패널, 드래그, VU미터 렌더링
 *
 * 오디오 그래프(중요 순서):
 *   source → gain → EQ(low/mid/high) → analyser → limiter → destination
 *   ※ analyser는 리미터 "앞"에 둬야 클리핑이 잡힘.
 */

(function () {
  'use strict';

  // 최상위 프레임에서만 UI 렌더(임베드 iframe 중복 방지). 오디오 엔진은 모든 프레임에서 동작.
  // window.self===window.top 비교는 유저스크립트 샌드박스에서 어긋날 수 있어 frameElement로 판정.
  const IS_TOP = (function () {
    try {
      if (window.frameElement) return false; // 같은 출처 서브프레임
    } catch (e) {
      return false;                          // 교차 출처 서브프레임(접근 시 예외)
    }
    return true;                             // 최상위 프레임
  })();

  // ─────────────────────────────────────────────────────────────
  // 상수
  // ─────────────────────────────────────────────────────────────
  const MAX_GAIN = 5.0;          // 500%
  const MIN_GAIN = 1.0;          // 100%
  const RAMP_TIME = 0.02;        // gain 램핑(초) — pop 방지
  const CLIP_PEAK = 0.99;        // 피크 클리핑 임계
  const CLIP_REDUCTION = -1.0;   // 리미터 작동 임계(dB)
  const SAVE_DEBOUNCE = 300;     // 설정 저장 디바운스(ms)

  const DEFAULTS = {
    gain: 1.0,
    eq: { low: 0, mid: 0, high: 0 }, // dB
    voiceBoost: false,
    enabled: true,
    uiPos: null,        // {x, y} — null이면 기본 위치
    collapsed: false,
    onboarded: false,
  };

  // ─────────────────────────────────────────────────────────────
  // ConfigManager — 사이트별 설정 저장/로드
  // ─────────────────────────────────────────────────────────────
  const ConfigManager = (function () {
    // localStorage는 사이트(origin)별로 분리되어 자동으로 "사이트별 설정 기억"이 됨.
    const KEY = '__audioAmp_cfg';
    let state = Object.assign({}, DEFAULTS);
    let saveTimer = null;

    function load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          state = Object.assign({}, DEFAULTS, parsed);
          state.eq = Object.assign({}, DEFAULTS.eq, parsed.eq || {});
        }
      } catch (e) {
        console.warn('[증폭기] 설정 로드 실패:', e);
      }
      return state;
    }

    function persist() {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch (e) {
        console.warn('[증폭기] 설정 저장 실패:', e);
      }
    }

    function save() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(persist, SAVE_DEBOUNCE);
    }

    function saveNow() {
      clearTimeout(saveTimer);
      persist();
    }

    return {
      get: () => state,
      set(patch) { Object.assign(state, patch); save(); },
      setEq(band, val) { state.eq[band] = val; save(); },
      saveNow,
      load,
    };
  })();

  // ─────────────────────────────────────────────────────────────
  // AudioEngine — element당 오디오 그래프
  // ─────────────────────────────────────────────────────────────
  const AudioEngine = (function () {
    let ctx = null;
    const wired = new WeakSet();      // 이미 createMediaElementSource 호출한 element
    const nodesMap = new WeakMap();   // element → { gain, eqLow, eqMid, eqHigh, analyser, limiter, bypassed }
    const graphs = [];                // 현재 활성 그래프 목록(설정 일괄 적용용). 약참조 보관.

    function ensureCtx() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      return ctx;
    }

    function resume() {
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    }

    function attach(el) {
      if (wired.has(el)) return;
      const context = ensureCtx();
      if (!context) return;

      let source;
      try {
        source = context.createMediaElementSource(el);
      } catch (e) {
        // 이미 다른 곳에서 연결됐거나 실패 — 한 번만 시도하고 표시
        wired.add(el);
        console.warn('[증폭기] 소스 연결 실패(건너뜀):', e.message);
        return;
      }
      wired.add(el);

      const gain = context.createGain();
      const eqLow = context.createBiquadFilter();
      const eqMid = context.createBiquadFilter();
      const eqHigh = context.createBiquadFilter();
      const analyser = context.createAnalyser();
      const limiter = context.createDynamicsCompressor();

      eqLow.type = 'lowshelf';   eqLow.frequency.value = 120;
      eqMid.type = 'peaking';    eqMid.frequency.value = 2500; eqMid.Q.value = 1.0;
      eqHigh.type = 'highshelf'; eqHigh.frequency.value = 10000;

      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;

      // 리미터(클리핑 방지)
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;

      // 연결: source → gain → eqLow → eqMid → eqHigh → analyser → limiter → destination
      source.connect(gain);
      gain.connect(eqLow);
      eqLow.connect(eqMid);
      eqMid.connect(eqHigh);
      eqHigh.connect(analyser);
      analyser.connect(limiter);
      limiter.connect(context.destination);

      const g = { el, source, gain, eqLow, eqMid, eqHigh, analyser, limiter, bypassed: false };
      nodesMap.set(el, g);
      graphs.push(g);

      // CORS 무음 감지: 잠시 후 소리 흐름이 전혀 없으면 바이패스로 폴백
      scheduleSilenceCheck(g);

      // 현재 설정 적용
      applyConfig(ConfigManager.get());
      resume();
    }

    // 교차 출처(CORS) 미디어가 tainted 되어 무음이 되는 경우 폴백
    function scheduleSilenceCheck(g) {
      const buf = new Float32Array(g.analyser.fftSize);
      let checks = 0;
      const timer = setInterval(() => {
        checks++;
        // 재생 중이고 음소거가 아닌데 신호가 완전 0이면 의심
        const playing = !g.el.paused && !g.el.muted && g.el.volume > 0 && g.el.currentTime > 0;
        if (playing) {
          g.analyser.getFloatTimeDomainData(buf);
          let peak = 0;
          for (let i = 0; i < buf.length; i++) {
            const a = Math.abs(buf[i]);
            if (a > peak) peak = a;
          }
          if (peak === 0) {
            // 무음 → 그래프 바이패스(원음 직결)
            bypass(g, true);
            console.warn('[증폭기] CORS 무음 감지 — 원음으로 폴백합니다.');
            clearInterval(timer);
            return;
          }
        }
        if (checks > 12) clearInterval(timer); // 약 6초 관찰 후 종료
      }, 500);
    }

    function bypass(g, on) {
      try {
        if (on && !g.bypassed) {
          g.source.disconnect();
          g.source.connect(ctx.destination);
          g.bypassed = true;
        } else if (!on && g.bypassed) {
          g.source.disconnect();
          g.source.connect(g.gain);
          g.bypassed = false;
        }
      } catch (e) { /* noop */ }
    }

    function applyConfig(cfg) {
      if (!ctx) return;
      const now = ctx.currentTime;
      const targetGain = cfg.enabled ? cfg.gain : 1.0;
      const eq = cfg.voiceBoost
        ? { low: Math.min(cfg.eq.low, -2), mid: Math.max(cfg.eq.mid, 5), high: Math.max(cfg.eq.high, 2) }
        : cfg.eq;

      for (const g of graphs) {
        if (g.bypassed) continue;
        g.gain.gain.setTargetAtTime(targetGain, now, RAMP_TIME);
        g.eqLow.gain.setTargetAtTime(cfg.enabled ? eq.low : 0, now, RAMP_TIME);
        g.eqMid.gain.setTargetAtTime(cfg.enabled ? eq.mid : 0, now, RAMP_TIME);
        g.eqHigh.gain.setTargetAtTime(cfg.enabled ? eq.high : 0, now, RAMP_TIME);
      }
    }

    // VU미터용: 모든 활성 그래프 중 최대 피크/리미터 감소량 반환
    function readMeter() {
      let peak = 0;
      let reduction = 0;
      for (const g of graphs) {
        if (g.bypassed) continue;
        const buf = g._buf || (g._buf = new Float32Array(g.analyser.fftSize));
        g.analyser.getFloatTimeDomainData(buf);
        for (let i = 0; i < buf.length; i++) {
          const a = Math.abs(buf[i]);
          if (a > peak) peak = a;
        }
        if (g.limiter.reduction < reduction) reduction = g.limiter.reduction;
      }
      return { peak, reduction };
    }

    function hasGraphs() { return graphs.length > 0; }

    return { attach, applyConfig, readMeter, resume, hasGraphs };
  })();

  // ─────────────────────────────────────────────────────────────
  // VideoObserver — video/audio 등장 감지
  // ─────────────────────────────────────────────────────────────
  const VideoObserver = (function () {
    let onDetect = null;

    function handle(el) {
      if (el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO')) {
        AudioEngine.attach(el);
        if (onDetect) onDetect();
      }
    }

    function scanExisting() {
      document.querySelectorAll('video, audio').forEach(handle);
    }

    function start(cb) {
      onDetect = cb;
      const root = document.documentElement || document;
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            handle(node);
            if (node.querySelectorAll) node.querySelectorAll('video, audio').forEach(handle);
          }
        }
      });
      observer.observe(root, { childList: true, subtree: true });

      // body 준비되면 기존 요소 스캔
      if (document.body) scanExisting();
      else document.addEventListener('DOMContentLoaded', scanExisting, { once: true });
    }

    return { start };
  })();

  // ─────────────────────────────────────────────────────────────
  // UIManager — Shadow DOM 플로팅 패널
  // ─────────────────────────────────────────────────────────────
  const UIManager = (function () {
    let host, shadow, panel, pill, rafId = null, idleTimer = null;
    let els = {}; // 주요 컨트롤 참조

    const CSS = `
      :host { all: initial; }
      .wrap {
        position: fixed; z-index: 2147483647; top: 80px; right: 24px;
        font-family: 'Malgun Gothic', -apple-system, system-ui, sans-serif;
        color: #e9eef5; user-select: none;
        transition: opacity .25s ease;
      }
      .wrap.idle { opacity: .35; }
      .panel {
        width: 248px; padding: 14px;
        background: rgba(22,26,34,.92); backdrop-filter: blur(12px);
        border: 1px solid rgba(255,255,255,.08); border-radius: 14px;
        box-shadow: 0 10px 30px rgba(0,0,0,.45);
      }
      .panel.hidden { display: none; }
      .head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; cursor: move; }
      .title { font-size: 13px; font-weight: 700; flex: 1; }
      .iconbtn {
        width: 26px; height: 26px; border: none; border-radius: 7px; cursor: pointer;
        background: rgba(255,255,255,.08); color: #e9eef5; font-size: 13px; line-height: 1;
      }
      .iconbtn:hover { background: rgba(255,255,255,.16); }
      .iconbtn.on { background: #4f9dff; color: #fff; }
      .gainrow { display: flex; align-items: baseline; gap: 6px; margin: 6px 0 4px; }
      .gainval { font-size: 26px; font-weight: 800; letter-spacing: -1px; }
      .gainval.boost { color: #ffb84f; }
      .gainval.clip { color: #ff5b5b; }
      .unit { font-size: 13px; opacity: .6; }
      input[type=range] {
        -webkit-appearance: none; width: 100%; height: 5px; border-radius: 4px;
        background: rgba(255,255,255,.15); outline: none; margin: 8px 0;
      }
      input[type=range]::-webkit-slider-thumb {
        -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%;
        background: #4f9dff; cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,.4);
      }
      .meter { height: 7px; border-radius: 4px; background: rgba(255,255,255,.1); overflow: hidden; margin: 2px 0 10px; }
      .meterbar { height: 100%; width: 0%; background: linear-gradient(90deg,#3ddc84,#ffe14f 70%,#ff5b5b); transition: width .06s linear; }
      .meter.clip { box-shadow: 0 0 0 1px #ff5b5b inset; animation: blink .4s steps(2) infinite; }
      @keyframes blink { 50% { opacity: .4; } }
      .section { border-top: 1px solid rgba(255,255,255,.07); padding-top: 10px; margin-top: 4px; }
      .eqrow { display: flex; align-items: center; gap: 8px; font-size: 11px; margin: 2px 0; }
      .eqrow label { width: 30px; opacity: .7; }
      .eqrow input { flex: 1; margin: 4px 0; }
      .btnrow { display: flex; gap: 6px; margin-top: 10px; }
      .btn {
        flex: 1; padding: 7px 0; border: none; border-radius: 8px; cursor: pointer;
        background: rgba(255,255,255,.08); color: #e9eef5; font-size: 12px; font-weight: 600;
      }
      .btn:hover { background: rgba(255,255,255,.16); }
      .btn.active { background: #ffb84f; color: #1a1a1a; }
      .pill {
        display: none; align-items: center; gap: 6px; cursor: pointer;
        padding: 8px 12px; background: rgba(22,26,34,.92); backdrop-filter: blur(12px);
        border: 1px solid rgba(255,255,255,.08); border-radius: 999px;
        box-shadow: 0 6px 18px rgba(0,0,0,.4); font-size: 13px; font-weight: 700;
      }
      .pill.show { display: inline-flex; }
      .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #3ddc84; }
      .pill.off .dot { background: #888; }
      .tip {
        position: absolute; top: 0; right: 270px; width: 180px; padding: 10px 12px;
        background: #4f9dff; color: #fff; border-radius: 10px; font-size: 12px; line-height: 1.5;
        box-shadow: 0 6px 18px rgba(0,0,0,.4);
      }
      .tip::after { content:''; position:absolute; top:16px; right:-6px; border:6px solid transparent; border-left-color:#4f9dff; }
      .tip button { display:block; margin-top:8px; background:rgba(255,255,255,.25); border:none; color:#fff; border-radius:6px; padding:4px 8px; cursor:pointer; font-size:11px; }
    `;

    function el(tag, attrs, children) {
      const node = document.createElement(tag);
      if (attrs) for (const k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
      if (children) children.forEach(c => node.appendChild(c));
      return node;
    }

    function build() {
      host = document.createElement('div');
      host.id = '__audio_amp_host';
      shadow = host.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);

      const cfg = ConfigManager.get();

      // ── 펼친 패널 ──
      const titleEl = el('span', { class: 'title', text: '🔊 소리 증폭기' });
      const onBtn = el('button', { class: 'iconbtn' + (cfg.enabled ? ' on' : ''), title: '켜기/끄기', text: '⏻' });
      const collapseBtn = el('button', { class: 'iconbtn', title: '접기', text: '—' });
      const head = el('div', { class: 'head' }, [titleEl, onBtn, collapseBtn]);

      const gainVal = el('span', { class: 'gainval', text: Math.round(cfg.gain * 100) });
      const gainRow = el('div', { class: 'gainrow' }, [gainVal, el('span', { class: 'unit', text: '%' })]);

      const slider = el('input', {
        type: 'range', min: '100', max: String(MAX_GAIN * 100), step: '5',
        value: String(Math.round(cfg.gain * 100)),
      });

      const meterBar = el('div', { class: 'meterbar' });
      const meter = el('div', { class: 'meter' }, [meterBar]);

      // EQ 섹션
      const eqBands = [['low', '저음'], ['mid', '중음'], ['high', '고음']];
      const eqInputs = {};
      const eqRows = eqBands.map(([band, label]) => {
        const input = el('input', { type: 'range', min: '-12', max: '12', step: '1', value: String(cfg.eq[band]) });
        eqInputs[band] = input;
        return el('div', { class: 'eqrow' }, [el('label', { text: label }), input]);
      });
      const voiceBtn = el('button', { class: 'btn' + (cfg.voiceBoost ? ' active' : ''), text: '🎙 음성 부스트' });
      const resetBtn = el('button', { class: 'btn', text: '↺ 100%' });
      const section = el('div', { class: 'section' }, [...eqRows, el('div', { class: 'btnrow' }, [voiceBtn, resetBtn])]);

      panel = el('div', { class: 'panel' + (cfg.collapsed ? ' hidden' : '') }, [head, gainRow, slider, meter, section]);

      // ── 접힌 핀 ──
      const pillDot = el('span', { class: 'dot' });
      const pillText = el('span', { text: Math.round(cfg.gain * 100) + '%' });
      pill = el('div', { class: 'pill' + (cfg.collapsed ? ' show' : '') + (cfg.enabled ? '' : ' off') }, [pillDot, pillText]);

      const wrap = el('div', { class: 'wrap' }, [panel, pill]);
      if (cfg.uiPos) { wrap.style.top = cfg.uiPos.y + 'px'; wrap.style.left = cfg.uiPos.x + 'px'; wrap.style.right = 'auto'; }
      shadow.appendChild(wrap);

      els = { wrap, gainVal, slider, meterBar, meter, onBtn, collapseBtn, voiceBtn, resetBtn, eqInputs, pill, pillText, pillDot, titleEl };

      bindEvents();
      mountToFullscreenOrBody();
      startMeter();
      startIdleFade();
      maybeOnboard();
    }

    function applyToEngine() {
      AudioEngine.applyConfig(ConfigManager.get());
    }

    function refreshGainLabel() {
      const cfg = ConfigManager.get();
      const pct = Math.round(cfg.gain * 100);
      els.gainVal.textContent = pct;
      els.pillText.textContent = pct + '%';
      els.gainVal.classList.toggle('boost', cfg.gain > 1.0 && cfg.enabled);
    }

    function bindEvents() {
      const cfg = ConfigManager.get();

      els.slider.addEventListener('input', () => {
        const g = parseInt(els.slider.value, 10) / 100;
        ConfigManager.set({ gain: g });
        refreshGainLabel();
        applyToEngine();
      });

      els.onBtn.addEventListener('click', () => {
        const next = !ConfigManager.get().enabled;
        ConfigManager.set({ enabled: next });
        els.onBtn.classList.toggle('on', next);
        els.pill.classList.toggle('off', !next);
        refreshGainLabel();
        applyToEngine();
      });

      els.collapseBtn.addEventListener('click', () => setCollapsed(true));
      els.pill.addEventListener('click', () => setCollapsed(false));

      els.voiceBtn.addEventListener('click', () => {
        const next = !ConfigManager.get().voiceBoost;
        ConfigManager.set({ voiceBoost: next });
        els.voiceBtn.classList.toggle('active', next);
        applyToEngine();
      });

      els.resetBtn.addEventListener('click', () => {
        ConfigManager.set({ gain: 1.0, eq: { low: 0, mid: 0, high: 0 }, voiceBoost: false });
        els.slider.value = '100';
        for (const b in els.eqInputs) els.eqInputs[b].value = '0';
        els.voiceBtn.classList.remove('active');
        refreshGainLabel();
        applyToEngine();
      });

      for (const band in els.eqInputs) {
        els.eqInputs[band].addEventListener('input', () => {
          ConfigManager.setEq(band, parseInt(els.eqInputs[band].value, 10));
          applyToEngine();
        });
      }

      // 드래그 이동
      makeDraggable(els.titleEl.parentElement, els.wrap);
    }

    function setCollapsed(on) {
      ConfigManager.set({ collapsed: on });
      panel.classList.toggle('hidden', on);
      els.pill.classList.toggle('show', on);
    }

    function makeDraggable(handle, wrap) {
      let sx, sy, ox, oy, dragging = false;
      handle.addEventListener('pointerdown', (e) => {
        dragging = true;
        const r = wrap.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        handle.setPointerCapture(e.pointerId);
      });
      handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const x = Math.max(0, ox + e.clientX - sx);
        const y = Math.max(0, oy + e.clientY - sy);
        wrap.style.left = x + 'px'; wrap.style.top = y + 'px'; wrap.style.right = 'auto';
      });
      const end = (e) => {
        if (!dragging) return;
        dragging = false;
        const r = wrap.getBoundingClientRect();
        ConfigManager.set({ uiPos: { x: Math.round(r.left), y: Math.round(r.top) } });
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }

    // VU미터 렌더 루프 (패널이 보일 때만)
    function startMeter() {
      function tick() {
        rafId = requestAnimationFrame(tick);
        if (panel.classList.contains('hidden') || !AudioEngine.hasGraphs()) {
          els.meterBar.style.width = '0%';
          return;
        }
        const { peak, reduction } = AudioEngine.readMeter();
        els.meterBar.style.width = Math.min(100, peak * 100) + '%';
        const clipping = peak >= CLIP_PEAK || reduction <= CLIP_REDUCTION;
        els.meter.classList.toggle('clip', clipping);
        els.gainVal.classList.toggle('clip', clipping);
      }
      tick();
    }

    // 유휴 시 자동 페이드
    function startIdleFade() {
      const wake = () => {
        els.wrap.classList.remove('idle');
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => els.wrap.classList.add('idle'), 3500);
      };
      ['pointermove', 'pointerdown', 'keydown'].forEach(ev =>
        window.addEventListener(ev, wake, { passive: true }));
      wake();
    }

    // 전체화면 시 패널 재배치
    function mountToFullscreenOrBody() {
      const place = () => {
        const fs = document.fullscreenElement || document.webkitFullscreenElement;
        const target = fs || document.body;
        if (host.parentElement !== target) target.appendChild(host);
      };
      place();
      document.addEventListener('fullscreenchange', place);
      document.addEventListener('webkitfullscreenchange', place);
    }

    // 첫 실행 온보딩 말풍선 (1회)
    function maybeOnboard() {
      if (ConfigManager.get().onboarded) return;
      const close = el('button', { text: '알겠어요' });
      const tip = el('div', { class: 'tip' }, [
        el('div', { text: '여기서 영상 소리를 최대 500%까지 키울 수 있어요! 슬라이더를 올려보세요.' }),
        close,
      ]);
      els.wrap.appendChild(tip);
      close.addEventListener('click', () => {
        tip.remove();
        ConfigManager.set({ onboarded: true });
        ConfigManager.saveNow();
      });
    }

    return { build };
  })();

  // ─────────────────────────────────────────────────────────────
  // 부트스트랩
  // ─────────────────────────────────────────────────────────────
  ConfigManager.load();

  // 사용자 제스처에서 AudioContext resume (autoplay 정책)
  const resumeOnce = () => AudioEngine.resume();
  window.addEventListener('pointerdown', resumeOnce, { passive: true });
  window.addEventListener('keydown', resumeOnce, { passive: true });

  let uiBuilt = false;
  function buildUIOnce() {
    if (uiBuilt || !IS_TOP) return;
    if (!document.body) { document.addEventListener('DOMContentLoaded', buildUIOnce, { once: true }); return; }
    uiBuilt = true;
    try {
      UIManager.build();
      console.log('[증폭기] UI 표시 완료');
    } catch (e) {
      uiBuilt = false;
      console.error('[증폭기] UI 생성 실패:', e);
    }
  }

  console.log('[증폭기] 스크립트 시작 — 최상위 프레임:', IS_TOP, '| URL:', location.href);

  // 오디오 엔진은 영상 감지 시 연결
  VideoObserver.start();

  // UI는 영상 감지와 무관하게 항상 표시(여러 경로로 보장)
  buildUIOnce();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUIOnce, { once: true });
  }
  window.addEventListener('load', buildUIOnce, { once: true });
})();
