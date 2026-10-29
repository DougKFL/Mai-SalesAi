(function() {
  'use strict';

  // Replace with your deployment token and ID
  var DEPLOYMENT_TOKEN = '';
  var DEPLOYMENT_ID = '';
  var API_URL = 'https://api.abacus.ai/api/v0/getChatResponse';
  var PRIMARY_COLOR = '#28A745';
  var BOT_NAME = 'The TRAIN Method';
  var BOT_SUBTITLE = 'Sales Training Platform';

  // The 5 phases of the TRAIN Method
  var PHASES = [
    { key: 'trust',      label: 'Trust',      desc: 'opens low-pressure and earns the right to ask questions' },
    { key: 'reveal',     label: 'Reveal',     desc: 'uncovers what is really going on and what is not working' },
    { key: 'amplify',    label: 'Amplify',    desc: 'helps the buyer feel the cost of leaving it unsolved' },
    { key: 'illustrate', label: 'Illustrate', desc: 'shows the solution using the buyer\'s own words' },
    { key: 'nextStep',   label: 'Next Step',  desc: 'gets a clear, buyer-owned decision' }
  ];
  var TRAIN_FRAMEWORK = 'THE TRAIN METHOD — a 5-phase sales conversation framework: ' +
    PHASES.map(function(p, i) { return (i + 1) + ') ' + p.label + ' — ' + p.desc; }).join('; ') +
    '. Question types: Trust questions, Reveal questions, Amplify questions, Illustrate questions and Next-Step questions.';
  // Sent with every scoring request so the coach returns per-phase scores the widget can parse.
  var SCORING_PROMPT = TRAIN_FRAMEWORK + ' Score the sales rep on EACH of the 5 TRAIN phases separately from 1 to 10, ' +
    'then give an Overall score equal to the average of the 5 (rounded to the nearest whole number). ' +
    'Begin your reply with the scores in EXACTLY this format, one per line:\n' +
    'Trust: X/10\nReveal: X/10\nAmplify: X/10\nIllustrate: X/10\nNext Step: X/10\nOverall: X/10\n' +
    'Then give brief, specific coaching for each phase, and name the single phase the rep should focus on next.';

  // Derive the CDN origin from this script's own src so feedback + TTS post to the right place
  var CDN_ORIGIN = window.location.origin;
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
  if (window.__trainWidgetLoaded) return;
  window.__trainWidgetLoaded = true;

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
  var POINTS_KEY = 'train_daily_pts';
  var SCORES_KEY = 'train_scores';
  var REP_KEY = 'train_rep_name';
  var MGR_KEY = 'train_manager_mode';
  var REP_POINTS_KEY = 'train_rep_points';   // {repName: {date, pts}} so managers can see each rep's points
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
    var rep = getRepName();
    if (rep) {
      var all = readJSON(REP_POINTS_KEY, {});
      all[rep] = {date: todayStr(), pts: pts};
      writeJSON(REP_POINTS_KEY, all);
    }
  }
  function readJSON(key, fallback) {
    try { var raw = localStorage.getItem(key); if (raw) return JSON.parse(raw); } catch(e) {}
    return fallback;
  }
  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {}
  }
  function getRepName() {
    try { return (localStorage.getItem(REP_KEY) || '').trim(); } catch(e) { return ''; }
  }
  function setRepName(name) {
    try { localStorage.setItem(REP_KEY, name); } catch(e) {}
  }
  function isManagerMode() {
    try { return localStorage.getItem(MGR_KEY) === 'true'; } catch(e) { return false; }
  }
  function setManagerMode(on) {
    try { localStorage.setItem(MGR_KEY, on ? 'true' : 'false'); } catch(e) {}
  }
  function loadScores() {
    var s = readJSON(SCORES_KEY, []);
    return Array.isArray(s) ? s : [];
  }
  var dailyPoints = loadPoints();
  var pendingMode = null;       // mode chosen ('full' | 'coached'), awaiting persona pick
  var speakerByRoleplay = false;
  // --- Live listening state ---
  var listenActive = false;     // listening to a real sales call
  var listenTranscript = '';    // accumulated transcript
  var listenRec = null;         // dedicated continuous recognizer
  // --- Demo analysis (uploaded recording) state ---
  var demoActive = false;
  var demoXhr = null;

  // Generic buyer personas for one-tap roleplay practice (no industry/product specifics).
  var PERSONAS = {
    skeptic: {
      name: 'The Skeptic', emoji: '🤨',
      blurb: 'Doesn\'t believe the solution is worth it; thinks what they have now is fine.',
      desc: 'a prospect who doubts that what the rep is offering is worth the time, money or effort, is suspicious there is a catch, and believes the way they do things now already works fine. You push back on claims and ask "why would I change?"'
    },
    busy: {
      name: 'The Too-Busy Buyer', emoji: '⏱️',
      blurb: 'Always slammed; says they don\'t have time to talk or make a change right now.',
      desc: 'a prospect who is always slammed, tries to cut the conversation short, says they have no time to talk or to make any change right now, and keeps asking the rep to "just send something over" or "call back later".'
    },
    analyzer: {
      name: 'The Over-Analyzer', emoji: '🔍',
      blurb: 'Wants every detail; overthinks decisions and stalls before committing.',
      desc: 'a prospect who wants every detail, asks lots of specific questions, overthinks every decision, worries about making the wrong choice, and stalls with "I need to think about it" or "let me do more research" before committing to anything.'
    },
    price: {
      name: 'The Price Shopper', emoji: '💸',
      blurb: 'Compares everything on cost alone; wants the cheapest option.',
      desc: 'a prospect who compares everything on cost alone, keeps asking "how much?" early, mentions that cheaper alternatives exist, and assumes all options are basically the same so the lowest price should win.'
    },
    holdout: {
      name: 'The Happy Holdout', emoji: '😊',
      blurb: 'Satisfied with the status quo; doesn\'t think they have a problem worth solving.',
      desc: 'a friendly prospect who is comfortable with the status quo, politely insists everything is "fine", does not see any problem worth solving, and will only open up about real frustrations if the rep asks genuinely curious questions.'
    }
  };

  // Practice modes shown on the first step of the picker
  var MODES = {
    full: {
      emoji: '🎧', name: 'Full Roleplay',
      blurb: 'No interruptions. I stay the buyer the whole call while you sell — I score each TRAIN phase at the end.'
    },
    coached: {
      emoji: '🎓', name: 'Coached Roleplay',
      blurb: 'I play the buyer but pause to give a quick tip whenever you slip, then continue the call.'
    },
    listen: {
      emoji: '👂', name: 'Live Call Listening',
      blurb: 'Practice on a real prospect. I listen quietly to your call, then score & coach you at the end.'
    },
    demo: {
      emoji: '🎙️', name: 'Demo Analysis',
      blurb: 'Upload a recorded sales demo (MP3, WAV, M4A). I\'ll score you on each TRAIN phase.'
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
    '.rc-demo-cancel-btn:hover{background:#f2f2f2}',
    // --- Manager / Owner view ---
    '.train-manager-panel{position:absolute;top:58px;left:0;right:0;bottom:0;background:#f8faf8;z-index:8;display:none;flex-direction:column;padding:16px;overflow-y:auto}',
    '.train-manager-panel.show{display:flex}',
    '.train-mgr-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}',
    '.train-mgr-title{font-size:16px;font-weight:800;color:#1a1a1a}',
    '.train-mgr-close{background:none;border:1px solid #ddd;border-radius:8px;font-size:16px;line-height:1;padding:4px 9px;cursor:pointer;color:#555}',
    '.train-mgr-close:hover{background:#eee}',
    '.train-mgr-select{width:100%;padding:8px 10px;border:1px solid #ccc;border-radius:8px;font-size:13px;margin-bottom:12px;background:#fff;font-family:inherit}',
    '.train-mgr-section{background:#fff;border:1px solid #e2e8e2;border-radius:12px;padding:12px 14px;margin-bottom:10px}',
    '.train-mgr-label{font-size:11px;font-weight:700;color:#777;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px}',
    '.train-mgr-big{font-size:28px;font-weight:800;color:' + PRIMARY_COLOR + ';line-height:1.1}',
    '.train-mgr-big small{font-size:13px;color:#888;font-weight:600}',
    '.train-mgr-stats{display:flex;gap:10px}',
    '.train-mgr-stats .train-mgr-section{flex:1;margin-bottom:10px}',
    '.train-phase-row{display:flex;align-items:center;gap:8px;margin:6px 0;font-size:12px}',
    '.train-phase-name{width:72px;flex-shrink:0;font-weight:600;color:#333}',
    '.train-phase-track{flex:1;height:10px;background:#eee;border-radius:5px;overflow:hidden}',
    '.train-phase-bar{height:100%;background:' + PRIMARY_COLOR + ';border-radius:5px;transition:width .4s ease}',
    '.train-phase-bar.lowest{background:#e23b3b}',
    '.train-phase-val{width:30px;text-align:right;font-weight:700;color:#333}',
    '.train-phase-focus{font-size:10px;font-weight:700;color:#e23b3b;margin-left:80px;margin-top:-3px}',
    '.train-sparkline{display:block;width:100%;height:110px}',
    '.train-mgr-table{width:100%;border-collapse:collapse;font-size:11px}',
    '.train-mgr-table th{text-align:left;color:#888;font-weight:700;padding:4px 3px;border-bottom:1px solid #eee}',
    '.train-mgr-table td{padding:5px 3px;border-bottom:1px solid #f3f3f3;color:#333;vertical-align:top}',
    '.train-mgr-empty{text-align:center;color:#888;font-size:13px;padding:30px 10px}',
    '.train-mgr-lock{margin-top:4px;background:' + PRIMARY_COLOR + ';color:#fff;border:none;border-radius:10px;padding:9px;font-size:13px;font-weight:700;cursor:pointer}',
    '.train-mgr-lock.locked{background:#555}',
    '.train-mgr-btn{font-size:16px;line-height:1;padding:5px}',
    // --- First-time rep name prompt ---
    '.train-rep-prompt{position:absolute;top:58px;left:0;right:0;bottom:0;background:rgba(255,255,255,0.97);z-index:9;display:none;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center}',
    '.train-rep-prompt.show{display:flex}',
    '.train-rep-prompt h4{margin:0 0 6px;font-size:17px;color:#1a1a1a}',
    '.train-rep-prompt p{margin:0 0 14px;font-size:12px;color:#666;line-height:1.5}',
    '.train-rep-prompt input{width:100%;max-width:260px;padding:10px 12px;border:1px solid #ccc;border-radius:10px;font-size:14px;outline:none;font-family:inherit}',
    '.train-rep-prompt input:focus{border-color:' + PRIMARY_COLOR + '}',
    '.train-rep-prompt button{margin-top:10px;background:' + PRIMARY_COLOR + ';color:#fff;border:none;border-radius:10px;padding:9px 22px;font-size:13px;font-weight:700;cursor:pointer}',
    '.train-rep-skip{background:none !important;color:#888 !important;font-weight:500 !important;font-size:12px !important;margin-top:6px !important}'
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
  var rpHeadBtn = '<button class="rc-icon-btn train-mgr-btn" id="train-mgr-open" aria-label="Manager view" title="Manager / Owner view">📊</button>' +
    '<button class="rc-icon-btn" id="rc-roleplay" aria-label="Start roleplay" title="Practice roleplay">' + ICON_ROLEPLAY + '</button>';
  var headActions = rpHeadBtn + (voiceSupported
    ? ('<button class="rc-icon-btn" id="rc-call" aria-label="Start practice call" title="Hands-free practice call">' + ICON_CALL + '</button>' +
       '<button class="rc-icon-btn" id="rc-speaker" aria-label="Toggle voice replies" title="Toggle voice replies">' + ICON_SPEAKER_OFF + '</button>')
    : '');
  container.innerHTML = [
    '<div class="rc-widget-header">',
    '  <div><div class="rc-widget-header-title">🚂 ' + BOT_NAME + '</div>',
    '  <div class="rc-widget-header-sub">' + BOT_SUBTITLE + '<span class="rc-pts-badge" id="rc-pts-badge" title="Daily practice points"><span id="rc-pts-num">' + dailyPoints + '/' + POINTS_CAP + ' pts</span><span class="rc-pts-track"><span class="rc-pts-fill" id="rc-pts-fill" style="width:' + (dailyPoints/POINTS_CAP*100) + '%"></span></span></span></div></div>',
    '  <div class="rc-widget-head-actions">',
    '    ' + headActions,
    '    <button class="rc-icon-btn rc-widget-close" aria-label="Close chat">&times;</button>',
    '  </div>',
    '</div>',
    '<div class="rc-widget-messages" id="rc-messages">',
    '  <div class="rc-widget-welcome">',
    '    <h3>👋 Welcome!</h3>',
    '    <p>I\'m your <strong>TRAIN Method</strong> Sales Coach. I\'ll help you master the 5 phases of a great sales conversation.</p>',
    '    <p style="font-size:12px;margin-top:6px;color:#555"><strong>T</strong>rust • <strong>R</strong>eveal • <strong>A</strong>mplify • <strong>I</strong>llustrate • <strong>N</strong>ext Step</p>',
    (voiceSupported
      ? '    <p style="font-size:12px;margin-top:8px;color:#888">Tap 🎤 to talk, or 📞 for a hands-free practice call.</p>'
      : '    <p style="font-size:12px;margin-top:8px;color:#888">Try: "give me 3 Reveal questions" or "objection: no time"</p>'),
    '    <button class="rc-welcome-rp" id="rc-welcome-rp">🎯 Start a Practice Roleplay</button>',
    '  </div>',
    '</div>',
    '<div class="rc-rp-panel" id="rc-rp-panel">',
    '  <div class="rc-rp-title" id="rc-rp-title">🎯 Practice Roleplay</div>',
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
    '<div class="train-manager-panel" id="train-mgr-panel">',
    '  <div class="train-mgr-head"><div class="train-mgr-title">📊 Manager View</div>',
    '  <button class="train-mgr-close" id="train-mgr-close" aria-label="Close manager view">&times;</button></div>',
    '  <div id="train-mgr-body"></div>',
    '  <button class="train-mgr-lock" id="train-mgr-lock">🔒 Lock to Manager View</button>',
    '</div>',
    '<div class="train-rep-prompt" id="train-rep-prompt">',
    '  <h4>👋 What\'s your name?</h4>',
    '  <p>Your name is used to track your practice scores so your manager can see your progress.</p>',
    '  <input type="text" id="train-rep-input" maxlength="40" placeholder="Your name">',
    '  <button type="button" id="train-rep-save">Save</button>',
    '  <button type="button" class="train-rep-skip" id="train-rep-skip">Skip for now</button>',
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
      if (isManagerMode()) openManager();
      else if (!getRepName() && !repPromptSkipped) showRepPrompt();
      else inputEl.focus();
    } else {
      closePicker();
      closeManager();
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
    if (rpTitle) rpTitle.innerHTML = '🎯 Practice Roleplay';
    if (rpSub) rpSub.innerHTML = 'Choose how you want to practice.';
    if (rpCancel) rpCancel.textContent = 'Cancel';
    buildModeList();
  }
  function showPersonaStep(mode) {
    pendingMode = mode;
    var m = MODES[mode];
    if (rpTitle) rpTitle.innerHTML = m.emoji + ' ' + m.name;
    if (rpSub) rpSub.innerHTML = 'Pick a buyer type to practice with. Tap <strong>End</strong> anytime to finish and get scored.';
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
      kickoff = 'COACHED ROLEPLAY MODE. ' + TRAIN_FRAMEWORK + ' You are now ' + p.name + ' — ' + p.desc +
        ' I am a sales rep practicing on you. Keep the scenario generic — do not invent a specific company, product or industry unless I bring one up, and then just go along with what I describe. Play this prospect realistically, one natural spoken turn at a time, raising objections and not giving in easily. This is a COACHED drill: after each of my responses, silently judge my technique against the TRAIN Method phases. If I made a mistake or missed a clear opportunity, BRIEFLY step out of character for ONE short coaching note (1–2 sentences, begin it with "Coach:" and name the TRAIN phase it relates to) telling me exactly what to do better, then immediately step back into character with your next line as ' + p.name + '. If I handled it well, stay fully in character and simply continue with your next objection or reaction — no coaching note. Do NOT give an overall score until I say "end roleplay". IMPORTANT: Do NOT speak first. Wait silently for my opening sales line, then respond in character as ' + p.name + '.';
      shown = '🎓 Starting Coached Roleplay with ' + p.name;
    } else {
      kickoff = 'ROLEPLAY MODE. You are now ' + p.name + ' — ' + p.desc +
        ' I am a sales rep calling you. Keep the scenario generic — do not invent a specific company, product or industry unless I bring one up. Stay 100% in character as this prospect for the ENTIRE conversation. Respond ONLY as ' + p.name +
        ', one natural spoken turn at a time. This is a FULL, uninterrupted roleplay: under NO circumstances do you coach me, break character, analyze, hint, summarize, or give ANY feedback or score mid-conversation until I explicitly say "end roleplay". Be realistic: raise objections naturally, do not give in easily, and make me earn it. If I genuinely earn it by building trust, revealing your real problem, helping you feel its cost and illustrating a fit in your own words, you MAY realistically agree to a clear next step — do not fold too early, but do not block a well-earned close either. IMPORTANT: Do NOT speak first. Wait silently for my opening sales line, then respond in character as ' + p.name + '.';
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
        framework: 'TRAIN',
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
        framework: 'TRAIN',
        scoringInstructions: SCORING_PROMPT,
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
        framework: 'TRAIN',
        scoringInstructions: SCORING_PROMPT,
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
    lastScenarioLabel = (roleplayPersona ? roleplayPersona.name + ' — ' : '') + (wasCoached ? 'Coached Roleplay' : 'Full Roleplay');
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
    lastScenarioLabel = 'Live Call Listening';
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
        showDemoOverlay('Analyzing your TRAIN Method phases…', 90);
        var transcript = data.transcript;
        hideDemoOverlay();
        demoActive = false;
        var fileInput = document.getElementById('rc-demo-file');
        if (fileInput) fileInput.value = '';
        awaitingScore = true;
        lastScenarioLabel = 'Demo Analysis — ' + file.name;
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
    if (!text) return null;
    // Preferred: "Overall: X/10"
    var m = text.match(/overall[^0-9\n]*([0-9]+(?:\.[0-9]+)?)\s*(?:\/|out\s+of)\s*10/i);
    if (m) return parseFloat(m[1]);
    // Fallback: average of the phase scores if all 5 are present
    var ph = parsePhaseScores(text);
    if (ph) {
      var sum = 0;
      PHASES.forEach(function(p) { sum += ph[p.key]; });
      return sum / PHASES.length;
    }
    return null;
  }
  // Extracts the 5 TRAIN phase scores. Returns {trust, reveal, amplify, illustrate, nextStep} or null if any are missing.
  function parsePhaseScores(text) {
    if (!text) return null;
    var clean = text.replace(/\*\*/g, '');
    var out = {}, found = 0;
    PHASES.forEach(function(p) {
      var label = p.label.replace(' ', '[\\s-]*');
      var re = new RegExp('(?:^|[^a-z])' + label + '[^0-9\\n]{0,20}?([0-9]+(?:\\.[0-9]+)?)\\s*(?:\\/|out\\s+of)\\s*10', 'i');
      var m = clean.match(re);
      if (m) { out[p.key] = Math.max(0, Math.min(10, parseFloat(m[1]))); found++; }
    });
    return found === PHASES.length ? out : null;
  }
  function saveSession(overall, phases, scenario) {
    var entry = {
      date: todayStr(),
      scenario: scenario || 'Roleplay',
      overall: overall,
      trust: phases ? phases.trust : null,
      reveal: phases ? phases.reveal : null,
      amplify: phases ? phases.amplify : null,
      illustrate: phases ? phases.illustrate : null,
      nextStep: phases ? phases.nextStep : null,
      rep: getRepName() || 'Unnamed rep',
      ts: Date.now()
    };
    var all = loadScores();
    all.push(entry);
    if (all.length > 500) all = all.slice(all.length - 500);
    writeJSON(SCORES_KEY, all);
  }
  var lastScenarioLabel = '';  // set before awaitingScore, stored with the session
  function awardPoints(text) {
    if (!awaitingScore) return;
    awaitingScore = false;
    var score = parseScore(text);
    if (score === null || score < 0) return;
    score = Math.min(Math.round(score), 10);
    saveSession(score, parsePhaseScores(text), lastScenarioLabel);
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
    if (mgrPanel && mgrPanel.classList.contains('show')) renderManager();
  }

  // ---------- REP NAME PROMPT ----------
  var repPrompt = document.getElementById('train-rep-prompt');
  var repInput = document.getElementById('train-rep-input');
  var repPromptSkipped = false;
  function showRepPrompt() {
    if (!repPrompt) return;
    if (repInput) repInput.value = getRepName();
    repPrompt.classList.add('show');
    setTimeout(function() { repInput && repInput.focus(); }, 50);
  }
  function hideRepPrompt() { if (repPrompt) repPrompt.classList.remove('show'); }
  function saveRepFromPrompt() {
    var name = (repInput && repInput.value || '').trim();
    if (!name) { repInput && repInput.focus(); return; }
    setRepName(name);
    // Seed today's points for this rep so the manager view shows them right away
    savePoints(dailyPoints);
    hideRepPrompt();
    inputEl.focus();
  }
  var repSaveBtn = document.getElementById('train-rep-save');
  if (repSaveBtn) repSaveBtn.addEventListener('click', saveRepFromPrompt);
  if (repInput) repInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); saveRepFromPrompt(); } });
  var repSkipBtn = document.getElementById('train-rep-skip');
  if (repSkipBtn) repSkipBtn.addEventListener('click', function() { repPromptSkipped = true; hideRepPrompt(); inputEl.focus(); });

  // ---------- MANAGER / OWNER VIEW ----------
  var mgrPanel = document.getElementById('train-mgr-panel');
  var mgrBody = document.getElementById('train-mgr-body');
  var mgrLockBtn = document.getElementById('train-mgr-lock');
  var mgrSelectedRep = null;
  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function daysAgo(n) { var d = new Date(); d.setDate(d.getDate() - n); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
  function fmtNum(n) { return (Math.round(n * 10) / 10).toString(); }
  function shortDate(d) { var p = String(d || '').split('-'); return p.length === 3 ? (parseInt(p[1], 10) + '/' + parseInt(p[2], 10)) : esc(d); }
  function weakestPhase(s) {
    var low = null;
    PHASES.forEach(function(p) {
      var v = s[p.key];
      if (typeof v === 'number' && (low === null || v < low.v)) low = { label: p.label, v: v };
    });
    return low;
  }
  function listReps() {
    var names = {};
    loadScores().forEach(function(s) { names[s.rep || 'Unnamed rep'] = true; });
    Object.keys(readJSON(REP_POINTS_KEY, {})).forEach(function(n) { names[n] = true; });
    var me = getRepName(); if (me) names[me] = true;
    return Object.keys(names).sort();
  }
  function repTodayPoints(rep) {
    var all = readJSON(REP_POINTS_KEY, {});
    var r = all[rep];
    if (r && r.date === todayStr()) return r.pts;
    if (rep === getRepName() || (!getRepName() && rep === 'Unnamed rep')) return dailyPoints;
    return 0;
  }
  function sparklineSVG(sessions) {
    var last = sessions.slice(-10);
    if (!last.length) return '<div style="font-size:12px;color:#999">No scored sessions yet.</div>';
    var W = 320, H = 110, padB = 18, padT = 14, n = last.length;
    var slot = W / n, bw = Math.min(26, slot * 0.6);
    var svg = '<svg class="train-sparkline" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Overall score trend">';
    svg += '<line x1="0" y1="' + (H - padB) + '" x2="' + W + '" y2="' + (H - padB) + '" stroke="#ddd" stroke-width="1"/>';
    last.forEach(function(s, i) {
      var v = Math.max(0, Math.min(10, s.overall || 0));
      var h = (H - padB - padT) * v / 10;
      var x = i * slot + (slot - bw) / 2;
      var y = H - padB - h;
      var color = v >= 7 ? PRIMARY_COLOR : (v >= 5 ? '#e0a800' : '#e23b3b');
      svg += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(h, 1).toFixed(1) + '" rx="3" fill="' + color + '"><title>' + esc(s.date) + ' — ' + v + '/10</title></rect>';
      svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 3).toFixed(1) + '" font-size="9" text-anchor="middle" fill="#333" font-weight="700">' + v + '</text>';
      svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 5) + '" font-size="8" text-anchor="middle" fill="#888">' + shortDate(s.date) + '</text>';
    });
    return svg + '</svg>';
  }
  function renderManager() {
    if (!mgrBody) return;
    var reps = listReps();
    var allScores = loadScores();
    if (!reps.length || (!allScores.length && !Object.keys(readJSON(REP_POINTS_KEY, {})).length)) {
      mgrBody.innerHTML = '<div class="train-mgr-empty">No rep sessions recorded yet.</div>';
      updateLockBtn();
      return;
    }
    if (!mgrSelectedRep || reps.indexOf(mgrSelectedRep) === -1) {
      mgrSelectedRep = (reps.indexOf(getRepName()) !== -1) ? getRepName() : reps[0];
    }
    var rep = mgrSelectedRep;
    var sessions = allScores.filter(function(s) { return (s.rep || 'Unnamed rep') === rep; });
    sessions.sort(function(a, b) { return (a.ts || 0) - (b.ts || 0) || String(a.date).localeCompare(String(b.date)); });
    var weekStart = daysAgo(6);
    var weekCount = sessions.filter(function(s) { return String(s.date) >= weekStart; }).length;

    var html = '<select class="train-mgr-select" id="train-mgr-rep" aria-label="Select rep">';
    reps.forEach(function(r) { html += '<option value="' + esc(r) + '"' + (r === rep ? ' selected' : '') + '>' + esc(r) + '</option>'; });
    html += '</select>';

    html += '<div class="train-mgr-stats">' +
      '<div class="train-mgr-section"><div class="train-mgr-label">Today\'s Points</div><div class="train-mgr-big">' + repTodayPoints(rep) + ' <small>/ ' + POINTS_CAP + ' pts</small></div></div>' +
      '<div class="train-mgr-section"><div class="train-mgr-label">Sessions This Week</div><div class="train-mgr-big">' + weekCount + '</div></div>' +
      '</div>';

    html += '<div class="train-mgr-section"><div class="train-mgr-label">Overall Score Trend (last 10)</div>' + sparklineSVG(sessions) + '</div>';

    // Phase breakdown (averages across all sessions with phase data)
    var avgs = [];
    PHASES.forEach(function(p) {
      var sum = 0, cnt = 0;
      sessions.forEach(function(s) { if (typeof s[p.key] === 'number') { sum += s[p.key]; cnt++; } });
      avgs.push({ label: p.label, avg: cnt ? sum / cnt : null });
    });
    var withData = avgs.filter(function(a) { return a.avg !== null; });
    var lowest = null;
    withData.forEach(function(a) { if (!lowest || a.avg < lowest.avg) lowest = a; });
    html += '<div class="train-mgr-section"><div class="train-mgr-label">TRAIN Phase Breakdown (avg)</div>';
    if (!withData.length) {
      html += '<div style="font-size:12px;color:#999">No phase scores recorded yet.</div>';
    } else {
      avgs.forEach(function(a) {
        var isLow = lowest && a === lowest;
        var pct = a.avg === null ? 0 : a.avg * 10;
        html += '<div class="train-phase-row"><span class="train-phase-name">' + a.label + '</span>' +
          '<span class="train-phase-track"><span class="train-phase-bar' + (isLow ? ' lowest' : '') + '" style="display:block;width:' + pct + '%"></span></span>' +
          '<span class="train-phase-val">' + (a.avg === null ? '–' : fmtNum(a.avg)) + '</span></div>';
        if (isLow) html += '<div class="train-phase-focus">⚠️ Focus area</div>';
      });
    }
    html += '</div>';

    // Recent sessions
    html += '<div class="train-mgr-section"><div class="train-mgr-label">Recent Sessions</div>';
    var recent = sessions.slice(-5).reverse();
    if (!recent.length) {
      html += '<div style="font-size:12px;color:#999">No scored sessions yet.</div>';
    } else {
      html += '<table class="train-mgr-table"><thead><tr><th>Date</th><th>Scenario</th><th>Overall</th><th>Weakest</th></tr></thead><tbody>';
      recent.forEach(function(s) {
        var w = weakestPhase(s);
        html += '<tr><td>' + shortDate(s.date) + '</td><td>' + esc(s.scenario) + '</td><td><strong>' + esc(s.overall) + '/10</strong></td><td>' + (w ? esc(w.label) + ' (' + fmtNum(w.v) + ')' : '–') + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    html += '</div>';

    mgrBody.innerHTML = html;
    var sel = document.getElementById('train-mgr-rep');
    if (sel) sel.addEventListener('change', function() { mgrSelectedRep = this.value; renderManager(); });
    updateLockBtn();
  }
  function updateLockBtn() {
    if (!mgrLockBtn) return;
    var locked = isManagerMode();
    mgrLockBtn.textContent = locked ? '🔓 Rep Mode' : '🔒 Lock to Manager View';
    mgrLockBtn.classList.toggle('locked', locked);
    mgrLockBtn.setAttribute('title', locked ? 'Manager view opens by default. Click to switch back to rep mode.' : 'Open the manager view by default whenever the widget opens.');
  }
  function openManager() {
    if (!mgrPanel) return;
    closePicker();
    hideRepPrompt();
    renderManager();
    mgrPanel.classList.add('show');
    mgrOpenBtn && mgrOpenBtn.classList.add('active');
  }
  function closeManager() {
    if (mgrPanel) mgrPanel.classList.remove('show');
    mgrOpenBtn && mgrOpenBtn.classList.remove('active');
  }
  var mgrOpenBtn = document.getElementById('train-mgr-open');
  if (mgrOpenBtn) mgrOpenBtn.addEventListener('click', function() {
    if (mgrPanel && mgrPanel.classList.contains('show')) closeManager(); else openManager();
  });
  var mgrCloseBtn = document.getElementById('train-mgr-close');
  if (mgrCloseBtn) mgrCloseBtn.addEventListener('click', closeManager);
  if (mgrLockBtn) mgrLockBtn.addEventListener('click', function() {
    var nowLocked = !isManagerMode();
    setManagerMode(nowLocked);
    updateLockBtn();
    if (!nowLocked) {
      closeManager();
      if (!getRepName() && !repPromptSkipped) showRepPrompt();
    }
  });

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
