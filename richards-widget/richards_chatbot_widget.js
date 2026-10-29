(function() {
  'use strict';

  var DEPLOYMENT_TOKEN = '7f71d9e5d7fd48cca7bf0a8e2dae8877';
  var DEPLOYMENT_ID = 'dea3a558c';
  var API_URL = 'https://api.abacus.ai/api/v0/getChatResponse';
  var PRIMARY_COLOR = '#28A745';
  var BOT_NAME = 'Peak Performers Alliance';

  // Derive the CDN origin from this script's own src so feedback + TTS post to the right place
  var CDN_ORIGIN = 'https://salesagent.abacusai.app';
  try {
    var thisScript = document.currentScript;
    if (thisScript && thisScript.src) {
      CDN_ORIGIN = new URL(thisScript.src).origin;
    }
  } catch (e) {}
  var FEEDBACK_URL = CDN_ORIGIN + '/api/feedback';
  var TTS_URL = CDN_ORIGIN + '/api/tts';
  var ROLEPLAY_URL = CDN_ORIGIN + '/api/roleplay';
  var TRANSCRIBE_URL = CDN_ORIGIN + '/api/transcribe';

  // Track the most recent user message so feedback has context
  var lastUserMessage = '';

  // Prevent double-init
  if (window.__richardsChatbotLoaded) return;
  window.__richardsChatbotLoaded = true;

  var conversationId = null;
  var isOpen = false;
  var isLoading = false;

  // --- Voice state ---
  var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  var voiceSupported = !!SpeechRec;
  var recognition = null;
  var recognizing = false;      // STT actively running
  var callMode = false;         // hands-free continuous "practice call"
  var speakerOn = false;        // speak replies for typed messages
  var lastInputWasVoice = false;
  var currentAudio = null;      // active premium <audio>
  var premiumAvailable = true;  // flips false if server has no key
  var speakToken = 0;           // generation counter to cancel stale/in-flight speech
  var micHoldTimer = null;
  var wantListenAfterSpeak = false;

  // --- Roleplay state ---
  var roleplayActive = false;
  var roleplayPersona = null;
  var roleplayMode = null;
  var rpHistory = [];   // full-roleplay transcript [{role:'user'|'assistant', content}]
  var awaitingScore = false;

  // ---------- DAILY POINTS TRACKER ----------
  var POINTS_CAP = 10;
  var POINTS_KEY = 'rc_daily_pts';
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
  function loadPoints() {
    try {
      var raw = localStorage.getItem(POINTS_KEY);
      if (raw) { var obj = JSON.parse(raw); if (obj.date === todayStr()) return obj.pts; }
    } catch(e) {}
    return 0;
  }
  function savePoints(pts) {
    try { localStorage.setItem(POINTS_KEY, JSON.stringify({date: todayStr(), pts: pts})); } catch(e) {}
  }
  var dailyPoints = loadPoints();      // 'full' | 'coached'
  var pendingMode = null;       // mode chosen, awaiting persona pick
  var speakerByRoleplay = false;
  // --- Live listening state ---
  var listenActive = false;     // listening to a real contractor call
  var listenTranscript = '';    // accumulated transcript
  var listenRec = null;         // dedicated continuous recognizer
  // --- Demo analysis (uploaded recording) state ---
  var demoActive = false;
  var demoXhr = null;

  // Contractor personas for one-tap roleplay practice.
  var PERSONAS = {
    sam: {
      name: 'Skeptical Sam', emoji: '🤨',
      blurb: 'Doubts a free CRM is any good; thinks his current process works fine.',
      desc: 'a skeptical roofing contractor who doubts a FREE CRM can be any good, is suspicious of the catch, and believes his current pen-and-paper / spreadsheet process already works fine.'
    },
    tony: {
      name: 'Time-Strapped Tony', emoji: '⏱️',
      blurb: 'Slammed busy; feels he has no time to learn new software.',
      desc: 'a slammed-busy siding contractor who is always on job sites, feels he has zero time to learn or set up new software, and keeps saying he\'ll "look at it later".'
    },
    terry: {
      name: 'Tech-Averse Terry', emoji: '📵',
      blurb: 'Old-school; hates technology, prefers paper and whiteboards.',
      desc: 'an old-school window contractor who distrusts and dislikes technology, prefers pen, paper and a whiteboard, and worries new software will be too complicated for him and his crew.'
    },
    pete: {
      name: 'Price-Shopping Pete', emoji: '💸',
      blurb: 'Comparing options; keeps bringing up Acculynx & JobNimbus.',
      desc: 'a comparison-shopping contractor who keeps bringing up Acculynx and JobNimbus, is skeptical about why RichardsCRM is free, and assumes free means worse.'
    },
    olivia: {
      name: 'Overwhelmed Owner Olivia', emoji: '😩',
      blurb: 'Drowning in daily chaos; can\'t get her crew to follow process.',
      desc: 'a roofing business owner drowning in daily chaos, struggling to get her crew to follow any consistent process, and worried about adding one more thing to her overloaded plate.'
    }
  };

  // Practice modes shown on the first step of the picker
  var MODES = {
    full: {
      emoji: '🎧', name: 'Full Roleplay',
      blurb: 'No interruptions. I stay the contractor the whole call while you sell — I score you at the end.'
    },
    coached: {
      emoji: '🎓', name: 'Coached Roleplay',
      blurb: 'I play the contractor but pause to give a quick tip whenever you slip, then continue the call.'
    },
    listen: {
      emoji: '👂', name: 'Live Call Listening',
      blurb: 'Practice on a real contractor. I listen quietly to your call, then score & coach you at the end.'
    },
    demo: {
      emoji: '🎙️', name: 'Demo Analysis',
      blurb: 'Upload a recorded sales demo (MP3, WAV, M4A). I\'ll score your NEPQ technique.'
    }
  };

  // --- Styles ---
  var style = document.createElement('style');
  style.textContent = [
    '.rc-widget-bubble{position:fixed;bottom:20px;right:20px;width:60px;height:60px;border-radius:50%;background:' + PRIMARY_COLOR + ';color:#fff;border:none;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.25);z-index:2147483646;display:flex;align-items:center;justify-content:center;transition:transform .2s,box-shadow .2s}',
    '.rc-widget-bubble:hover{transform:scale(1.08);box-shadow:0 6px 20px rgba(0,0,0,0.35)}',
    '.rc-widget-bubble svg{width:28px;height:28px;fill:#fff}',
    '.rc-widget-container{position:fixed;bottom:90px;right:20px;width:400px;max-width:calc(100vw - 40px);height:600px;max-height:calc(100vh - 120px);border-radius:16px;background:#fff;box-shadow:0 8px 32px rgba(0,0,0,0.2);z-index:2147483647;display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '.rc-widget-container.open{display:flex}',
    '.rc-widget-header{background:' + PRIMARY_COLOR + ';color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}',
    '.rc-widget-header-title{font-size:16px;font-weight:700;letter-spacing:0.3px}',
    '.rc-widget-header-sub{font-size:11px;opacity:0.85;margin-top:2px}',
    '.rc-pts-badge{display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,0.32);padding:3px 9px;border-radius:11px;font-size:12px;font-weight:800;margin-left:8px;vertical-align:middle;box-shadow:0 1px 2px rgba(0,0,0,0.12)}',
    '.rc-pts-badge.maxed{background:#FFD24D;color:#4a3600}',
    '.rc-pts-fill{height:5px;border-radius:3px;background:#fff;transition:width .4s ease}',
    '.rc-pts-track{width:52px;height:5px;border-radius:3px;background:rgba(255,255,255,0.3);overflow:hidden;flex-shrink:0}',
    '.rc-widget-head-actions{display:flex;align-items:center;gap:2px}',
    '.rc-icon-btn{background:none;border:none;color:#fff;cursor:pointer;padding:6px;border-radius:8px;line-height:0;display:flex;align-items:center;justify-content:center;opacity:0.9;transition:background .15s,opacity .15s}',
    '.rc-icon-btn:hover{background:rgba(255,255,255,0.2);opacity:1}',
    '.rc-icon-btn.active{background:rgba(255,255,255,0.28);opacity:1}',
    '.rc-icon-btn svg{width:20px;height:20px;fill:#fff}',
    '.rc-widget-close{font-size:22px;padding:4px 8px}',
    '.rc-widget-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;background:#f8faf8}',
    '.rc-widget-msg{max-width:85%;padding:12px 16px;border-radius:16px;font-size:14px;line-height:1.5;word-wrap:break-word;white-space:pre-wrap}',
    '.rc-widget-msg.bot{background:#fff;color:#1a1a1a;align-self:flex-start;border:1px solid #e8e8e8;border-bottom-left-radius:4px}',
    '.rc-widget-msg.user{background:' + PRIMARY_COLOR + ';color:#fff;align-self:flex-end;border-bottom-right-radius:4px}',
    '.rc-widget-msg.bot strong{font-weight:700}',
    '.rc-widget-msg.bot em{font-style:italic}',
    '.rc-widget-msg.bot code{background:#f0f0f0;padding:2px 5px;border-radius:3px;font-size:13px}',
    '.rc-widget-typing{display:flex;gap:4px;padding:12px 16px;align-self:flex-start}',
    '.rc-widget-typing span{width:8px;height:8px;border-radius:50%;background:#bbb;animation:rc-bounce 1.4s infinite ease-in-out both}',
    '.rc-widget-typing span:nth-child(1){animation-delay:-0.32s}',
    '.rc-widget-typing span:nth-child(2){animation-delay:-0.16s}',
    '@keyframes rc-bounce{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}',
    '.rc-widget-status{display:none;align-items:center;gap:8px;padding:8px 14px;font-size:12px;font-weight:600;color:#fff;background:' + PRIMARY_COLOR + ';flex-shrink:0}',
    '.rc-widget-status.show{display:flex}',
    '.rc-widget-status.listening{background:#e23b3b}',
    '.rc-widget-status.speaking{background:#2b7de9}',
    '.rc-widget-status.thinking{background:#8a6d1a}',
    '.rc-status-dot{width:9px;height:9px;border-radius:50%;background:#fff;animation:rc-pulse 1s infinite ease-in-out}',
    '.rc-status-end{margin-left:auto;background:rgba(255,255,255,0.25);border:none;color:#fff;font-size:11px;font-weight:700;padding:4px 10px;border-radius:12px;cursor:pointer}',
    '.rc-status-end:hover{background:rgba(255,255,255,0.4)}',
    '@keyframes rc-pulse{0%,100%{transform:scale(0.7);opacity:0.6}50%{transform:scale(1.2);opacity:1}}',
    '.rc-widget-input-area{display:flex;align-items:flex-end;padding:12px;border-top:1px solid #e8e8e8;background:#fff;flex-shrink:0;gap:8px}',
    '.rc-widget-input{flex:1;border:1px solid #ddd;border-radius:24px;padding:10px 16px;font-size:14px;outline:none;resize:none;font-family:inherit;max-height:100px;min-height:20px;line-height:1.4}',
    '.rc-widget-input:focus{border-color:' + PRIMARY_COLOR + '}',
    '.rc-widget-mic{background:#eef3ee;color:' + PRIMARY_COLOR + ';border:none;border-radius:50%;width:40px;height:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .2s,transform .1s}',
    '.rc-widget-mic:hover{background:#e0ece0}',
    '.rc-widget-mic svg{width:20px;height:20px;fill:' + PRIMARY_COLOR + '}',
    '.rc-widget-mic.listening{background:#e23b3b;animation:rc-mic-pulse 1.2s infinite}',
    '.rc-widget-mic.listening svg{fill:#fff}',
    '@keyframes rc-mic-pulse{0%{box-shadow:0 0 0 0 rgba(226,59,59,0.5)}70%{box-shadow:0 0 0 10px rgba(226,59,59,0)}100%{box-shadow:0 0 0 0 rgba(226,59,59,0)}}',
    '.rc-widget-send{background:' + PRIMARY_COLOR + ';color:#fff;border:none;border-radius:50%;width:40px;height:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:opacity .2s}',
    '.rc-widget-send:disabled{opacity:0.5;cursor:not-allowed}',
    '.rc-widget-send svg{width:18px;height:18px;fill:#fff}',
    '.rc-widget-welcome{text-align:center;padding:20px;color:#666;font-size:13px;line-height:1.6}',
    '.rc-widget-welcome h3{color:#1a1a1a;font-size:18px;margin:0 0 8px}',
    '.rc-widget-feedback{display:flex;gap:6px;align-self:flex-start;margin:-6px 0 2px 4px;align-items:center}',
    '.rc-widget-fb-btn{background:none;border:none;cursor:pointer;font-size:15px;line-height:1;padding:3px 5px;border-radius:6px;opacity:0.45;transition:opacity .15s,background .15s;filter:grayscale(1)}',
    '.rc-widget-fb-btn:hover{opacity:0.9;background:#eef3ee}',
    '.rc-widget-fb-btn.selected{opacity:1;filter:grayscale(0);background:#e3f1e6}',
    '.rc-widget-fb-btn.disabled{cursor:default;pointer-events:none}',
    '.rc-widget-fb-thanks{font-size:11px;color:#888;align-self:flex-start;margin:-4px 0 2px 6px}',
    '.rc-welcome-rp{margin-top:14px;background:' + PRIMARY_COLOR + ';color:#fff;border:none;border-radius:22px;padding:10px 18px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(40,167,69,0.3)}',
    '.rc-welcome-rp:hover{filter:brightness(1.05)}',
    '.rc-rp-panel{position:absolute;top:58px;left:0;right:0;bottom:0;background:#fff;z-index:6;display:none;flex-direction:column;padding:18px 16px;overflow-y:auto}',
    '.rc-rp-panel.show{display:flex}',
    '.rc-rp-title{font-size:16px;font-weight:800;color:#1a1a1a}',
    '.rc-rp-sub{font-size:12px;color:#666;margin:6px 0 14px;line-height:1.5}',
    '.rc-rp-list{display:flex;flex-direction:column;gap:8px}',
    '.rc-rp-item{display:flex;align-items:center;gap:12px;text-align:left;background:#f4f8f4;border:1px solid #e2ece2;border-radius:12px;padding:12px 14px;cursor:pointer;transition:background .15s,transform .1s;width:100%}',
    '.rc-rp-item:hover{background:#e9f3e9}',
    '.rc-rp-item:active{transform:scale(0.99)}',
    '.rc-rp-emoji{font-size:22px;flex-shrink:0;line-height:1}',
    '.rc-rp-item-name{font-size:14px;font-weight:700;color:#1a1a1a;display:block}',
    '.rc-rp-item-desc{font-size:11px;color:#777;margin-top:2px;line-height:1.4;display:block}',
    '.rc-rp-cancel{margin-top:14px;background:none;border:1px solid #ddd;border-radius:10px;padding:9px;font-size:13px;color:#555;cursor:pointer}',
    '.rc-rp-cancel:hover{background:#f2f2f2}',
    '.rc-demo-overlay{position:absolute;top:58px;left:0;right:0;bottom:0;background:#fff;z-index:7;display:none;flex-direction:column;align-items:center;justify-content:center;padding:18px 16px}',
    '.rc-demo-overlay.show{display:flex}',
    '.rc-demo-progress{background:#28A745;border-radius:8px;animation:rc-demo-pulse 1.4s ease-in-out infinite}',
    '@keyframes rc-demo-pulse{0%,100%{opacity:1}50%{opacity:.55}}',
    '.rc-demo-status-text{text-align:center;color:#666;font-size:13px}',
    '.rc-demo-cancel-btn{margin-top:14px;background:none;border:1px solid #ddd;border-radius:10px;padding:9px 18px;font-size:13px;color:#555;cursor:pointer}',
    '.rc-demo-cancel-btn:hover{background:#f2f2f2}'
  ].join('\n');
  document.head.appendChild(style);

  // --- Icons ---
  var ICON_MIC = '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/><path d="M17 11a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';
  var ICON_SPEAKER_ON = '<svg viewBox="0 0 24 24"><path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z"/></svg>';
  var ICON_SPEAKER_OFF = '<svg viewBox="0 0 24 24"><path d="M3 10v4h4l5 5V5L7 10H3z"/><path d="M19 12l2.5-2.5-1.4-1.4L17.6 10.6 15.1 8.1l-1.4 1.4L16.2 12l-2.5 2.5 1.4 1.4 2.5-2.5 2.5 2.5 1.4-1.4L19 12z"/></svg>';
  var ICON_CALL = '<svg viewBox="0 0 24 24"><path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02l-2.2 2.2z"/></svg>';
  var ICON_CALL_END = '<svg viewBox="0 0 24 24"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 0 1-1.39-.03L.29 13.08a1 1 0 0 1 0-1.41C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67a1 1 0 0 1 0 1.41l-2.5 2.36a1 1 0 0 1-1.39.03 12.4 12.4 0 0 0-2.66-1.85.999.999 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>';
  var ICON_ROLEPLAY = '<svg viewBox="0 0 24 24"><path d="M12 2a5 5 0 0 1 5 5v2a5 5 0 0 1-10 0V7a5 5 0 0 1 5-5zm-7 9a1 1 0 0 1 2 0 5 5 0 0 0 10 0 1 1 0 0 1 2 0 7 7 0 0 1-6 6.92V21a1 1 0 0 1-2 0v-3.08A7 7 0 0 1 5 11z"/></svg>';

  // --- Create DOM ---
  var bubble = document.createElement('button');
  bubble.className = 'rc-widget-bubble';
  bubble.setAttribute('aria-label', 'Open chat');
  bubble.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>';
  document.body.appendChild(bubble);

  var container = document.createElement('div');
  container.className = 'rc-widget-container';
  var rpHeadBtn = '<button class="rc-icon-btn" id="rc-roleplay" aria-label="Start roleplay" title="Practice roleplay">' + ICON_ROLEPLAY + '</button>';
  var headActions = rpHeadBtn + (voiceSupported
    ? ('<button class="rc-icon-btn" id="rc-call" aria-label="Start practice call" title="Hands-free practice call">' + ICON_CALL + '</button>' +
       '<button class="rc-icon-btn" id="rc-speaker" aria-label="Toggle voice replies" title="Toggle voice replies">' + ICON_SPEAKER_OFF + '</button>')
    : '');
  container.innerHTML = [
    '<div class="rc-widget-header">',
    '  <div><div class="rc-widget-header-title">🏆 ' + BOT_NAME + '</div>',
    '  <div class="rc-widget-header-sub">Richards Supply Edition • NEPQ Sales Coach<span class="rc-pts-badge" id="rc-pts-badge" title="Daily practice points"><span id="rc-pts-num">' + dailyPoints + '/' + POINTS_CAP + ' pts</span><span class="rc-pts-track"><span class="rc-pts-fill" id="rc-pts-fill" style="width:' + (dailyPoints/POINTS_CAP*100) + '%"></span></span></span></div></div>',
    '  <div class="rc-widget-head-actions">',
    '    ' + headActions,
    '    <button class="rc-icon-btn rc-widget-close" aria-label="Close chat">&times;</button>',
    '  </div>',
    '</div>',
    '<div class="rc-widget-messages" id="rc-messages">',
    '  <div class="rc-widget-welcome">',
    '    <h3>👋 Welcome!</h3>',
    '    <p>I\'m your Elite Sales Coach for the <strong>RichardsCRM</strong>.</p>',
    (voiceSupported
      ? '    <p style="font-size:12px;margin-top:8px;color:#888">Tap 🎤 to talk, or 📞 for a hands-free practice call.</p>'
      : '    <p style="font-size:12px;margin-top:8px;color:#888">Try: "contractor roleplay" or "objection: no time"</p>'),
    '    <button class="rc-welcome-rp" id="rc-welcome-rp">🎭 Start a Practice Roleplay</button>',
    '  </div>',
    '</div>',
    '<div class="rc-rp-panel" id="rc-rp-panel">',
    '  <div class="rc-rp-title" id="rc-rp-title">🎭 Practice Roleplay</div>',
    '  <div class="rc-rp-sub" id="rc-rp-sub">Choose how you want to practice.</div>',
    '  <div class="rc-rp-list" id="rc-rp-list"></div>',
    '  <button class="rc-rp-cancel" id="rc-rp-cancel">Cancel</button>',
    '</div>',
    '<input type="file" id="rc-demo-file" accept="audio/*,.mp3,.wav,.m4a,.mp4,.ogg,.webm" style="display:none">',
    '<div class="rc-demo-overlay" id="rc-demo-overlay">',
    '  <div style="text-align:center;padding:20px 16px;">',
    '    <div style="font-size:32px;margin-bottom:12px">🎙️</div>',
    '    <div class="rc-demo-status-text" id="rc-demo-status-text">Uploading…</div>',
    '    <div style="margin:16px 0;background:#eee;border-radius:8px;height:8px;overflow:hidden;">',
    '      <div class="rc-demo-progress" id="rc-demo-progress" style="width:0%;height:100%;background:#28A745;border-radius:8px;transition:width 0.3s ease;"></div>',
    '    </div>',
    '    <div style="font-size:11px;color:#aaa;margin-bottom:16px" id="rc-demo-hint">Large recordings may take a minute to transcribe</div>',
    '    <button class="rc-demo-cancel-btn" id="rc-demo-cancel">Cancel</button>',
    '  </div>',
    '</div>',
    '<div class="rc-widget-status" id="rc-status">',
    '  <span class="rc-status-dot"></span><span id="rc-status-text">Listening…</span>',
    '  <button class="rc-status-end" id="rc-status-end">End call</button>',
    '</div>',
    '<div class="rc-widget-input-area">',
    (voiceSupported
      ? '  <button class="rc-widget-mic" id="rc-mic" aria-label="Speak">' + ICON_MIC + '</button>'
      : ''),
    '  <textarea class="rc-widget-input" id="rc-input" placeholder="Ask me anything..." rows="1"></textarea>',
    '  <button class="rc-widget-send" id="rc-send" aria-label="Send">',
    '    <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>',
    '  </button>',
    '</div>'
  ].join('');
  document.body.appendChild(container);

  var messagesEl = document.getElementById('rc-messages');
  var inputEl = document.getElementById('rc-input');
  var sendBtn = document.getElementById('rc-send');
  var closeBtn = container.querySelector('.rc-widget-close');
  var micBtn = document.getElementById('rc-mic');
  var speakerBtn = document.getElementById('rc-speaker');
  var callBtn = document.getElementById('rc-call');
  var statusEl = document.getElementById('rc-status');
  var statusText = document.getElementById('rc-status-text');
  var statusEndBtn = document.getElementById('rc-status-end');
  var roleplayBtn = document.getElementById('rc-roleplay');
  var rpPanel = document.getElementById('rc-rp-panel');
  var rpTitle = document.getElementById('rc-rp-title');
  var rpSub = document.getElementById('rc-rp-sub');
  var rpList = document.getElementById('rc-rp-list');
  var rpCancel = document.getElementById('rc-rp-cancel');
  var welcomeRpBtn = container.querySelector('#rc-welcome-rp');

  // --- Toggle open/close ---
  function toggle() {
    isOpen = !isOpen;
    container.classList.toggle('open', isOpen);
    if (isOpen) {
      inputEl.focus();
    } else {
      closePicker();
      if (roleplayActive) cancelRoleplay();
      else if (listenActive) cancelListenMode();
      else if (demoActive) cancelDemoAnalysis();
      else endCall();
      stopSpeaking();
    }
  }
  bubble.addEventListener('click', toggle);
  closeBtn.addEventListener('click', toggle);

  inputEl.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
  });

  // --- Markdown to HTML (display) ---
  function md(text) {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^### (.+)$/gm, '<strong style="font-size:15px">$1</strong>')
      .replace(/^## (.+)$/gm, '<strong style="font-size:16px">$1</strong>')
      .replace(/^# (.+)$/gm, '<strong style="font-size:17px">$1</strong>')
      .replace(/^[-•] (.+)$/gm, '  • $1')
      .replace(/^\d+\. (.+)$/gm, function(m) { return '  ' + m; });
  }

  // --- Strip markdown/emoji for clean speech ---
  function speechText(text) {
    return text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^[-•]\s+/gm, '')
      .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function addMessage(text, isUser) {
    var welcome = messagesEl.querySelector('.rc-widget-welcome');
    if (welcome) welcome.remove();
    var div = document.createElement('div');
    div.className = 'rc-widget-msg ' + (isUser ? 'user' : 'bot');
    div.innerHTML = isUser ? text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : md(text);
    messagesEl.appendChild(div);
    if (isUser) {
      lastUserMessage = text;
    } else {
      addFeedback(text);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  // --- Feedback (thumbs up/down) ---
  function addFeedback(botText) {
    var userMsgAtTime = lastUserMessage;
    var row = document.createElement('div');
    row.className = 'rc-widget-feedback';
    var up = document.createElement('button');
    up.className = 'rc-widget-fb-btn'; up.type = 'button';
    up.setAttribute('aria-label', 'Helpful'); up.textContent = '👍';
    var down = document.createElement('button');
    down.className = 'rc-widget-fb-btn'; down.type = 'button';
    down.setAttribute('aria-label', 'Not helpful'); down.textContent = '👎';
    function choose(rating, btn) {
      up.classList.add('disabled'); down.classList.add('disabled');
      btn.classList.add('selected');
      var thanks = document.createElement('span');
      thanks.className = 'rc-widget-fb-thanks';
      thanks.textContent = 'Thanks for the feedback!';
      row.appendChild(thanks);
      sendFeedback(rating, botText, userMsgAtTime);
    }
    up.addEventListener('click', function() { choose('up', up); });
    down.addEventListener('click', function() { choose('down', down); });
    row.appendChild(up); row.appendChild(down);
    messagesEl.appendChild(row);
  }

  function sendFeedback(rating, botText, userText) {
    try {
      fetch(FEEDBACK_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          rating: rating, botMessage: botText, userMessage: userText,
          conversationId: conversationId, pageUrl: window.location.href
        })
      }).catch(function() {});
    } catch (e) {}
  }

  function showTyping() {
    var div = document.createElement('div');
    div.className = 'rc-widget-typing';
    div.id = 'rc-typing';
    div.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function hideTyping() {
    var el = document.getElementById('rc-typing');
    if (el) el.remove();
  }

  // ---------- STATUS BAR ----------
  function setStatus(kind, text, showEnd) {
    statusEl.className = 'rc-widget-status show ' + kind;
    statusText.textContent = text;
    statusEndBtn.style.display = showEnd ? 'block' : 'none';
  }
  function clearStatus() {
    statusEl.className = 'rc-widget-status';
  }

  // ---------- TEXT TO SPEECH ----------
  function stopSpeaking() {
    // Invalidate any in-flight or queued speech so a stale request can't start talking.
    speakToken++;
    if (currentAudio) {
      try { currentAudio.pause(); currentAudio.src = ''; } catch (e) {}
      currentAudio = null;
    }
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
  }

  function browserSpeak(text, done) {
    if (!window.speechSynthesis) { if (done) done(); return; }
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0; u.pitch = 1.0; u.lang = 'en-US';
      u.onend = function() { if (done) done(); };
      u.onerror = function() { if (done) done(); };
      window.speechSynthesis.speak(u);
    } catch (e) { if (done) done(); }
  }

  // Speak a bot reply. Uses premium ElevenLabs; falls back to browser voice.
  function speak(rawText, done) {
    var text = speechText(rawText);
    if (!text) { if (done) done(); return; }
    stopSpeaking();               // cancels anything playing AND bumps the token
    var myToken = speakToken;     // this request's generation
    var fellBack = false;
    function fallback() {
      if (fellBack) return;       // never let two fallbacks stack
      fellBack = true;
      if (myToken !== speakToken) { if (done) done(); return; }
      browserSpeak(text, done);
    }

    if (!premiumAvailable) { browserSpeak(text, done); return; }

    fetch(TTS_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ text: text })
    })
    .then(function(r) {
      if (r.status === 503) { premiumAvailable = false; throw new Error('premium_off'); }
      if (!r.ok) throw new Error('tts_http_' + r.status);
      var ct = r.headers.get('Content-Type') || '';
      if (ct.indexOf('audio') === -1) throw new Error('not_audio');
      return r.blob();
    })
    .then(function(blob) {
      // A newer request (or a stop) superseded this one while it was fetching.
      if (myToken !== speakToken) { if (done) done(); return; }
      var url = URL.createObjectURL(blob);
      var audio = new Audio(url);
      currentAudio = audio;
      audio.onended = function() {
        URL.revokeObjectURL(url);
        if (currentAudio === audio) currentAudio = null;
        if (done) done();
      };
      audio.onerror = function() {
        URL.revokeObjectURL(url);
        if (currentAudio === audio) currentAudio = null;
        fallback();
      };
      audio.play().catch(function() {
        // Autoplay blocked -> fall back (once)
        if (currentAudio === audio) currentAudio = null;
        fallback();
      });
    })
    .catch(function() {
      fallback();
    });
  }

  // ---------- SPEECH RECOGNITION ----------
  // How long the rep must be silent (after speaking) before their turn is
  // considered finished and sent to the bot. The browser's default
  // non-continuous mode ends after ~1s of silence, which cut reps off mid-sentence.
  var END_OF_TURN_SILENCE_MS = 4000;
  // If the rep hasn't said anything yet, wait this long before giving up/restarting.
  var NO_SPEECH_TIMEOUT_MS = 12000;

  function buildRecognition() {
    if (!voiceSupported) return null;
    var rec = new SpeechRec();
    rec.lang = 'en-US';
    rec.continuous = true;        // don't let the browser end the turn on short pauses
    rec.interimResults = true;
    var finalText = '';
    var currentInterim = '';
    var silenceTimer = null;
    var turnDone = false;         // true once WE decided the turn is over (silence / manual stop / error)
    var resuming = false;         // true while auto-restarting after a browser-initiated stop

    function clearSilenceTimer() {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    }
    function armSilenceTimer(ms) {
      clearSilenceTimer();
      silenceTimer = setTimeout(function() {
        turnDone = true;
        try { rec.stop(); } catch (e) {}
      }, ms);
    }
    rec.endTurn = function() {
      turnDone = true;
      clearSilenceTimer();
      try { rec.stop(); } catch (e) {}
    };

    rec.onstart = function() {
      recognizing = true;
      if (!resuming) { finalText = ''; currentInterim = ''; }
      resuming = false;
      turnDone = false;
      armSilenceTimer((finalText || currentInterim).trim() ? END_OF_TURN_SILENCE_MS : NO_SPEECH_TIMEOUT_MS);
      micBtn && micBtn.classList.add('listening');
      if (callMode) setStatus('listening', 'Listening… take your time', true);
      else setStatus('listening', 'Listening… tap 🎤 to stop', false);
    };
    rec.onresult = function(e) {
      var interim = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t + ' ';
        else interim += t;
      }
      currentInterim = interim;
      var shown = (finalText + interim).trim();
      if (shown) inputEl.value = shown;
      // Every new bit of speech resets the end-of-turn countdown.
      armSilenceTimer(shown ? END_OF_TURN_SILENCE_MS : NO_SPEECH_TIMEOUT_MS);
    };
    rec.onerror = function(ev) {
      if (ev && ev.error === 'no-speech') return;   // onend will handle restart
      turnDone = true;
      clearSilenceTimer();
      recognizing = false;
      micBtn && micBtn.classList.remove('listening');
      if (ev && (ev.error === 'not-allowed' || ev.error === 'service-not-allowed')) {
        callMode = false;
        callBtn && callBtn.classList.remove('active');
        clearStatus();
        addMessage('I need microphone access to hear you. Please allow the mic in your browser and try again.', false);
      }
    };
    rec.onend = function() {
      // Browsers (esp. Chrome) stop continuous recognition on their own sometimes.
      // If we didn't end the turn, quietly resume and keep what was said so far.
      if (!turnDone) {
        if (currentInterim) { finalText += currentInterim + ' '; currentInterim = ''; }
        resuming = true;
        try { rec.start(); return; } catch (e) { resuming = false; }
      }
      clearSilenceTimer();
      recognizing = false;
      micBtn && micBtn.classList.remove('listening');
      if (currentInterim) { finalText += currentInterim + ' '; currentInterim = ''; }
      var text = (finalText || inputEl.value).trim();
      if (text) {
        lastInputWasVoice = true;
        sendMessage();
      } else if (callMode) {
        // No speech captured; keep the call alive by listening again.
        clearStatus();
        setTimeout(function() { if (callMode && !isLoading && !currentAudio) startListening(); }, 300);
      } else {
        clearStatus();
      }
    };
    return rec;
  }

  function startListening() {
    if (!voiceSupported) return;
    if (listenActive) return;   // live-listening uses its own recognizer
    if (recognizing) return;
    stopSpeaking();
    if (!recognition) recognition = buildRecognition();
    try { recognition.start(); }
    catch (e) {
      // start() can throw if called too soon after a previous run; retry shortly.
      setTimeout(function() { try { recognition.start(); } catch (e2) {} }, 250);
    }
  }

  function stopListening() {
    if (recognition && recognizing) {
      if (recognition.endTurn) recognition.endTurn();
      else { try { recognition.stop(); } catch (e) {} }
    }
  }

  // ---------- CALL MODE (hands-free) ----------
  function startCall() {
    if (!voiceSupported) return;
    callMode = true;
    callBtn && callBtn.classList.add('active');
    callBtn && callBtn.setAttribute('title', 'End practice call');
    if (callBtn) callBtn.innerHTML = ICON_CALL_END;
    speakerOn = true;
    updateSpeakerBtn();
    setStatus('listening', 'Practice call started — start talking', true);
    startListening();
  }
  function endCall() {
    if (!callMode && !recognizing) { clearStatus(); return; }
    callMode = false;
    callBtn && callBtn.classList.remove('active');
    callBtn && callBtn.setAttribute('title', 'Hands-free practice call');
    if (callBtn) callBtn.innerHTML = ICON_CALL;
    stopListening();
    clearStatus();
  }
  if (callBtn) {
    callBtn.addEventListener('click', function() {
      if (roleplayActive) endRoleplay();
      else if (listenActive) endListenMode();
      else if (callMode) endCall(); else startCall();
    });
  }
  if (statusEndBtn) {
    statusEndBtn.addEventListener('click', function() {
      if (roleplayActive) { endRoleplay(); return; }
      if (listenActive) { endListenMode(); return; }
      stopSpeaking(); endCall();
    });
  }

  // ---------- SPEAKER TOGGLE ----------
  function updateSpeakerBtn() {
    if (!speakerBtn) return;
    speakerBtn.innerHTML = speakerOn ? ICON_SPEAKER_ON : ICON_SPEAKER_OFF;
    speakerBtn.classList.toggle('active', speakerOn);
    speakerBtn.setAttribute('title', speakerOn ? 'Voice replies on' : 'Voice replies off');
  }
  if (speakerBtn) {
    updateSpeakerBtn();
    speakerBtn.addEventListener('click', function() {
      speakerOn = !speakerOn;
      if (!speakerOn) {
        stopSpeaking();
        // If speaking status was showing, clear it so UI doesn't hang on "Speaking..."
        var sb = document.getElementById('rc-status-bar');
        if (sb && sb.className.indexOf('speaking') !== -1) clearStatus();
      }
      updateSpeakerBtn();
    });
  }

  // ---------- MIC (push to talk) ----------
  if (micBtn) {
    micBtn.addEventListener('click', function() {
      if (recognizing) { stopListening(); }
      else { startListening(); }
    });
  }

  // ---------- ROLEPLAY / PRACTICE MODES ----------
  function makeItem(emoji, name, desc, onClick) {
    var item = document.createElement('button');
    item.className = 'rc-rp-item';
    item.type = 'button';
    item.innerHTML = '<span class="rc-rp-emoji">' + emoji + '</span>' +
      '<span><span class="rc-rp-item-name">' + name + '</span>' +
      '<span class="rc-rp-item-desc">' + desc + '</span></span>';
    item.addEventListener('click', onClick);
    return item;
  }
  function buildModeList() {
    if (!rpList) return;
    rpList.innerHTML = '';
    Object.keys(MODES).forEach(function(key) {
      var m = MODES[key];
      (function(k, m) {
        rpList.appendChild(makeItem(m.emoji, m.name, m.blurb, function() {
          if (k === 'listen') startListenMode();
          else if (k === 'demo') startDemoAnalysis();
          else showPersonaStep(k);
        }));
      })(key, m);
    });
  }
  function buildPersonaList() {
    if (!rpList) return;
    rpList.innerHTML = '';
    Object.keys(PERSONAS).forEach(function(key) {
      var p = PERSONAS[key];
      rpList.appendChild(makeItem(p.emoji, p.name, p.blurb, function() {
        startRoleplay(key, pendingMode || 'full');
      }));
    });
  }
  function showModeStep() {
    pendingMode = null;
    if (rpTitle) rpTitle.innerHTML = '🎭 Practice Roleplay';
    if (rpSub) rpSub.innerHTML = 'Choose how you want to practice.';
    if (rpCancel) rpCancel.textContent = 'Cancel';
    buildModeList();
  }
  function showPersonaStep(mode) {
    pendingMode = mode;
    var m = MODES[mode];
    if (rpTitle) rpTitle.innerHTML = m.emoji + ' ' + m.name;
    if (rpSub) rpSub.innerHTML = 'Pick a contractor to practice with. Tap <strong>End</strong> anytime to finish and get scored.';
    if (rpCancel) rpCancel.textContent = '← Back';
    buildPersonaList();
  }
  function openPicker() {
    if (!rpPanel || roleplayActive || listenActive) return;
    showModeStep();
    rpPanel.classList.add('show');
  }
  function closePicker() {
    if (rpPanel) rpPanel.classList.remove('show');
  }
  function startRoleplay(key, mode) {
    var p = PERSONAS[key];
    if (!p) return;
    closePicker();
    roleplayActive = true;
    roleplayPersona = p;
    roleplayMode = (mode === 'coached') ? 'coached' : 'full';
    rpHistory = [];
    if (voiceSupported) {
      callMode = true;
      callBtn && callBtn.classList.add('active');
      callBtn && callBtn.setAttribute('title', 'End roleplay');
      if (callBtn) callBtn.innerHTML = ICON_CALL_END;
      if (!speakerOn) { speakerOn = true; speakerByRoleplay = true; updateSpeakerBtn(); }
    }
    var kickoff, shown;
    if (roleplayMode === 'coached') {
      kickoff = 'COACHED ROLEPLAY MODE. You are now ' + p.name + ' — ' + p.desc +
        ' I am a Richards Supply sales rep practicing on you. Play this contractor prospect realistically, one natural spoken turn at a time, raising objections and not giving in easily. This is a COACHED drill: after each of my responses, silently judge my NEPQ technique. If I made a mistake or missed a clear opportunity, BRIEFLY step out of character for ONE short coaching note (1–2 sentences, begin it with "Coach:") telling me exactly what to do better, then immediately step back into character with your next line as ' + p.name + '. If I handled it well, stay fully in character and simply continue with your next objection or reaction — no coaching note. Keep any coaching note short and only when it genuinely helps. Do NOT give an overall score until I say "end roleplay". IMPORTANT: Do NOT speak first. Wait silently for my opening sales line, then respond in character as ' + p.name + '.';
      shown = '🎓 Starting Coached Roleplay with ' + p.name;
    } else {
      kickoff = 'ROLEPLAY MODE. You are now ' + p.name + ' — ' + p.desc +
        ' I am a Richards Supply sales rep making a call to you. Stay 100% in character as this contractor prospect for the ENTIRE conversation. Respond ONLY as ' + p.name +
        ', one natural spoken turn at a time. This is a FULL, uninterrupted roleplay: under NO circumstances do you coach me, break character, analyze, hint, summarize, or give ANY feedback or score mid-conversation — not even a single word — until I explicitly say "end roleplay". Be realistic: raise objections naturally, do not give in easily, and make me earn it. Let the call run its full course like a real sales call and keep going turn by turn until I either book/close the appointment with you or I say "end roleplay". If I genuinely earn it with good NEPQ questioning, you MAY realistically agree to set the appointment so I get to practice closing — do not fold too early, but do not block a well-earned close either. After we agree on the appointment, stay in character and let me confirm the details; still do NOT coach until I say "end roleplay". IMPORTANT: Do NOT speak first. Wait silently for my opening sales line, then respond in character as ' + p.name + '.';
      shown = '🎧 Starting Full Roleplay with ' + p.name;
    }
    if (roleplayMode === 'full') {
      // Full roleplay runs through the dedicated coach-free endpoint. The prospect
      // never speaks first — show a short setup line and wait for the rep's opener.
      addMessage(shown, false);
      addMessage('📞 You\'re on a live call with ' + p.name + '. Go ahead — give your opening line whenever you\'re ready.', false);
      if (!callMode) setStatus('', 'Roleplay in progress — tap End when done', true);
    } else {
      sendMessage(kickoff, shown);
      if (!voiceSupported) {
        setTimeout(function() {
          if (roleplayActive && !callMode) setStatus('', 'Roleplay in progress — tap End when done', true);
        }, 50);
      }
    }
  }

  // ----- FULL ROLEPLAY (coach-free endpoint) -----
  function roleplayTurn(repText) {
    rpHistory.push({ role: 'user', content: repText });
    fetch(ROLEPLAY_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        action: 'dialogue',
        personaName: roleplayPersona ? roleplayPersona.name : '',
        personaDesc: roleplayPersona ? roleplayPersona.desc : '',
        history: rpHistory
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      hideTyping();
      isLoading = false;
      sendBtn.disabled = false;
      if (data && data.success && data.reply) {
        rpHistory.push({ role: 'assistant', content: data.reply });
        addMessage(data.reply, false);
        onBotReply(data.reply);
      } else {
        addMessage('Sorry, I lost the call for a second. Say that again?', false);
        if (callMode) { setTimeout(function() { if (callMode) startListening(); }, 300); }
        else clearStatus();
      }
    })
    .catch(function() {
      hideTyping();
      isLoading = false;
      sendBtn.disabled = false;
      addMessage('Connection error. Please try again.', false);
      if (callMode) endCall(); else clearStatus();
    });
  }

  function scoreFullRoleplay() {
    fetch(ROLEPLAY_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        action: 'score',
        personaName: roleplayPersona ? roleplayPersona.name : '',
        history: rpHistory
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      hideTyping();
      isLoading = false;
      sendBtn.disabled = false;
      clearStatus();
      if (data && data.success && data.reply) {
        addMessage(data.reply, false);
        onBotReply(data.reply);
      } else {
        awaitingScore = false;
        addMessage('I couldn\'t score that call — the transcript may have been too short. Try another roleplay.', false);
      }
    })
    .catch(function() {
      hideTyping();
      isLoading = false;
      sendBtn.disabled = false;
      awaitingScore = false;
      clearStatus();
      addMessage('Connection error while scoring. Please try again.', false);
    });
  }
  function scoreListen(transcript) {
    fetch(ROLEPLAY_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        action: 'score',
        scoreMode: 'listen',
        transcriptText: transcript
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      hideTyping();
      isLoading = false;
      sendBtn.disabled = false;
      clearStatus();
      if (data && data.success && data.reply) {
        addMessage(data.reply, false);
        onBotReply(data.reply);
      } else {
        awaitingScore = false;
        addMessage('I couldn\'t score that call — I may not have caught enough of the conversation. Try again with the phone on speaker.', false);
      }
    })
    .catch(function() {
      hideTyping();
      isLoading = false;
      sendBtn.disabled = false;
      awaitingScore = false;
      clearStatus();
      addMessage('Connection error while scoring. Please try again.', false);
    });
  }
  function resetRoleplayVoice() {
    callMode = false;
    callBtn && callBtn.classList.remove('active');
    callBtn && callBtn.setAttribute('title', 'Hands-free practice call');
    if (callBtn) callBtn.innerHTML = ICON_CALL;
    if (speakerByRoleplay) { speakerOn = false; speakerByRoleplay = false; updateSpeakerBtn(); }
    stopListening();
    stopSpeaking();
  }
  function endRoleplay() {
    if (!roleplayActive) return;
    var wasCoached = (roleplayMode === 'coached');
    roleplayActive = false;
    roleplayMode = null;
    resetRoleplayVoice();
    awaitingScore = true;
    lastScenarioLabel = (roleplayPersona ? roleplayPersona.name + ' — ' : '') + (wasCoached ? 'Coached roleplay' : 'Full roleplay');
    setStatus('thinking', 'Scoring your call...', false);
    // Both full and coached roleplays are now scored by the reliable coach-free
    // scorer using the transcript we captured — the coach bot no longer scores
    // (it was unreliable and sometimes replied "no roleplay to score").
    addMessage('🏁 End roleplay — score & coach me', true);
    showTyping();
    isLoading = true;
    sendBtn.disabled = true;
    scoreFullRoleplay();
  }
  function cancelRoleplay() {
    roleplayActive = false;
    roleplayMode = null;
    resetRoleplayVoice();
    clearStatus();
  }

  // ---------- LIVE CALL LISTENING ----------
  function buildListenRecognition() {
    if (!voiceSupported) return null;
    var rec = new SpeechRec();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = function(e) {
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) listenTranscript += e.results[i][0].transcript + ' ';
      }
    };
    rec.onerror = function(ev) {
      if (ev && (ev.error === 'not-allowed' || ev.error === 'service-not-allowed')) {
        listenActive = false;
        clearStatus();
        addMessage('I need microphone access to listen to your call. Please allow the mic in your browser and try again.', false);
      }
    };
    rec.onend = function() {
      // Browsers stop continuous recognition periodically; keep it alive while listening.
      if (listenActive) {
        try { rec.start(); }
        catch (e) { setTimeout(function() { if (listenActive) { try { rec.start(); } catch (e2) {} } }, 300); }
      }
    };
    return rec;
  }
  function startListenMode() {
    closePicker();
    listenActive = true;
    listenTranscript = '';
    if (!voiceSupported) {
      addMessage('Live listening needs a microphone, which this browser does not support. Instead, type or paste what was said on your call, then tap End and I will score it.', false);
      setStatus('', 'Listening mode — type the call, then tap End', true);
      return;
    }
    stopSpeaking();
    listenRec = buildListenRecognition();
    setStatus('listening', 'Listening to your call… tap End to score', true);
    try { listenRec.start(); }
    catch (e) { setTimeout(function() { try { listenRec.start(); } catch (e2) {} }, 250); }
  }
  function endListenMode() {
    if (!listenActive) return;
    listenActive = false;
    if (listenRec) { try { listenRec.stop(); } catch (e) {} }
    var typed = inputEl.value.trim();
    var convo = (listenTranscript + ' ' + typed).trim();
    if (!convo) {
      clearStatus();
      addMessage('I did not catch any of the conversation. Make sure your mic can hear the call — putting the phone on speaker helps — then try again.', false);
      return;
    }
    inputEl.value = ''; inputEl.style.height = 'auto';
    awaitingScore = true;
    lastScenarioLabel = 'Live call listening';
    setStatus('thinking', 'Scoring your call…', false);
    addMessage('👂 End listening — score & coach me', true);
    showTyping(); isLoading = true; sendBtn.disabled = true;
    scoreListen(convo);
  }
  function cancelListenMode() {
    listenActive = false;
    if (listenRec) { try { listenRec.stop(); } catch (e) {} }
    clearStatus();
  }

  // ---------- DEMO ANALYSIS (audio file upload) ----------
  function startDemoAnalysis() {
    closePicker();
    var fileInput = document.getElementById('rc-demo-file');
    if (fileInput) fileInput.click();
  }

  function showDemoOverlay(statusMsg, progressPct) {
    var overlay = document.getElementById('rc-demo-overlay');
    var statusText = document.getElementById('rc-demo-status-text');
    var progressBar = document.getElementById('rc-demo-progress');
    if (overlay) overlay.classList.add('show');
    if (statusText) statusText.textContent = statusMsg || 'Uploading…';
    if (progressBar) progressBar.style.width = (progressPct || 0) + '%';
  }

  function hideDemoOverlay() {
    var overlay = document.getElementById('rc-demo-overlay');
    if (overlay) overlay.classList.remove('show');
  }

  function cancelDemoAnalysis() {
    demoActive = false;
    if (demoXhr) { try { demoXhr.abort(); } catch (e) {} demoXhr = null; }
    hideDemoOverlay();
    var fileInput = document.getElementById('rc-demo-file');
    if (fileInput) fileInput.value = '';
  }

  function handleDemoUpload(file) {
    if (!file) return;
    var maxBytes = 200 * 1024 * 1024; // 200MB
    if (file.size > maxBytes) {
      addMessage('That file is too large (max 200MB). Please compress or trim the recording and try again.', false);
      return;
    }
    demoActive = true;
    showDemoOverlay('Uploading recording…', 5);
    var formData = new FormData();
    formData.append('audio', file, file.name);
    var xhr = new XMLHttpRequest();
    demoXhr = xhr;
    xhr.open('POST', TRANSCRIBE_URL, true);
    xhr.upload.onprogress = function(e) {
      if (e.lengthComputable) {
        var pct = Math.round((e.loaded / e.total) * 60); // upload = 0-60%
        showDemoOverlay('Uploading recording… ' + pct + '%', pct);
      }
    };
    xhr.onload = function() {
      demoXhr = null;
      if (!demoActive) return;
      showDemoOverlay('Transcribing audio… this may take a moment', 70);
      var data;
      try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
      if (xhr.status === 200 && data && data.success && data.transcript) {
        showDemoOverlay('Analyzing your NEPQ technique…', 90);
        var transcript = data.transcript;
        hideDemoOverlay();
        demoActive = false;
        var fileInput = document.getElementById('rc-demo-file');
        if (fileInput) fileInput.value = '';
        awaitingScore = true;
        lastScenarioLabel = 'Demo analysis — ' + file.name;
        addMessage('🎙️ Demo uploaded — score & coach me on this call', true);
        showTyping(); isLoading = true; sendBtn.disabled = true;
        setStatus('thinking', 'Scoring your demo…', false);
        scoreListen(transcript);
      } else {
        hideDemoOverlay();
        demoActive = false;
        var errMsg = (data && data.error) ? data.error : 'Could not transcribe the recording. Please check the file format and try again.';
        addMessage('❌ ' + errMsg, false);
      }
    };
    xhr.onerror = function() {
      demoXhr = null;
      if (!demoActive) return;
      hideDemoOverlay();
      demoActive = false;
      addMessage('Connection error during upload. Please check your internet connection and try again.', false);
    };
    xhr.ontimeout = function() {
      demoXhr = null;
      hideDemoOverlay();
      demoActive = false;
      addMessage('The upload timed out. The recording may be too large — try a shorter clip or compress the file.', false);
    };
    xhr.timeout = 300000; // 5 minute timeout for large files
    xhr.send(formData);
  }

  if (roleplayBtn) {
    roleplayBtn.addEventListener('click', function() {
      if (roleplayActive) { endRoleplay(); return; }
      if (listenActive) { endListenMode(); return; }
      if (rpPanel && rpPanel.classList.contains('show')) closePicker();
      else openPicker();
    });
  }
  if (rpCancel) {
    rpCancel.addEventListener('click', function() {
      if (pendingMode) showModeStep();   // acting as ← Back
      else closePicker();
    });
  }
  if (welcomeRpBtn) {
    welcomeRpBtn.addEventListener('click', function() { openPicker(); });
  }
  var demoFileInput = document.getElementById('rc-demo-file');
  if (demoFileInput) {
    demoFileInput.addEventListener('change', function() {
      if (this.files && this.files[0]) handleDemoUpload(this.files[0]);
    });
  }
  var demoCancelBtn = document.getElementById('rc-demo-cancel');
  if (demoCancelBtn) {
    demoCancelBtn.addEventListener('click', cancelDemoAnalysis);
  }

  // ---------- SEND MESSAGE ----------
  // ---------- POINTS HELPERS ----------
  function updatePointsUI() {
    var numEl = document.getElementById('rc-pts-num');
    var fillEl = document.getElementById('rc-pts-fill');
    var badge = document.getElementById('rc-pts-badge');
    if (numEl) numEl.textContent = dailyPoints + '/' + POINTS_CAP + ' pts';
    if (fillEl) fillEl.style.width = (dailyPoints / POINTS_CAP * 100) + '%';
    if (badge) { if (dailyPoints >= POINTS_CAP) badge.classList.add('maxed'); else badge.classList.remove('maxed'); }
  }
  function parseScore(text) {
    // Look for "Overall: X/10" or "X/10" or "X out of 10" patterns
    var m = text.match(/overall[^0-9]*([0-9]+(?:\.[0-9]+)?)[\s]*(?:\/|out\s+of)\s*10/i);
    if (m) return parseFloat(m[1]);
    // Fallback: first N/10 pattern
    m = text.match(/([0-9]+(?:\.[0-9]+)?)[\s]*\/[\s]*10/);
    if (m) return parseFloat(m[1]);
    return null;
  }
  var lastScenarioLabel = '';  // set before awaitingScore, used for CRM postMessage
  function awardPoints(text) {
    if (!awaitingScore) return;
    awaitingScore = false;
    var score = parseScore(text);
    if (score === null || score < 0) return;
    score = Math.min(Math.round(score), 10);
    // --- Broadcast to CRM (RBS integration) ---
    var msg = {
      type: 'rbs-roleplay-complete',
      score: score,
      scenario: lastScenarioLabel || 'Role play',
      feedback: text.length > 2000 ? text.substring(0, 2000) : text
    };
    try {
      if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*');
      else window.postMessage(msg, '*');
    } catch(e) {}
    // --- Local daily points ---
    var before = dailyPoints;
    dailyPoints = Math.min(dailyPoints + score, POINTS_CAP);
    if (dailyPoints !== before) {
      savePoints(dailyPoints);
      updatePointsUI();
      if (dailyPoints >= POINTS_CAP && before < POINTS_CAP) {
        setTimeout(function() {
          addMessage('🏆 Daily goal reached! You hit ' + POINTS_CAP + '/' + POINTS_CAP + ' points today. Great work!', false);
        }, 800);
      }
    }
  }

  function onBotReply(text) {
    awardPoints(text);
    var speakIt = callMode || speakerOn || lastInputWasVoice;
    lastInputWasVoice = false;
    if (speakIt) {
      setStatus('speaking', 'Speaking…', callMode);
      speak(text, function() {
        if (callMode) {
          setTimeout(function() { if (callMode) startListening(); }, 250);
        } else {
          clearStatus();
        }
      });
    } else if (roleplayActive) {
      setStatus('', 'Roleplay in progress — tap End when done', true);
    } else {
      clearStatus();
    }
  }

  function sendMessage(overrideText, displayText) {
    var hasOverride = (typeof overrideText === 'string');
    // During live listening, anything the rep types stays in the box as part of the
    // call transcript — it is not sent to the coach until they tap End.
    if (listenActive && !hasOverride) return;
    var text = (hasOverride ? overrideText : inputEl.value).trim();
    if (!text || isLoading) return;

    addMessage(hasOverride ? (displayText || text) : text, true);
    if (!hasOverride) {
      inputEl.value = '';
      inputEl.style.height = 'auto';
    }
    isLoading = true;
    sendBtn.disabled = true;
    if (callMode || lastInputWasVoice) setStatus('thinking', 'Thinking…', callMode);
    showTyping();
    // FULL roleplay dialogue is handled by the dedicated coach-free endpoint so the
    // prospect never breaks character to coach. Only real rep turns are routed here;
    // the coached & listening modes still use the coach bot below.
    if (roleplayActive && roleplayMode === 'full' && !hasOverride) {
      roleplayTurn(text);
      return;
    }
    // Coached roleplay still uses the coach bot for the live dialogue (so it can
    // give mid-scene tips), but we record every rep turn so we can score the call
    // ourselves at the end via the reliable scorer instead of the coach bot.
    if (roleplayActive && roleplayMode === 'coached' && !hasOverride) {
      rpHistory.push({ role: 'user', content: text });
    }

    var body = {
      deploymentToken: DEPLOYMENT_TOKEN,
      deploymentId: DEPLOYMENT_ID,
      messages: JSON.stringify([{is_user: true, text: text}])
    };
    if (conversationId) body.deploymentConversationId = conversationId;

    fetch(API_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      hideTyping();
      isLoading = false;
      sendBtn.disabled = false;
      if (data.success !== false && data.result) {
        var msgs = data.result.messages || [];
        if (msgs.length > 0) {
          var botMsg = msgs[msgs.length - 1];
          if (!botMsg.is_user) {
            if (roleplayActive && roleplayMode === 'coached') {
              rpHistory.push({ role: 'assistant', content: botMsg.text });
            }
            addMessage(botMsg.text, false);
            onBotReply(botMsg.text);
          }
        }
        if (data.result.deploymentConversationId) {
          conversationId = data.result.deploymentConversationId;
        }
      } else {
        addMessage('Sorry, I encountered an error. Please try again.', false);
        if (callMode) endCall(); else clearStatus();
      }
    })
    .catch(function() {
      hideTyping();
      isLoading = false;
      sendBtn.disabled = false;
      addMessage('Connection error. Please try again.', false);
      if (callMode) endCall(); else clearStatus();
    });
  }

  sendBtn.addEventListener('click', function() { sendMessage(); });
  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
})();
