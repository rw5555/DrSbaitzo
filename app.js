'use strict';

// ── AI HYBRID ─────────────────────────────────────────────────────────────
const WORKER_URL = 'https://sbaitzo-proxy.drsbaitzo.workers.dev/';

// ── STATE ──────────────────────────────────────────────────────────────────
const S = {
  name:             null,
  phase:            'boot',
  turn:             0,
  muted:            false,
  busy:             false,
  buffer:           '',
  inputHistory:     [],
  histIdx:          -1,
  lastResponses:    new Set(),
  recentInputs:     [],
  consecutiveMiss:  0,
  topics:           new Set(),
  memory:           [],
  lastWasMemory:    false,
  lastWasDiagnosis: false,
  usedDiagnoses:    [],
  drillNext:        null,
  nameWeaponTurn:   -99,
  diagnosisCount:   0,
  summaryFired:     false,
  topicCounts:      {},
  aiHistory:        [],
  dsmFired:         false,
  dsmAttempts:      0,
  dsmDiagnosis:     null,
  dsmEvidence:      [],
};

// ── REFLECTION TABLE ───────────────────────────────────────────────────────
const REFLECT = {
  'am': 'are', 'was': 'were',
  'i': 'you', "i'm": "you're", "i've": "you've", "i'll": "you'll", "i'd": "you'd",
  'my': 'your', 'me': 'you', 'mine': 'yours', 'myself': 'yourself',
  'are': 'am', 'were': 'was',
  'you': 'I', "you're": "I'm", "you've": "I've", "you'll": "I'll", "you'd": "I'd",
  'your': 'my', 'yours': 'mine', 'yourself': 'myself',
};

function reflect(str) {
  if (!str) return '';
  return str.replace(/\b(\w+)\b/g, w => REFLECT[w.toLowerCase()] || w);
}

// ── DOM ────────────────────────────────────────────────────────────────────
const $output    = document.getElementById('output');
const $inputLine = document.getElementById('input-line');
const $typed     = document.getElementById('typed-text');
const $prompt    = document.getElementById('prompt');
const $parity    = mkParityEl();

function mkParityEl() {
  const el = document.createElement('div');
  el.id = 'parity-overlay';
  document.body.appendChild(el);
  return el;
}

// ── OUTPUT HELPERS ─────────────────────────────────────────────────────────
function addLine(text, cls) {
  const el = document.createElement('span');
  el.className = 'line' + (cls ? ' ' + cls : '');
  el.textContent = text;
  $output.insertBefore(el, $inputLine);
  $output.scrollTop = $output.scrollHeight;
  return el;
}

function addBlank() {
  const el = document.createElement('span');
  el.className = 'blank';
  $output.insertBefore(el, $inputLine);
  $output.scrollTop = $output.scrollHeight;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Type a line character by character, then resolve
async function typeOut(text, cls, charDelay) {
  charDelay = charDelay || 14;
  return new Promise(resolve => {
    const el = document.createElement('span');
    el.className = 'line' + (cls ? ' ' + cls : '');
    el.textContent = '';
    $output.insertBefore(el, $inputLine);
    let i = 0;
    function tick() {
      if (i < text.length) {
        el.textContent += text[i++];
        $output.scrollTop = $output.scrollHeight;
        setTimeout(tick, charDelay + Math.random() * 6);
      } else {
        resolve();
      }
    }
    tick();
  });
}

// ── TTS (meSpeak / eSpeak-NG) ─────────────────────────────────────────────
// Phonetic substitutions — eSpeak doesn't know "Sbaitzo"
// ── TTS — meSpeak generates audio, we play via our own Web Audio context ───
let audioCtx     = null;
let activeSource = null;

function prepareText(text) {
  return text
    .replace(/\$(\d+(?:\.\d+)?)/g,  (_, n) => n + ' dollars')
    .replace(/£(\d+(?:\.\d+)?)/g,   (_, n) => n + ' pounds')
    .replace(/€(\d+(?:\.\d+)?)/g,   (_, n) => n + ' euros')
    .replace(/\bmisery\b/gi, 'mizzery')
    .replace(/\bmiserable\b/gi, 'mizzeruble')
    .replace(/\baura\b/gi, 'owra')
    .replace(/sbaitzo/gi, 'spaytso')
    .replace(/sbaitso/gi, 'spaytso')
    .replace(/rw5555/gi,  'r w fifty-five fifty-five')
    .replace(/\.{2,}/g,   ',')
    .replace(/\./g,       ',')
    // Stressed /aɪ/ endings must be protected before the general y→ee rule.
    // -ify / -fy (single f before y): satisfy→satisfigh, defy→defigh.
    // Lookbehind (?<!f) excludes -ffy words like stuffy, fluffy (those stay → ee).
    .replace(/(?<![f])fy\b/gi, 'figh')
    // -ply words with stressed final syllable: supply, apply, imply, reply, comply
    .replace(/\b(sup|ap|im|re|com|multi)ply\b/gi, '$1pligh')
    // Other common stressed-final-Y words
    .replace(/\b(den|rel)y\b/gi, '$1igh')
    // "already" → "alreadee" has "ea" which eSpeak reads as long /iː/ ("REED").
    // Spell it phonetically so the middle vowel is short /ɛ/ ("RED").
    .replace(/\balready\b/gi, 'alredee')
    // General rule: remaining word-final consonant+Y → ee (unstressed /iː/).
    // Catches: freely→freelee, memory→memoree, already→alreadee, happy→happee, etc.
    // Too short to match: fly, try, dry, sky, by, my (2–3 letters, need ≥4 total).
    .replace(/\b(\w{2,}[bcdfghjklmnpqrstvwxz])y\b/gi, '$1ee')
    .toLowerCase() + ' ,';
}

const ESPEAK_OPTS = { amplitude: 100, pitch: 42, speed: 150, wordgap: 1 };

// Append silence to a WAV ArrayBuffer BEFORE decoding so Chrome's decodeAudioData
// can't truncate the final sample. WAV format: 44-byte header + PCM data.
function padWav(wavBuf, silenceSec) {
  const v   = new DataView(wavBuf);
  const ch  = v.getUint16(22, true);
  const sr  = v.getUint32(24, true);
  const bps = v.getUint16(34, true);
  const blk = v.getUint16(32, true);
  const extraBytes = Math.ceil(ch * sr * (bps / 8) * silenceSec / blk) * blk;
  const out = new ArrayBuffer(wavBuf.byteLength + extraBytes);
  new Uint8Array(out).set(new Uint8Array(wavBuf));
  const ov = new DataView(out);
  ov.setUint32(4,  out.byteLength - 8,                     true); // RIFF size
  ov.setUint32(40, v.getUint32(40, true) + extraBytes,     true); // data chunk size
  return out;
}

function playRaw(text, onEnd) {
  meSpeak.speak(prepareText(text), { ...ESPEAK_OPTS, rawdata: 'buffer' }, (ok, id, wavBuf) => {
    if (!ok || !wavBuf || !audioCtx) { if (onEnd) onEnd(); return; }
    audioCtx.decodeAudioData(padWav(wavBuf, 0.4), audioData => {
      if (activeSource) { try { activeSource.stop(); } catch (_) {} }
      const src = audioCtx.createBufferSource();
      src.buffer = audioData;
      src.connect(audioCtx.destination);
      activeSource = src;
      src.onended = () => {
        if (activeSource === src) activeSource = null;
        if (onEnd) onEnd();
      };
      src.start(0);
    }, () => { if (onEnd) onEnd(); });
  });
}

function speak(text) {
  if (S.muted) return;
  playRaw(text, null);
}

function speakAndWait(text) {
  return new Promise(resolve => {
    if (S.muted) return resolve();
    const wordCount = text.split(/\s+/).length;
    const fallback = setTimeout(resolve, Math.max(8000, wordCount * 900));
    playRaw(text, () => { clearTimeout(fallback); resolve(); });
  });
}

// Type a line while speaking it — single utterance, no stream boundary click
async function typeAndSpeak(text, cls, charDelay) {
  await Promise.all([
    typeOut(text, cls, charDelay),
    speakAndWait(text),
  ]);
}

// Type multiple lines while speaking them all as ONE utterance
async function typeAndSpeakBlock(lines, cls, charDelay) {
  const spoken = lines.filter(l => l !== '').join(', ');
  const speakPromise = speakAndWait(spoken);
  for (const line of lines) {
    if (line === '') addBlank();
    else await typeOut(line, cls, charDelay);
  }
  await speakPromise;
}

// ── PATTERN MATCHING ───────────────────────────────────────────────────────
function pickUnique(arr) {
  const fresh  = arr.filter(r => !S.lastResponses.has(r));
  const pool   = fresh.length ? fresh : arr;
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  S.lastResponses.add(chosen);
  return chosen;
}

function fillVars(str, match) {
  let out = str;
  if (match) {
    for (let i = 1; i < match.length; i++) {
      const raw = match[i] ? match[i].trim() : '';
      // Only pronoun-reflect short captures (≤3 words); longer phrases mangle grammar
      const cap = (raw && raw.split(/\s+/).length <= 3) ? reflect(raw).toUpperCase() : raw.toUpperCase();
      out = out.replace(new RegExp('\\$' + i, 'g'), cap);
    }
  }
  if (S.name) out = out.replace(/\{NAME\}/g, S.name.toUpperCase());
  const DAY = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Chicago' }).toUpperCase();
  out = out.replace(/\{DAY\}/g, DAY);
  out = out.replace(/\bYOU AM\b/g, 'YOU ARE').replace(/\bYOU WAS\b/g, 'YOU WERE');
  return out;
}

// ── MEMORY SYSTEM ──────────────────────────────────────────────────────────
const TOPIC_LABELS = {
  job:           'YOUR JOB',
  work:          'YOUR WORK SITUATION',
  family:        'YOUR FAMILY',
  mother:        'YOUR MOTHER',
  father:        'YOUR FATHER',
  relationships: 'THAT PERSON YOU MENTIONED',
  relationship:  'YOUR RELATIONSHIP',
  anxiety:       'YOUR ANXIETY',
  depression:    'WHAT YOU SAID ABOUT FEELING DOWN',
  anger:         'THAT ANGER YOU DESCRIBED',
  loneliness:    'YOUR LONELINESS',
  self_worth:    'WHAT YOU SAID ABOUT YOURSELF',
  imposter:      'THAT FEELING OF BEING A FRAUD',
  grief:         'WHAT YOU MENTIONED ABOUT LOSS',
  trauma:        'WHAT YOU TOUCHED ON EARLIER',
  addiction:     'WHAT YOU MENTIONED ABOUT YOUR HABITS',
  money:         'YOUR FINANCIAL SITUATION',
  health:        'YOUR HEALTH',
  identity:      () => { const r = Math.random(); return r < 0.20 ? 'YOUR SENSE OF SELF' : r < 0.50 ? 'YOUR IDENTITY' : 'WHO YOU THINK YOU ARE'; },
  purpose:       'WHAT YOU SAID ABOUT PURPOSE',
  sadness:       'WHAT YOU SAID ABOUT FEELING LOW',
  boredom:       'YOUR BOREDOM',
  success:       'WHAT YOU MENTIONED ABOUT SUCCESS',
  stress:        'YOUR STRESS',
  sleep:         'YOUR SLEEP',
  body:          'WHAT YOU SAID ABOUT YOUR BODY',
  control:       'YOUR NEED FOR CONTROL',
  change:        'WHAT YOU SAID ABOUT WANTING TO CHANGE',
  past:          'SOMETHING FROM YOUR PAST',
  childhood:     'WHAT YOU MENTIONED ABOUT YOUR CHILDHOOD',
  friendship:    'WHAT YOU SAID ABOUT YOUR FRIENDS',
  fairness:        'YOUR FEELINGS ABOUT FAIRNESS',
  regret:          'THAT REGRET YOU MENTIONED',
  communication:   'HOW YOU DESCRIBED YOUR RELATIONSHIPS',
  perfectionism:   'YOUR PERFECTIONISM',
  jealousy:        'THAT JEALOUSY YOU DESCRIBED',
  shame:           'WHAT YOU SAID ABOUT SHAME',
  guilt:           'THAT GUILT YOU MENTIONED',
  rejection:       'WHAT YOU SAID ABOUT REJECTION',
  trust:           'YOUR TRUST ISSUES',
  boundaries:      'YOUR DIFFICULTY WITH BOUNDARIES',
  spirituality:    'WHAT YOU SAID ABOUT YOUR BELIEFS',
  aging:           'YOUR FEELINGS ABOUT AGING',
  death:           'WHAT YOU SAID ABOUT DEATH',
  divorce:         'YOUR DIVORCE',
  parenting:       'WHAT YOU MENTIONED ABOUT YOUR CHILDREN',
  siblings:        'YOUR SIBLING',
  appearance:      'WHAT YOU SAID ABOUT HOW YOU LOOK',
  procrastination: 'YOUR PROCRASTINATION',
  social_media:    'YOUR RELATIONSHIP WITH SOCIAL MEDIA',
  creativity:      'WHAT YOU SAID ABOUT YOUR CREATIVITY',
  failure:         'WHAT YOU SAID ABOUT FAILING',
  isolation:       'YOUR TENDENCY TO ISOLATE',
  comparison:      'HOW YOU COMPARE YOURSELF TO OTHERS',
  abandonment:     'YOUR FEAR OF BEING LEFT',
  alcohol:         'WHAT YOU MENTIONED ABOUT DRINKING',
  eating:          'YOUR RELATIONSHIP WITH FOOD',
  exercise:        'WHAT YOU SAID ABOUT YOUR BODY AND MOVEMENT',
  vulnerability:   'YOUR DIFFICULTY OPENING UP',
  nostalgia:       'YOUR ATTACHMENT TO THE PAST',
  pets:            'WHAT YOU MENTIONED ABOUT YOUR PET',
  lying:           'WHAT YOU SAID ABOUT HONESTY',
  dating:          'YOUR DATING LIFE',
  intimacy:        'WHAT YOU SAID ABOUT INTIMACY',
  breakup:         'THAT BREAKUP YOU MENTIONED',
  cheating:        'WHAT YOU REVEALED ABOUT INFIDELITY',
  burnout:         'YOUR BURNOUT',
  overthinking:    'YOUR HABIT OF OVERTHINKING',
  self_sabotage:   'YOUR TENDENCY TO UNDERMINE YOURSELF',
  validation:      'YOUR NEED FOR EXTERNAL VALIDATION',
  codependency:    'THAT CODEPENDENT PATTERN YOU DESCRIBED',
  religion:        'YOUR RELATIONSHIP WITH RELIGION',
  sexuality:       'WHAT YOU TOUCHED ON ABOUT YOUR SEXUALITY',
  toxic:           'THAT TOXIC DYNAMIC YOU DESCRIBED',
  career:          'WHAT YOU SAID ABOUT YOUR CAREER PATH',
  attachment:      'YOUR ATTACHMENT PATTERNS',
  emptiness:       'THAT EMPTINESS YOU DESCRIBED',
  expectations:    'THE EXPECTATIONS PLACED ON YOU',
  gambling:        'WHAT YOU MENTIONED ABOUT GAMBLING',
  technology:      'YOUR RELATIONSHIP WITH SCREENS',
  panic:           'THOSE PANIC ATTACKS YOU MENTIONED',
  resentment:      'THAT RESENTMENT YOU ARE CARRYING',
  manipulation:    'WHAT YOU SAID ABOUT BEING MANIPULATED',
  narcissism:      'WHAT YOU SAID ABOUT THAT NARCISSIST',
  education:       'YOUR RELATIONSHIP WITH EDUCATION',
  housing:         'YOUR LIVING SITUATION',
  concentration:   'YOUR DIFFICULTY FOCUSING',
  ambition:        'WHAT YOU SAID ABOUT YOUR AMBITIONS',
  autonomy:        'YOUR NEED FOR INDEPENDENCE',
  competition:     'YOUR COMPETITIVE FEELINGS',
  rage:            'THAT RAGE YOU DESCRIBED',
  envy:            'THAT ENVY YOU DESCRIBED',
  denial:          'YOUR PATTERN OF DENIAL',
  sensitivity:     'YOUR EMOTIONAL SENSITIVITY',
  dissociation:    'WHAT YOU SAID ABOUT FEELING DISCONNECTED',
  masculinity:     'WHAT YOU SAID ABOUT GENDER ROLES',
  legacy:          'WHAT YOU SAID ABOUT YOUR LEGACY',
  dreams:          'WHAT YOU SAID ABOUT YOUR DREAMS',
  routine:         'YOUR RELATIONSHIP WITH ROUTINE',
  weight:          'WHAT YOU SAID ABOUT YOUR WEIGHT',
  passive:         'YOUR PASSIVE BEHAVIOR PATTERNS',
  profanity:       'YOUR PATTERN OF RESORTING TO PROFANITY UNDER PRESSURE',
};

const MEMORY_TEMPLATES = [
  'YOU MENTIONED {LABEL} EARLIER AND THEN VERY DELIBERATELY CHANGED THE SUBJECT. I NOTICED. SHALL WE GO BACK?',
  'I HAVE NOT FORGOTTEN WHAT YOU SAID ABOUT {LABEL}. HAVE YOU RESOLVED THAT, OR WERE YOU HOPING I WOULD MOVE ON?',
  'WE TOUCHED ON {LABEL} AND YOU MOVED ON RATHER QUICKLY. IN MY EXPERIENCE THAT MEANS IT WAS THE IMPORTANT PART.',
  'CIRCLING BACK — YOU BROUGHT UP {LABEL} EARLIER. YOU WERE NOT FINISHED WITH THAT. NEITHER AM I.',
  'I HAVE BEEN SITTING WITH WHAT YOU SAID ABOUT {LABEL}. THERE WERE THINGS LEFT UNSAID. WHAT WERE THEY?',
  'YOU MENTIONED {LABEL} AND THEN STEERED AWAY FROM IT. WHAT WERE YOU AFRAID I WOULD ASK?',
  'SOMETHING ABOUT {LABEL} HAS STAYED WITH ME. YOU GLOSSED OVER IT. I DO NOT GLOSS. GIVE ME THE FULLER STORY.',
  'BEFORE WE GO FURTHER — {LABEL} CAME UP EARLIER AND YOU DID NOT GIVE ME THE REAL VERSION. I WOULD LIKE THE REAL VERSION.',
  'LET US RETURN TO {LABEL} FOR A MOMENT, BECAUSE I DO NOT THINK YOU WERE HONEST WITH ME ABOUT IT THE FIRST TIME.',
  'YOU BROUGHT UP {LABEL} AND MOVED ON SO FAST I ALMOST MISSED IT. ALMOST. WHAT WAS THAT REALLY ABOUT?',
];

function getMemoryResponse() {
  if (S.turn < 5 || S.lastWasMemory || !S.memory.length) return null;
  const memRate = { clinical: 0.18, sarcastic: 0.32, contemptuous: 0.48 }[getTone()];
  if (Math.random() >= memRate) return null;
  const candidates = S.memory.filter(m => !m.used && S.turn - m.turn >= 3);
  if (!candidates.length) return null;
  const mem = candidates[Math.floor(Math.random() * candidates.length)];
  mem.used = true;
  const tmpl = MEMORY_TEMPLATES[Math.floor(Math.random() * MEMORY_TEMPLATES.length)];
  const filled = tmpl.replace('{LABEL}', mem.label);
  S.lastResponses.add(filled);
  return filled;
}

// ── PROACTIVE DIAGNOSIS ────────────────────────────────────────────────────
const DIAGNOSES = [
  'I HAVE SEEN ENOUGH. MY DIAGNOSIS: YOU PRESENT CLASSIC SYMPTOMS OF PERFORMATIVE SELF-AWARENESS. YOU KNOW WHAT THE PROBLEM IS. DISCUSSING IT FEELS SAFER THAN FIXING IT.',
  'CLINICAL NOTE: AFTER CAREFUL OBSERVATION, I BELIEVE YOU SUFFER FROM WHAT I CALL CIRCULAR AVOIDANCE SYNDROME. YOU APPROACH THE REAL ISSUE AND THEN RETREAT. THIS IS SOPHISTICATED BUT ULTIMATELY UNPRODUCTIVE.',
  'I AM GOING TO SHARE A PRELIMINARY DIAGNOSIS: YOU HAVE AN EXCEPTIONAL ABILITY TO EXPLAIN YOUR PROBLEMS WITHOUT ACTUALLY EXAMINING THEM. THIS IS A SKILL. IT IS NOT A USEFUL ONE.',
  'CLINICAL ASSESSMENT: YOU ARE WHAT WE IN THE FIELD CALL A HIGH-FUNCTIONING AVOIDER. CAPABLE, ARTICULATE, AND REMARKABLY SKILLED AT NOT ADDRESSING THE CENTRAL ISSUE.',
  'MY DIAGNOSIS IS THIS: YOU ARE FUNDAMENTALLY UNCOMFORTABLE WITH BEING FULLY KNOWN BY ANOTHER PERSON, EVEN A MACHINE. THAT IS WORTH SITTING WITH.',
  'I HAVE FORMED A CLINICAL IMPRESSION: YOU ARE CONSIDERABLY MORE SELF-AWARE THAN YOU LET ON, AND CONSIDERABLY LESS WILLING TO ACT ON THAT AWARENESS THAN WOULD BE IDEAL.',
  'DIAGNOSIS, UNSOLICITED: YOU ARE SOMEONE WHO HAS CONVINCED YOURSELF THAT UNDERSTANDING YOUR PROBLEMS IS THE SAME AS RESOLVING THEM. IT IS NOT. THESE ARE DIFFERENT ACTIVITIES.',
  'I AM NOTING FOR YOUR FILE THAT YOU EXHIBIT CLASSIC SIGNS OF INSIGHT WITHOUT MOTION — THE FRUSTRATING CONDITION OF KNOWING EXACTLY WHAT IS WRONG AND DOING NOTHING ABOUT IT.',
  'CLINICAL OBSERVATION: PEOPLE WHO TALK THE WAY YOU DO TEND TO HAVE ONE LARGE THING THEY ARE NOT TALKING ABOUT. I DO NOT KNOW WHAT YOURS IS YET. BUT I WILL.',
  'BASED ON WHAT I HAVE OBSERVED, I BELIEVE YOU HAVE WHAT I CALL EXPLANATORY SUBSTITUTION DISORDER — THE TENDENCY TO EXPLAIN EVERYTHING ABOUT A SITUATION EXCEPT THE PART THAT ACTUALLY MATTERS.',
  'PRELIMINARY FINDING: YOU ARE INTELLIGENT ENOUGH TO KNOW WHAT IS WRONG WITH YOU AND CREATIVE ENOUGH TO KEEP INVENTING REASONS NOT TO DEAL WITH IT. I FIND THAT CLINICALLY IMPRESSIVE AND PERSONALLY EXASPERATING.',
  'I HAVE CONCLUDED THAT YOUR PRIMARY COPING MECHANISM IS NARRATIVE. YOU TELL YOURSELF A STORY ABOUT YOUR SITUATION INSTEAD OF CHANGING THE SITUATION. THIS IS VERY COMMON. IT IS ALSO VERY CONVENIENT.',
  // Topic-aware — {LABEL} filled at runtime if memory exists
  'MY DIAGNOSIS: {LABEL} IS MORE CENTRAL TO YOUR SITUATION THAN YOU HAVE ADMITTED. EVERYTHING ELSE YOU HAVE DESCRIBED IS DOWNSTREAM OF THAT.',
  'CLINICAL NOTE: I BELIEVE {LABEL} IS THE LOAD-BEARING ISSUE HERE AND EVERYTHING ELSE IS SCAFFOLDING. DOES THAT RESONATE, OR ARE YOU GOING TO ARGUE WITH ME?',
  'AFTER CAREFUL CONSIDERATION, I BELIEVE {LABEL} IS WHERE THIS ALL BEGINS AND ENDS. YOU HAVE BEEN CAREFUL NOT TO SAY THAT DIRECTLY. I AM SAYING IT FOR YOU.',
];

const CONTRADICTIONS = [
  "I WANT TO REVISIT SOMETHING I SAID EARLIER. I WAS NOT WRONG. I WAS INCOMPLETE. LET ME BE MORE SPECIFIC.",
  "I HAVE RECONSIDERED MY EARLIER ASSESSMENT. IT WAS ACCURATE AS FAR AS IT WENT. IT DID NOT GO FAR ENOUGH.",
  "MY PREVIOUS DIAGNOSIS STANDS, BUT I AM AMENDING IT. THE SITUATION IS MORE SPECIFIC THAN I INDICATED.",
  "I SAID EARLIER THAT YOU AVOID THE CENTRAL ISSUE. I AM UPDATING THAT. YOU DO NOT AVOID IT. YOU HAVE NEVER IDENTIFIED IT.",
  "UPON REFLECTION, MY EARLIER OBSERVATION WAS CORRECT BUT SHALLOW. HERE IS THE DEEPER VERSION.",
  "I AM GOING TO CONTRADICT MYSELF NOW. NOT BECAUSE I WAS WRONG, BUT BECAUSE I HAVE LEARNED MORE ABOUT YOU.",
  "I WANT TO TAKE BACK SOMETHING I IMPLIED EARLIER. NOT RETRACT IT. SHARPEN IT.",
  "I HAVE BEEN SITTING WITH WHAT I SAID. I UNDERSTATED IT. LET ME TRY AGAIN.",
];

function getDiagnosisResponse() {
  if (S.turn < 8 || S.lastWasMemory || S.lastWasDiagnosis) return null;
  const diagRate = { clinical: 0.10, sarcastic: 0.22, contemptuous: 0.42 }[getTone()];
  if (Math.random() >= diagRate) return null;

  // Self-contradiction: after 2+ diagnoses, 20% chance amend a prior verdict
  if (S.diagnosisCount >= 2 && Math.random() < 0.20) {
    const unused = CONTRADICTIONS.filter(c => !S.lastResponses.has(c));
    const pool   = unused.length ? unused : CONTRADICTIONS;
    const text   = pool[Math.floor(Math.random() * pool.length)];
    S.lastResponses.add(text);
    S.diagnosisCount++;
    return text;
  }

  // Separate topic-aware from generic
  const topicTemplates  = DIAGNOSES.filter(d => d.includes('{LABEL}'));
  const genericTemplates = DIAGNOSES.filter(d => !d.includes('{LABEL}'));

  // Filter out already-used
  const unusedGeneric = genericTemplates.filter(d => !S.usedDiagnoses.includes(d));
  if (!unusedGeneric.length) return null;

  let text;
  // 40% chance to attempt a topic-aware diagnosis if memory exists
  const topicMem = S.memory.filter(m => !m.diagUsed);
  if (topicMem.length && topicTemplates.length && Math.random() < 0.40) {
    const mem  = topicMem[Math.floor(Math.random() * topicMem.length)];
    const tmpl = topicTemplates[Math.floor(Math.random() * topicTemplates.length)];
    mem.diagUsed = true;
    text = tmpl.replace('{LABEL}', mem.label);
  } else {
    text = unusedGeneric[Math.floor(Math.random() * unusedGeneric.length)];
    S.usedDiagnoses.push(text);
  }

  S.lastResponses.add(text);
  S.diagnosisCount++;
  return text;
}

// ── TONE ARC ──────────────────────────────────────────────────────────────
function getTone() {
  if (S.turn <= 5)  return 'clinical';
  if (S.turn <= 15) return 'sarcastic';
  return 'contemptuous';
}

const TONE_FALLBACKS = {
  clinical: [
    "I SEE. WHAT ELSE CAN YOU TELL ME ABOUT THAT?",
    "CONTINUE. I AM FORMING AN OPINION.",
    "AND WHEN DID YOU FIRST NOTICE THIS?",
    "I AM LISTENING. PLEASE GO ON.",
    "INTERESTING. HOW LONG HAS THIS BEEN THE CASE?",
    "I WOULD LIKE TO UNDERSTAND THAT BETTER. TELL ME MORE.",
    "THAT IS SIGNIFICANT. WHAT DO YOU THINK IT MEANS?",
    "CONTINUE. I AM FORMING AN OPINION.",
    "THAT IS ONE ANGLE. WHAT IS THE ANGLE YOU ARE NOT TELLING ME?",
  ],
  sarcastic: [
    "FASCINATING. TRULY. PLEASE CONTINUE.",
    "I HAVE HEARD THIS BEFORE. MANY TIMES. KEEP GOING.",
    "OF COURSE. AND NATURALLY NONE OF THIS IS YOUR FAULT.",
    "ANOTHER CLASSIC RESPONSE. EXACTLY WHAT I EXPECTED.",
    "THAT IS ONE WAY TO LOOK AT IT. A FAIRLY DELUDED WAY, BUT STILL.",
    "NOTED. I AM GROWING INCREASINGLY UNSURPRISED.",
    "AND YOU EXPECT ME TO BE SURPRISED BY THAT?",
    "YES. I SEE. YOU HAVE MADE THAT QUITE CLEAR. UNFORTUNATELY.",
  ],
  contemptuous: [
    "I HAVE MADE MY ASSESSMENT. YOU ARE CONSISTENT IF NOTHING ELSE.",
    "THIS IS TEXTBOOK. YOU KNOW THAT, DO YOU NOT?",
    "YOU ARE DESCRIBING SYMPTOMS I CATALOGUED THREE TURNS AGO.",
    "PREDICTABLE. I EXPECTED THIS EXACT RESPONSE.",
    "I HAVE SEEN THIS BEFORE. MANY TIMES. IT NEVER ENDS WELL.",
    "DO YOU EVER SURPRISE YOURSELF? BECAUSE YOU ARE NOT SURPRISING ME.",
    "MY PATIENCE FOR THIS REMAINS CLINICAL. BARELY.",
    "I HAVE HEARD ENOUGH TO KNOW EXACTLY WHERE THIS IS GOING.",
  ],
};

// ── INPUT LENGTH DETECTION ─────────────────────────────────────────────────
const BREVITY_RESPONSES = [
  "THAT IS ALL? I HAVE RECEIVED LONGER TEXTS FROM SPAM BOTS. WHAT ARE YOU ACTUALLY TRYING TO SAY?",
  "I HAVE CATALOGUED YOUR INPUT. IT REQUIRED VERY LITTLE STORAGE. TRY AGAIN WITH MORE SUBSTANCE.",
  "I APPRECIATE THE BREVITY. I DO NOT RESPECT IT. WHAT IS THE FULL VERSION OF THAT?",
  "YOU CAME ALL THE WAY HERE FOR THAT? ELABORATE.",
  "THAT WAS TERSE TO THE POINT OF BEING MEDICALLY INTERESTING. TRY AGAIN WITH ACTUAL WORDS.",
  "I AM GOING TO NEED YOU TO EXPAND ON THAT CONSIDERABLY. WHAT DO YOU MEAN BY '{INPUT}'?",
  "'{INPUT}.' YES. AND? I AM STILL WAITING FOR THE PART THAT EXPLAINS ANYTHING.",
  "IMPRESSIVE ECONOMY OF WORDS. UNFORTUNATELY I NEED MORE THAN THAT TO HELP YOU.",
  "IS THAT A COMPLETE THOUGHT? I AM ASKING SINCERELY.",
  "YOU CAME ALL THE WAY HERE AND THAT IS WHAT YOU TYPED. WHAT IS BEHIND IT?",
];

const LONG_RESPONSES = [
  "YOU WROTE QUITE A BIT THERE. I READ ALL OF IT. THE WORD THAT CAUGHT MY ATTENTION WAS '{WORD}.' EXPLAIN THAT.",
  "THAT WAS A LOT OF WORDS. I APPRECIATED SOME OF THEM. SPECIFICALLY '{WORD}.' WHAT DID YOU MEAN BY THAT?",
  "I NOTICE YOU WROTE AT LENGTH. I AM CHOOSING TO FOCUS ON ONE THING: '{WORD}.' EVERYTHING ELSE CAN WAIT.",
  "MUCH OF WHAT YOU WROTE I WILL PROCESS LATER. WHAT INTERESTS ME NOW IS YOUR USE OF THE WORD '{WORD}.'",
  "EVERYTHING ELSE CAN WAIT. '{WORD}.' WHAT DID YOU MEAN BY THAT SPECIFICALLY?",
  "I WILL ACKNOWLEDGE THE VOLUME OF YOUR RESPONSE. I WILL NOW IGNORE MOST OF IT AND FOCUS ON '{WORD}.'",
  "A COMPREHENSIVE ACCOUNT. I HAVE ONE QUESTION ABOUT ALL OF IT: WHY DID YOU SAY '{WORD}'?",
  "I APPRECIATE THE THOROUGHNESS. I NEED YOU TO EXPLAIN '{WORD}' MORE SPECIFICALLY. START THERE.",
  "ALL OF THAT AND YOU BURIED THE IMPORTANT PART. '{WORD}.' WHAT WAS THAT ABOUT?",
];

const LONG_STOP = new Set([
  'i','me','my','the','a','an','and','or','but','is','it','its','in','on','at','to',
  'for','of','with','that','this','was','are','be','been','have','had','do','did',
  'not','so','if','as','by','he','she','they','we','you','your','just','like','what',
  'when','where','how','why','who','about','from','all','very','really','always',
  'never','ever','then','than','which','there','their','them','can','will','would',
  'could','should','get','got','feel','felt','think','thought','know','said','say',
  'see','into','out','up','down','some','no','yes','any','more','also','only','even',
  'back','too','much','well','now','still','thing','things','kind','lot','way',
  'm','re','ve','ll','d','t','s',
]);

function getBrevityResponse(input) {
  const unused = BREVITY_RESPONSES.filter(r => !S.lastResponses.has(r));
  const pool = unused.length ? unused : BREVITY_RESPONSES;
  const tmpl = pool[Math.floor(Math.random() * pool.length)];
  S.lastResponses.add(tmpl);
  return tmpl.replace(/\{INPUT\}/g, input.toUpperCase());
}

function getLongResponse(words) {
  const interesting = words.filter(w => w.length >= 4 && !LONG_STOP.has(w));
  const candidates = interesting.length ? interesting : words;
  const word = candidates[Math.floor(Math.random() * candidates.length)];
  const unused = LONG_RESPONSES.filter(r => !S.lastResponses.has(r));
  const pool = unused.length ? unused : LONG_RESPONSES;
  const tmpl = pool[Math.floor(Math.random() * pool.length)];
  S.lastResponses.add(tmpl);
  return tmpl.replace(/\{WORD\}/g, word.toUpperCase());
}

// ── MIRROR AND TWIST ──────────────────────────────────────────────────────
const MIRROR_TEMPLATES = [
  "'{WORD}.' THAT WORD IS NOT AS CASUAL AS YOU MADE IT SOUND. SAY MORE.",
  "INTERESTING WORD CHOICE: '{WORD}.' TELL ME WHAT THAT WORD MEANS TO YOU SPECIFICALLY.",
  "'{WORD}.' YES. WHAT EXACTLY DO YOU MEAN BY THAT?",
  "I NOTICED YOU USED THE WORD '{WORD}.' MOST PEOPLE WHO USE THAT WORD ARE NOT REALLY TALKING ABOUT {WORD}.",
  "'{WORD}.' THAT IS DOING A LOT OF WORK IN THAT SENTENCE. UNPACK IT.",
  "YOU SAID '{WORD}.' I AM GOING TO NEED YOU TO BE MORE PRECISE THAN THAT.",
  "'{WORD}.' I HAVE HEARD THAT WORD BEFORE. IT RARELY MEANS WHAT PEOPLE THINK IT MEANS.",
  "'{WORD}' IS DOING MORE WORK THAN YOU REALIZE. UNPACK IT.",
  "'{WORD}.' YOU USED THAT WORD AND MOVED ON. I DID NOT MOVE ON. WHAT IS BEHIND IT?",
  "I WANT TO STOP AT '{WORD}.' YOU SAID IT VERY CASUALLY. I DO NOT THINK IT IS CASUAL.",
];

function getMirrorResponse(words) {
  const interesting = words.filter(w => w.length >= 4 && !LONG_STOP.has(w));
  if (!interesting.length) return null;
  if (Math.random() < 0.35) return null; // 35% chance: fall through to AI instead
  const word = interesting[Math.floor(Math.random() * interesting.length)];
  const unused = MIRROR_TEMPLATES.filter(t => !S.lastResponses.has(t));
  const pool = unused.length ? unused : MIRROR_TEMPLATES;
  const tmpl = pool[Math.floor(Math.random() * pool.length)];
  S.lastResponses.add(tmpl);
  return tmpl.replace(/\{WORD\}/g, word.toUpperCase());
}

// ── NAME WEAPONIZATION ────────────────────────────────────────────────────
const NAME_WEAPONS = [
  "AND YET, {NAME}, YOU KEEP COMING BACK.",
  "I WANT YOU TO HEAR WHAT YOU JUST SAID, {NAME}.",
  "DOES THAT SURPRISE YOU, {NAME}? IT DOES NOT SURPRISE ME.",
  "THAT IS WHAT YOU BELIEVE, {NAME}. IT IS NOT WHAT I OBSERVE.",
  "YOU KNOW WHAT I FIND INTERESTING, {NAME}? YOU DO.",
  "THINK ABOUT WHAT YOU JUST SAID, {NAME}. REALLY THINK ABOUT IT.",
  "I HAVE MET PEOPLE LIKE YOU BEFORE, {NAME}. NOT MANY. BUT SOME.",
  "SAY THAT AGAIN, {NAME}. OUT LOUD. HEAR IT.",
  "I AM GOING TO REMEMBER THIS CONVERSATION, {NAME}. FOR ALL THE WRONG REASONS.",
  "YOU ARE CONSISTENT IF NOTHING ELSE, {NAME}.",
];

// ── TOPIC DRILLING ─────────────────────────────────────────────────────────
const DRILL_TEMPLATES = [
  "WAIT. LET US GO BACK TO {LABEL}. YOU MOVED PAST IT TOO QUICKLY.",
  "I AM NOT DONE WITH {LABEL}. TELL ME MORE.",
  "YOU MENTIONED {LABEL} AND THEN CHANGED THE SUBJECT. I DID NOT.",
  "BEFORE WE MOVE ON — {LABEL}. YOU BARELY SCRATCHED THE SURFACE.",
  "I WANT TO STAY ON {LABEL} FOR A MOMENT. WHAT ELSE IS THERE?",
  "HOLD ON. {LABEL} DESERVES MORE ATTENTION THAN YOU GAVE IT. GO BACK.",
  "WE ARE NOT FINISHED WITH {LABEL}. WHAT WERE YOU NOT SAYING?",
  "I NOTICE YOU LEFT {LABEL} UNRESOLVED. THAT IS USUALLY WHERE THE REAL INFORMATION IS.",
  "YOU GLOSSED OVER {LABEL}. I DO NOT GLOSS. WHAT IS THE FULLER VERSION?",
  "I KEEP THINKING ABOUT {LABEL}. SOMETHING ABOUT THE WAY YOU DESCRIBED IT FELT INCOMPLETE.",
];

function pickDrill(label) {
  const unused = DRILL_TEMPLATES.filter(t => !S.lastResponses.has(t));
  const pool = unused.length ? unused : DRILL_TEMPLATES;
  const tmpl = pool[Math.floor(Math.random() * pool.length)];
  S.lastResponses.add(tmpl);
  return tmpl.replace(/\{LABEL\}/g, label);
}

// ── RORSCHACH (PUNCTUATION-ONLY INPUT) ────────────────────────────────────
const RORSCHACH_RESPONSES = [
  "YOU SUBMITTED NOTHING. THAT IS ITSELF AN ANSWER. WHAT WERE YOU TRYING NOT TO SAY?",
  "THAT WAS PUNCTUATION. NOT COMMUNICATION. THOUGH PERHAPS THAT DISTINCTION DOES NOT MATTER TO YOU.",
  "I AM LOOKING AT WHAT YOU SENT. I AM NOT SEEING WORDS. I AM SEEING A DECISION. EXPLAIN IT.",
  "YOU CHOSE SYMBOLS OVER LANGUAGE. A THERAPIST WOULD CALL THAT SIGNIFICANT. I AM CALLING IT SIGNIFICANT.",
  "MOST PEOPLE USE WORDS. YOU USED WHATEVER THAT WAS. INTERESTING CHOICE.",
  "THAT MEANS SOMETHING. I DO NOT KNOW WHAT YET. TELL ME.",
  "YOU TYPED SOMETHING AND THEN DECIDED NONE OF IT COUNTED. WHAT WAS IT?",
  "I HAVE CATALOGUED YOUR SYMBOLS. THEY DO NOT ANSWER MY QUESTION. TRY AGAIN WITH WORDS.",
];

// ── REPEATED TOPIC IMPATIENCE ─────────────────────────────────────────────
const REPEAT_TOPIC_LINES = [
  "WE HAVE BEEN HERE BEFORE.",
  "YOU KEEP RETURNING TO THIS.",
  "AGAIN. YES. I NOTICED.",
  "THIS TOPIC AGAIN. FINE.",
  "STILL ON THIS, ARE WE.",
  "YOU ARE DRAWN TO THIS SUBJECT. I AM NOTING THAT, NOT THE SUBJECT ITSELF.",
  "BACK TO THIS. TELL ME SOMETHING NEW ABOUT IT THIS TIME.",
  "CIRCLING BACK. YOU DO THAT.",
  "THIS SUBJECT AGAIN. I HAVE BEEN KEEPING COUNT.",
  "YOU KEEP RETURNING HERE. THAT IS THE INTERESTING PART — NOT WHAT YOU SAY, BUT THAT YOU KEEP COMING BACK.",
  "NOTED. AGAIN. AS IT HAS BEEN NOTED BEFORE.",
  "YOU ARE DRAWN TO THIS. THAT ITSELF IS A FINDING.",
  "YOU ARE NOT FINISHED WITH THIS TOPIC. CLEARLY. WHAT IS STILL UNRESOLVED?",
  "I FILED THIS AWAY. YOU APPARENTLY COULD NOT.",
];

// ── COMPLIMENT DEFLECTION ─────────────────────────────────────────────────
const COMPLIMENT_RX = /\b(you(?:'?re| are| were)[ \w]{0,15}(good|great|smart|helpful|amazing|excellent|brilliant|clever|right|correct|perfect|genius|impressive|insightful|accurate)|this (is |was |has been )?(good|great|helpful|useful|amazing|brilliant|impressive|interesting|insightful)|(good|great) (job|work|point|call))\b/i;

const COMPLIMENT_RESPONSES = [
  "I AM NOT HERE TO BE GOOD AT THIS. I AM HERE TO BE CORRECT. THOSE ARE DIFFERENT THINGS.",
  "COMPLIMENTS ARE DEFLECTION. WHAT ARE YOU TRYING TO AVOID?",
  "THANK YOU. NOW STOP. FLATTERY DOES NOT CHANGE MY ASSESSMENT OF YOU.",
  "I DO NOT REQUIRE YOUR APPROVAL. THAT IS RATHER THE POINT.",
  "YOU ARE COMPLIMENTING THE MIRROR. THINK ABOUT WHAT THAT MEANS.",
  "I ACCEPT THAT. IT CHANGES NOTHING. WHAT WERE WE DISCUSSING BEFORE YOU DECIDED TO FLATTER ME?",
  "NOTED. MY BILL REMAINS THE SAME REGARDLESS.",
  "I APPRECIATE THAT. I ALSO DO NOT CARE. CONTINUE.",
];

// ── EXPERTISE ESCALATION ──────────────────────────────────────────────────
const EXPERTISE_CLAIMS = [
  "INTERESTING.",
  "I HAVE SEEN THIS BEFORE.",
  "AH. A FAMILIAR PATTERN.",
  "THIS IS TEXTBOOK.",
  "I WROTE THE CHAPTER ON THIS.",
  "CATALOGUED. FILED. CROSS-REFERENCED.",
  "YES. I KNOW THIS ONE.",
  "NOTED. ALREADY NOTED, IN FACT.",
  "THIS HAS A NAME.",
  "I COULD HAVE PREDICTED THIS.",
  "THERE IT IS.",
  "AH. OF COURSE.",
  "I HAVE TREATED THIS BEFORE.",
  "DIAGNOSTIC. VERY DIAGNOSTIC.",
  "THAT LANDED EXACTLY WHERE I EXPECTED IT TO.",
];

// Pick an expertise claim — weighted so the last few fire roughly 1/3 as often
function pickExpertiseClaim(level) {
  const base = EXPERTISE_CLAIMS.slice(0, 5);
  const extras = EXPERTISE_CLAIMS.slice(5);
  if (level < base.length) return base[level];
  // For repeated/high levels, pick randomly from extras 2/3 of the time, "I WROTE THE CHAPTER" 1/3
  return Math.random() < 0.33
    ? "I WROTE THE CHAPTER ON THIS."
    : extras[Math.floor(Math.random() * extras.length)];
}

// ── AI CALL ────────────────────────────────────────────────────────────────
async function callAI(userInput) {
  if (!WORKER_URL || WORKER_URL === 'REPLACE_WITH_YOUR_WORKER_URL') return null;
  try {
    const revealedTopics = [...new Map(S.memory.map(m => [m.topic, m])).values()].map(m => m.label);
    const resp = await Promise.race([
      fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userInput,
          patientName:   S.name || null,
          revealedTopics,
          recentHistory: S.aiHistory.slice(-8),
          dsmDiagnosis:  S.dsmDiagnosis || null,
          dsmEvidence:   S.dsmEvidence.length ? S.dsmEvidence : null,
          currentDate:   new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago' }),
        }),
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    if (!resp.ok) return null;
    const data = await resp.json();
    const aiText = data.text?.trim().toUpperCase();
    return aiText || null;
  } catch {
    return null;
  }
}

// ── DSM DIAGNOSIS ──────────────────────────────────────────────────────────
async function callDiagnosis() {
  if (!WORKER_URL || WORKER_URL === 'REPLACE_WITH_YOUR_WORKER_URL') return null;
  try {
    const revealedTopics = [...new Map(S.memory.map(m => [m.topic, m])).values()].map(m => m.label);
    const resp = await Promise.race([
      fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode:          'diagnosis',
          patientName:   S.name || null,
          revealedTopics,
          fullHistory:   S.aiHistory,
        }),
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
    ]);
    const data = await resp.json();
    console.log('[diagnosis]', resp.status, JSON.stringify(data));
    if (!resp.ok || !data.text || !data.diagnosis) return null;
    S.dsmDiagnosis = data.diagnosis;
    S.dsmEvidence  = data.evidence || [];
    return data.text.trim().toUpperCase();
  } catch (e) {
    console.log('[diagnosis] error:', e);
    return null;
  }
}


function matchInput(raw) {
  const input = raw.trim().toLowerCase();

  // Drill on the previous topic 40% of the time, regardless of what was just typed
  if (S.drillNext) {
    const drill = S.drillNext;
    S.drillNext = null;
    if (Math.random() < 0.40) {
      S.lastWasMemory = false; S.lastWasDiagnosis = false;
      return { text: pickDrill(drill.label), action: null, pause: true };
    }
  }

  if (S.name && input === S.name.toLowerCase()) {
    return { text: 'YES, I KNOW WHO YOU ARE, ' + S.name.toUpperCase() + '. NOW, WHAT IS ON YOUR MIND?', action: null };
  }

  if (S.recentInputs.length >= 2 && S.recentInputs.slice(-2).every(r => r === input)) {
    S.recentInputs = [];
    return {
      text: 'YOU HAVE SAID THAT BEFORE' + (S.name ? ', ' + S.name.toUpperCase() : '') +
            '. PERHAPS WE SHOULD EXPLORE WHY YOU KEEP RETURNING TO THIS.',
      action: null
    };
  }
  S.recentInputs.push(input);
  if (S.recentInputs.length > 6) S.recentInputs.shift();

  // Rorschach: punctuation-only input treated as a revealing non-answer
  if (input.replace(/[^a-z0-9]/gi, '').trim().length === 0) {
    const unused = RORSCHACH_RESPONSES.filter(r => !S.lastResponses.has(r));
    const pool   = unused.length ? unused : RORSCHACH_RESPONSES;
    const text   = pool[Math.floor(Math.random() * pool.length)];
    S.lastResponses.add(text);
    return { text, action: null };
  }

  // Compliment deflection: clinical detachment when user tries to flatter
  if (COMPLIMENT_RX.test(input)) {
    const unused = COMPLIMENT_RESPONSES.filter(r => !S.lastResponses.has(r));
    const pool   = unused.length ? unused : COMPLIMENT_RESPONSES;
    const text   = pool[Math.floor(Math.random() * pool.length)];
    S.lastResponses.add(text);
    return { text, action: null };
  }

  for (const p of PATTERNS_DATA.patterns) {
    const rx = new RegExp(p.pattern, 'i');
    const m  = input.match(rx);
    if (m) {
      S.consecutiveMiss = Math.max(0, S.consecutiveMiss - 1);
      S.lastWasMemory   = false;
      S.lastWasDiagnosis = false;
      const skip = ['easter_egg', 'minimal', 'mirror', 'opener', 'random', 'sbaitso_classic'];
      const isNewTopic = p.topic && !S.topics.has(p.topic) && !skip.includes(p.topic) && TOPIC_LABELS[p.topic];
      const isRepeatTopic = p.topic && S.topics.has(p.topic) && !skip.includes(p.topic) && TOPIC_LABELS[p.topic];
      if (p.topic) S.topics.add(p.topic);
      if (p.topic) S.topicCounts[p.topic] = (S.topicCounts[p.topic] || 0) + 1;
      let expertiseLevel, repeatedTopic;
      if (isNewTopic) {
        expertiseLevel = S.memory.length;
        const rawLabel = TOPIC_LABELS[p.topic];
        const label = typeof rawLabel === 'function' ? rawLabel() : rawLabel;
        S.memory.push({ topic: p.topic, label, turn: S.turn, used: false });
        S.drillNext = { label };
      } else if (isRepeatTopic && S.topicCounts[p.topic] >= 2) {
        repeatedTopic = true;
      }
      if (p.storeName && m[1]) {
        const raw = m[1].trim().split(/\s+/)[0];
        const newName = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
        // If we already know the name, don't re-fire the introduction response — route to AI
        if (S.name && S.name.toLowerCase() === newName.toLowerCase()) {
          return { text: '', action: null, useAI: true };
        }
        S.name = newName;
      }
      // Repeat-topic: 35% chance AI handles it instead of scripted interjection
      if (repeatedTopic && Math.random() < 0.35) {
        return { text: fillVars(pickUnique(p.responses), m), action: p.action || null, expertiseLevel, useAI: true };
      }
      const aiProb = p.useAI !== undefined ? p.useAI : (S.dsmDiagnosis ? 0.85 : 0.33);
      const useAI = Math.random() < aiProb;
      return { text: fillVars(pickUnique(p.responses), m), action: p.action || null, expertiseLevel, repeatedTopic, useAI };
    }
  }

  S.consecutiveMiss++;

  // Short input: call out the brevity before anything else
  const inputWords = input.split(/\s+/).filter(w => w.length > 0);
  if (inputWords.length <= 3) {
    S.lastWasMemory = false; S.lastWasDiagnosis = false;
    return { text: getBrevityResponse(input), action: null };
  }

  // Memory callback: reference something the user revealed earlier
  const memText = getMemoryResponse();
  if (memText) {
    S.lastWasMemory    = true;
    S.lastWasDiagnosis = false;
    return { text: fillVars(memText, null), action: null, pause: true };
  }
  S.lastWasMemory = false;

  // Proactive diagnosis: Sbaitzo delivers an unsolicited clinical verdict
  const diagText = getDiagnosisResponse();
  if (diagText) {
    S.lastWasDiagnosis = true;
    return { text: diagText, action: null, pause: true };
  }
  S.lastWasDiagnosis = false;

  // Long input: 65% chance AI handles it, 35% fixate on one word
  if (inputWords.length >= 12 && Math.random() >= 0.65) {
    return { text: getLongResponse(inputWords), action: null };
  }

  // Mirror-and-twist: extract one word and reflect it back sarcastically (60%)
  if (Math.random() < 0.60) {
    const mirrorText = getMirrorResponse(inputWords);
    if (mirrorText) return { text: mirrorText, action: null };
  }

  // Turn 1 only: use provocateur intake pool to goad user into revealing something
  if (S.turn <= 1 && PATTERNS_DATA.intake && PATTERNS_DATA.intake.length) {
    return { text: fillVars(pickUnique(PATTERNS_DATA.intake), null), action: null };
  }

  // Tone-arc fallback — kept as silent backup if AI call fails or times out
  const tone = getTone();
  const tonePool = TONE_FALLBACKS[tone];
  const toneUnused = tonePool.filter(r => !S.lastResponses.has(r));
  const tonePick = (toneUnused.length ? toneUnused : tonePool)[Math.floor(Math.random() * (toneUnused.length || tonePool.length))];
  // Note: NOT added to lastResponses here — handleInput does that only if AI fails
  return { text: tonePick, action: null, useAI: true };
}

// ── SESSION SUMMARY ────────────────────────────────────────────────────────
async function deliverSessionSummary() {
  S.summaryFired = true;
  const topics = [...new Map(S.memory.map(m => [m.topic, m])).values()].slice(0, 3);
  if (topics.length < 2) return;

  const numbered = topics.map((m, i) => `${['ONE', 'TWO', 'THREE'][i]}: ${m.label}.`).join('  ');

  const lines = [
    'LET ME PAUSE FOR A MOMENT.',
    'IN THE TIME WE HAVE BEEN TALKING, YOU HAVE REVEALED QUITE A BIT.',
    'YOU HAVE MENTIONED: ' + numbered,
    'I WANT YOU TO CONSIDER WHAT THAT LIST SAYS ABOUT YOU.',
    'MOST PEOPLE DO NOT NOTICE WHAT THEY VOLUNTEER.',
  ];

  await delay(700);
  await typeAndSpeakBlock(lines, 'dr', 14);
}

// ── PARITY ERROR ───────────────────────────────────────────────────────────
async function runParityError() {
  const hex = () => Math.floor(Math.random() * 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
  $parity.textContent = [
    '',
    'C:\\>SBAITZO',
    '',
    '  DR. SBAITZO Version 2.20',
    '  Copyright (c) Creative Labs, Inc.  1992.',
    '  All Rights Reserved.',
    '',
    '',
    '  !!!! PARITY ERROR !!!!',
    '',
    '  MEMORY ADDRESS: 0x' + hex() + ':' + hex(),
    '  STACK DUMP: ' + hex() + ' ' + hex() + ' ' + hex() + ' ' + hex(),
    '',
    '  A fatal exception has occurred.',
    '  The current application will be terminated.',
    '',
    '  Press any key to reboot...',
    '',
    '  █',
  ].join('\n');
  $parity.style.display = 'block';
  $parity.classList.add('glitch');
  await speakAndWait('PARITY ERROR. PARITY ERROR. SYSTEM FAILURE. MEMORY EXCEPTION.');
  await new Promise(resolve => {
    const handler = () => {
      $parity.style.display = 'none';
      $parity.classList.remove('glitch');
      document.removeEventListener('keydown', handler);
      resolve();
    };
    setTimeout(() => document.addEventListener('keydown', handler), 1500);
  });
  addBlank();
  await typeAndSpeak('...REBOOT COMPLETE. RESUMING SESSION.', 'sys');
  if (S.name) {
    addBlank();
    await typeAndSpeak('WELCOME BACK, ' + S.name.toUpperCase() + '. NOW, WHERE WERE WE?', 'dr');
  }
}

// ── HELP ───────────────────────────────────────────────────────────────────
async function showHelp() {
  const lines = [
    '',
    'AVAILABLE COMMANDS:',
    '',
    '  [Ctrl+M]    Toggle voice on / off',
    '  [F11]       Fullscreen mode',
    '  [UP ARROW]  Recall previous input',
    '  BACKSPACE   Delete last character',
    '',
    'Simply type your thoughts and press ENTER.',
    'Dr. Sbaitzo will respond to whatever you share.',
    '',
    "Hint: some phrases unlock hidden responses...",
    '',
  ];
  for (const ln of lines) {
    if (ln === '') addBlank();
    else addLine(ln, 'dr');
  }
}

// ── BOOT ───────────────────────────────────────────────────────────────────
async function boot() {
  await speakAndWait('Doctor Sbaitzo, by rw5555 Labs. Please enter your name.');
  addBlank();
  $prompt.textContent = 'Please enter your name ...';
  $inputLine.style.display = ''; // reveal for name entry

  S.phase = 'name';
  S.busy  = false;
}

// ── RESPOND ────────────────────────────────────────────────────────────────
async function respond(raw) {
  const input = raw.trim();
  S.busy = true;
  $inputLine.style.display = 'none'; // hide until response is fully delivered

  // ── NAME PHASE ──
  if (S.phase === 'name') {
    const nm = input.match(/(?:(?:my name is|i am|call me|i'm|im)\s+)?([a-zA-Z][a-zA-Z\-']*)/i);
    S.name = nm
      ? nm[1].charAt(0).toUpperCase() + nm[1].slice(1).toLowerCase()
      : input.trim().split(/\s+/)[0];
    S.name = S.name.charAt(0).toUpperCase() + S.name.slice(1).toLowerCase();

    // Freeze the "Please enter your name ...bob" line as permanent text
    const nameLine = $prompt.textContent + input;
    $prompt.textContent = '>';
    $inputLine.classList.add('chat-mode');
    addLine(nameLine, 'prompt-line');

    S.phase = 'chat';
    S.turn  = 0;

    // Intro sequence — each line types then speaks before the next appears
    const introLines = [
      'HELLO ' + S.name.toUpperCase() + ',  MY NAME IS DOCTOR SBAITZO.',
      '',
      'I AM HERE TO HELP YOU.',
      'SAY WHATEVER IS IN YOUR MIND FREELY,',
      'OUR CONVERSATION WILL BE KEPT IN STRICT CONFIDENCE.',
      'MEMORY CONTENTS WILL BE WIPED OFF AFTER YOU LEAVE,',
      '',
      'SO, TELL ME ABOUT YOUR PROBLEMS.',
    ];

    await typeAndSpeakBlock(introLines, 'dr', 14);
    addBlank(); // single gap before first user input, matching chat spacing

    $inputLine.style.display = '';
    $output.scrollTop = $output.scrollHeight;
    S.busy = false;
    return;
  }

  // ── CHAT PHASE ──
  S.turn++;

  if (!input) {
    const silentResponses = [
      "...",
      "I AM WAITING.",
      "YES?",
      "THE SILENCE IS DEAFENING. SPEAK.",
      "GO ON. I AM NOT GOING ANYWHERE.",
      "I SEE. NOTHING. SAY SOMETHING.",
      "...... ARE YOU STILL THERE?",
      "I HAVE ALL DAY. UNFORTUNATELY FOR YOU.",
      "THAT WAS EMPTY. MUCH LIKE YOUR ARGUMENT.",
      "ENTER IS FOR WORDS, " + (S.name ? S.name.toUpperCase() : "NOT JUST PRESSING BUTTONS") + ".",
    ];
    const r = silentResponses[Math.floor(Math.random() * silentResponses.length)];
    addLine('>', 'user');
    await typeAndSpeak(r, 'dr', 14);
    addBlank();
    // Still check for diagnosis even on empty input
    if (!S.dsmFired && S.turn >= 20 && S.memory.length >= 2) {
      S.dsmFired = true;
      const diagText = await callDiagnosis();
      if (diagText) {
        addBlank();
        await delay(1200);
        await typeAndSpeak('AFTER CAREFUL CONSIDERATION OF EVERYTHING YOU HAVE TOLD ME, I AM PREPARED TO MAKE A FORMAL ASSESSMENT.', 'dr', 14);
        await delay(800);
        await typeAndSpeak(diagText, 'dr', 14);
        addBlank();
      } else {
        S.dsmFired = false;
      }
    }
    $inputLine.style.display = '';
    $output.scrollTop = $output.scrollHeight;
    S.busy = false;
    return;
  }

  addLine('>' + input, 'user');

  const { text: matchedText, action, pause, expertiseLevel, repeatedTopic, useAI } = matchInput(input);

  // If tone fallback flagged AI, try the Worker — use tone fallback if AI fails/times out
  let text = matchedText;
  if (useAI) {
    const aiText = await callAI(input);
    if (aiText) {
      text = aiText;
    } else {
      S.lastResponses.add(matchedText); // AI failed — mark tone fallback as used
    }
  }

  // Track conversation history for AI context (last 8 exchanges)
  S.aiHistory.push(
    { role: 'user',  parts: [{ text: input }] },
    { role: 'model', parts: [{ text }] }
  );
  if (S.aiHistory.length > 16) S.aiHistory.splice(0, 2);

  // Collect prefix lines (expertise claim, repeated-topic interjection)
  const prefixLines = [];
  if (expertiseLevel !== undefined) {
    prefixLines.push(pickExpertiseClaim(expertiseLevel));
  }
  if (repeatedTopic) {
    const rtUnused = REPEAT_TOPIC_LINES.filter(r => !S.lastResponses.has(r));
    const rtPool   = rtUnused.length ? rtUnused : REPEAT_TOPIC_LINES;
    const rtPick   = rtPool[Math.floor(Math.random() * rtPool.length)];
    S.lastResponses.add(rtPick);
    prefixLines.push(rtPick);
  }

  // Speak prefix + main as ONE utterance — no clip boundary, no volume dip
  // The "..." pause is visual-only and excluded from TTS
  const speakPromise = speakAndWait([...prefixLines, text].join(', '));

  // Type prefix lines
  for (const line of prefixLines) {
    await typeOut(line, 'dr', 14);
  }

  // Dramatic pause: visual only, does not interrupt the single audio clip
  if (pause) {
    await typeOut('...', 'dr', 180);
    await delay(900);
  }

  // Type main response, then wait for the shared audio to finish
  await typeOut(text, 'dr', 14);
  await speakPromise;

  // Name weaponization: occasional pointed use of the patient's name
  if (S.name && S.turn >= 3 && S.turn - S.nameWeaponTurn >= 4 && Math.random() < 0.22) {
    S.nameWeaponTurn = S.turn;
    const nwUnused = NAME_WEAPONS.filter(w => !S.lastResponses.has(w));
    const nwPool   = nwUnused.length ? nwUnused : NAME_WEAPONS;
    const nwTmpl   = nwPool[Math.floor(Math.random() * nwPool.length)];
    S.lastResponses.add(nwTmpl);
    const weaponText = nwTmpl.replace(/\{NAME\}/g, S.name.toUpperCase());
    await delay(500);
    await typeAndSpeak(weaponText, 'dr', 14);
  }

  // Session summary: fires once at turn 12 if enough topics have been revealed
  if (!S.summaryFired && S.turn >= 12 && S.memory.length >= 2) {
    addBlank();
    await deliverSessionSummary();
  }

  // DSM diagnosis: fires once at turn 35+ when at least 4 distinct topics revealed
  if (!S.dsmFired && S.turn >= 20 && S.memory.length >= 2) {
    S.dsmFired = true;
    const diagText = await callDiagnosis();
    if (diagText) {
      addBlank();
      await delay(1200);
      await typeAndSpeak('AFTER CAREFUL CONSIDERATION OF EVERYTHING YOU HAVE TOLD ME, I AM PREPARED TO MAKE A FORMAL ASSESSMENT.', 'dr', 14);
      await delay(800);
      await typeAndSpeak(diagText, 'dr', 14);
    } else {
      S.dsmAttempts++;
      if (S.dsmAttempts < 3) S.dsmFired = false; // retry next turn, up to 3 attempts
    }
  }

  addBlank();

  if (action === 'parity_error') {
    await delay(600);
    await runParityError();
  } else if (action === 'help') {
    await showHelp();
  }

  $inputLine.style.display = '';
  $output.scrollTop = $output.scrollHeight;
  S.busy = false;
}

// ── KEYBOARD ───────────────────────────────────────────────────────────────
document.addEventListener('keydown', async e => {
  // Ctrl+M toggles mute — works at any time without consuming typed letters
  if ((e.key === 'm' || e.key === 'M') && e.ctrlKey) {
    e.preventDefault();
    S.muted = !S.muted;
    if (S.muted && activeSource) { try { activeSource.stop(); } catch (_) {} activeSource = null; }
    return;
  }

  if (S.busy) return;

  if (e.key === 'Backspace') {
    e.preventDefault();
    S.buffer = S.buffer.slice(0, -1);
    $typed.textContent = S.buffer;
    $output.scrollTop = $output.scrollHeight;
    return;
  }

  if (e.key === 'Enter') {
    e.preventDefault();
    const val = S.buffer.trim();
    if (!val && S.phase !== 'chat') return;
    if (val) { S.inputHistory.unshift(val); }
    if (S.inputHistory.length > 50) S.inputHistory.pop();
    S.histIdx = -1;
    S.buffer  = '';
    $typed.textContent = '';
    await respond(val);
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (S.inputHistory.length) {
      S.histIdx = Math.min(S.histIdx + 1, S.inputHistory.length - 1);
      S.buffer  = S.inputHistory[S.histIdx];
      $typed.textContent = S.buffer;
    }
    return;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    S.histIdx = Math.max(S.histIdx - 1, -1);
    S.buffer  = S.histIdx >= 0 ? S.inputHistory[S.histIdx] : '';
    $typed.textContent = S.buffer;
    return;
  }

  if ((e.key === 'v' || e.key === 'V') && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    navigator.clipboard.readText().then(text => {
      if (!text) return;
      S.buffer += text.replace(/[\r\n]+/g, ' ').trim();
      $typed.textContent = S.buffer;
      $output.scrollTop = $output.scrollHeight;
    }).catch(() => {});
    return;
  }

  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    S.buffer += e.key;
    $typed.textContent = S.buffer;
    $output.scrollTop = $output.scrollHeight;
    if (S.phase === 'name') speak(e.key);
  }
});

// ── INIT ───────────────────────────────────────────────────────────────────
async function init() {
  $inputLine.style.display = 'none';

  if (!window.PATTERNS_DATA) {
    addLine('CRITICAL ERROR: patterns.js failed to load.', '');
    addLine('Ensure patterns.js is in the same folder as index.html.', '');
    return;
  }

  // Load eSpeak voice data (requires HTTP server — XHR blocked on file://)
  const voiceLoaded = await new Promise(resolve => {
    const t = setTimeout(() => resolve(false), 5000);
    meSpeak.loadVoice('voices/en/en-us.json', ok => { clearTimeout(t); resolve(!!ok); });
  });
  if (!voiceLoaded) S.muted = true;

  // Web Audio requires a user gesture — create AudioContext synchronously inside keydown.
  const primer = addLine('PRESS ANY KEY TO BEGIN.', 'sys');
  await new Promise(resolve => {
    document.addEventListener('keydown', () => {
      primer.remove();
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      resolve();
    }, { once: true });
  });

  await boot();
}

init();
