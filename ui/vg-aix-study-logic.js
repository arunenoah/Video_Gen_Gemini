/* ============================================================
   Study Buddy: pure logic (no DOM, no network). Node-testable UMD.
   Ladder state machine, request builder (limits identical to POST /api/study), "tried" detection,
   message trimming, intent routing, honest-confidence line, and the Wonder Journal store.
   ============================================================ */
(function (root) {
  const MAX_MESSAGES = 12, MAX_CONTENT = 2000, MAX_TOTAL = 8000;       // server: _read_messages
  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;                              // server: UPLOAD_MAX_BYTES
  const GRADES = ['g1-3', 'g4-6', 'g7-9'];
  const MODES = ['homework', 'wonder'];
  const INTENTS = ['ask', 'check', 'teachback', 'deeper'];
  const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
  const ENGINE_TEXT = 'chat-deepseek', ENGINE_VISION = 'chat-minimax';  // pictures need the vision helper
  const TRIED_WORDS = 4;

  const JOURNAL_KEY = 'sg-aix-wonder-v1', JOURNAL_MAX = 20, JOURNAL_BYTES = 8 * 1024, Q_MAX = 80, FACT_MAX = 120;

  // Canned kid-side lines for the one-tap buttons: they become real user turns, so the model always has a last user message.
  const CANNED = {
    hint: 'Can I have a little hint, please?',
    step: 'Can you show me just one step?',
    answer: 'I would like to see the answer, please.',
    check: 'Can you help me check that?',
    deeper: 'Why is that? Go deeper, please!',
  };

  const strip = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  // match() instead of a lookbehind split: older iPads/Safari do not support lookbehind
  const splitSentences = (t) => (String(t || '').match(/[^.!?\n]+[.!?]*/g) || []).map(strip).filter(Boolean);
  const words = (s) => strip(s).split(' ').filter(Boolean);

  /** True when the child wrote at least 4 words, i.e. they told us what they tried. @param {string} text @returns {boolean} */
  function isTried(text) { return words(text).length >= TRIED_WORDS; }

  /** @returns {{rung:number,usedHelp:boolean,tried:boolean,hasReply:boolean,wonders:number}} a fresh conversation. */
  function newLadder() { return { rung: 1, usedHelp: false, tried: false, hasReply: false, wonders: 0 }; }

  /**
   * The ladder step to send for an action. The very first send is always step 1 (a nudge question).
   * @param {Object} st ladder state @param {'send'|'hint'|'step'|'answer'} action @returns {number} 1..4
   */
  function ladderFor(st, action) {
    if (!st.hasReply) return 1;
    if (action === 'hint') return 2;
    if (action === 'step') return 3;
    if (action === 'answer') return 4;
    return st.rung;                                                    // a plain follow-up stays on the current step
  }

  /**
   * "Show the answer" unlocks only after a hint/step was used OR the child SENT a real try (>= 4 words).
   * Merely typing words in the box no longer counts: the gate has to follow a real action. It is a speed bump,
   * not a lock, and the copy says so.
   * @param {Object} st ladder state @param {string} draft unused (kept so old callers still work) @returns {boolean}
   */
  function canShowAnswer(st, draft) { return !!st.hasReply && (st.usedHelp || st.tried); }

  /**
   * State after a message was sent (immutable).
   * @param {Object} st @param {{action:string, text:string, ladder:number, typed:boolean}} sent
   */
  function afterSend(st, sent) {
    const typed = !!sent.typed;                                        // text the child wrote themselves (a hint request with words counts)
    return Object.assign({}, st, {
      rung: sent.ladder,
      usedHelp: st.usedHelp || sent.ladder === 2 || sent.ladder === 3,
      tried: st.tried || (typed && isTried(sent.text)),
    });
  }

  /** State once Sunny's reply has arrived. */
  function afterReply(st) { return Object.assign({}, st, { hasReply: true }); }

  /**
   * "Did that make sense?" adapts the NEXT step. Got it -> back to a nudge (the child is flying);
   * Kind of -> at least a hint; Lost -> one step more help (never jumps to the full answer by itself).
   * @param {Object} st @param {'yes'|'maybe'|'no'} feel @returns {Object} new state
   */
  function applyFeedback(st, feel) {
    let rung = st.rung;
    if (feel === 'yes') rung = 1;
    else if (feel === 'maybe') rung = Math.max(2, Math.min(3, rung));
    else if (feel === 'no') rung = Math.min(3, rung + 1);
    return Object.assign({}, st, { rung });
  }

  /** Which ladder button to gently highlight after the feedback (null = none). */
  function suggestion(st, feel) {
    if (feel === 'no') return st.rung >= 3 ? 'step' : 'hint';
    if (feel === 'maybe') return 'hint';
    return null;
  }

  /**
   * Decide the server intent for an action. 'deeper' only exists in wonder mode; 'check'/'teachback' work in both.
   * @param {string} mode @param {string} action 'send'|'hint'|'step'|'answer'|'check'|'teachback'|'deeper' @returns {string} intent
   */
  function routeIntent(mode, action) {
    if (action === 'check') return 'check';
    if (action === 'teachback') return 'teachback';
    if (action === 'deeper' && mode === 'wonder') return 'deeper';
    return 'ask';
  }

  /**
   * Keep what the server will accept: only user/assistant turns with text, content <= 2000, the newest 12,
   * total <= 8000 (oldest dropped first), never starting with an assistant turn.
   * @param {Array<{role:string,content:string}>} msgs @returns {Array<{role:string,content:string}>}
   */
  function trimMessages(msgs) {
    let out = (Array.isArray(msgs) ? msgs : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content.trim().slice(0, MAX_CONTENT) }))
      .filter(m => m.content.length > 0)
      .slice(-MAX_MESSAGES);
    const total = () => out.reduce((n, m) => n + m.content.length, 0);
    while (out.length > 1 && total() > MAX_TOTAL) out = out.slice(1);
    while (out.length > 1 && out[0].role === 'assistant') out = out.slice(1);
    return out;
  }

  /** @returns {boolean} whether `img` looks like what the server accepts ({mime, base64} under 2 MB). */
  function imageOk(img) {
    return !!img && typeof img === 'object' && IMAGE_MIMES.indexOf(String(img.mime).toLowerCase()) !== -1
      && typeof img.base64 === 'string' && img.base64.length > 0 && img.base64.length <= Math.floor(MAX_IMAGE_BYTES * 4 / 3) + 100;
  }

  /**
   * Build the POST /api/study body with the same checks the server makes.
   * @param {{mode:string,grade:string,ladder:number,intent:string,messages:Array,image?:Object}} o
   * @returns {{ok:boolean, body?:Object, error?:string}}
   */
  function buildRequest(o) {
    o = o || {};
    if (MODES.indexOf(o.mode) === -1 || GRADES.indexOf(o.grade) === -1 || INTENTS.indexOf(o.intent) === -1
      || !Number.isInteger(o.ladder) || o.ladder < 1 || o.ladder > 4) return { ok: false, error: 'Something is not set up right. Try again!' };
    const messages = trimMessages(o.messages);
    if (!messages.length || messages[messages.length - 1].role !== 'user') return { ok: false, error: 'Write a question for Sunny first.' };
    if (o.image && !imageOk(o.image)) return { ok: false, error: 'Please pick a PNG, JPEG or WebP picture smaller than 2 MB.' };
    const body = { engine: o.image ? ENGINE_VISION : ENGINE_TEXT, mode: o.mode, grade: o.grade, ladder: o.ladder, intent: o.intent, messages };
    if (o.image) body.image = { mime: String(o.image.mime).toLowerCase(), base64: o.image.base64 };
    return { ok: true, body };
  }

  // Care message for a child who may be sad or unsafe. The helpline is configurable per locale (window.AIX_HELPLINE).
  const DEFAULT_HELPLINE = 'If you are in Australia you can also call Kids Helpline on 1800 55 1800 any time.';
  const careText = (helpline) => "I'm really glad you told me. I'm a computer program, so I can't help the way a person can. "
    + 'Please tell a grown-up you trust right now: a parent, a teacher or a school counsellor. '
    + (helpline === undefined ? (root.AIX_HELPLINE === undefined ? DEFAULT_HELPLINE : root.AIX_HELPLINE) : helpline) + ' You matter.';

  /**
   * Classify a failed call. 'care' (self-harm support) and 'blocked' (a message we will not send) are calm cards with
   * NO retry: resending the same words would only add strikes. 'error' keeps a Try again button.
   * @param {number} status @param {Object} data parsed JSON (may be empty) @param {string} [helpline]
   * @returns {{kind:'care'|'blocked'|'error', text:string, retry:boolean}}
   */
  function errorInfo(status, data, helpline) {
    const msg = data && typeof data.error === 'string' ? data.error.slice(0, 200) : '';
    if (data && data.retryable && status === 422) return { kind: 'error', text: msg || 'Sunny could not check that just now. Try again in a moment!', retry: true };
    if (status === 422 || (data && data.blocked)) {
      if (data && data.care) return { kind: 'care', text: careText(helpline), retry: false };
      return { kind: 'blocked', text: msg || "Let's try a different question.", retry: false };
    }
    if (status === 429) return { kind: 'error', text: msg || "You've used lots of AI time for now. Take a break and come back soon!", retry: false };
    if (status === 402 || status === 423 || status === 403) return { kind: 'error', text: msg || 'Sunny can not help right now. Ask a grown-up.', retry: false };
    if (status === 400 && msg) return { kind: 'error', text: msg, retry: false };
    return { kind: 'error', text: 'Sunny is taking a short nap. Try again in a moment!', retry: true };
  }

  /** Friendly one-line text for a failed call (see errorInfo for the kind). @returns {string} */
  function friendlyError(status, data) { return errorInfo(status, data).text; }

  /**
   * Find Sunny's honest-confidence sentence in a reply, if there is one.
   * @param {string} reply @returns {{level:'sure'|'unsure', text:string}|null}
   */
  function confidence(reply) {
    const sentences = splitSentences(reply);
    const unsure = /\b(i['’]m not sure|i am not sure|not (?:completely |totally )?certain|check (?:it )?(?:in )?(?:with )?your (?:book|teacher))/i;
    const sure = /\b(i['’]m (?:(?:fairly|pretty|quite|very) )?sure|i am (?:(?:fairly|pretty|quite|very) )?sure|i['’]m confident)/i;
    const u = sentences.find(s => unsure.test(s));
    if (u) return { level: 'unsure', text: u.slice(0, 160) };
    const s = sentences.find(x => sure.test(x));
    return s ? { level: 'sure', text: s.slice(0, 160) } : null;
  }

  /**
   * The line Sunny marked 'Fun fact:' in a wonder answer (text after the marker up to the next sentence end), or ''
   * when there is no marker. We never guess: saving a greeting or a guess as a "fact" would be worse than no button.
   */
  function pickFact(reply) {
    const m = /fun fact\s*:\s*([\s\S]+)/i.exec(String(reply || ''));
    if (!m) return '';
    const first = strip(m[1]).match(/^[^.!?\n]+[.!?]?/);
    const fact = first ? first[0].trim() : '';
    if (fact.length < 8) return '';
    return fact.length > FACT_MAX ? fact.slice(0, FACT_MAX - 1).replace(/\s+\S*$/, '') + '…' : fact;
  }

  // ---- gentle wellbeing nudges (both studios) ----
  const BREAK_MS = 20 * 60 * 1000, DEEPER_LIMIT = 5;
  /** True once the child has been exploring for 20 minutes (the caller shows the nudge only once). */
  function breakDue(startedMs, nowMs) { return Number.isFinite(startedMs) && Number.isFinite(nowMs) && nowMs - startedMs >= BREAK_MS; }
  /** After 5 'Go deeper' turns the button invites the child to try it for real instead of asking more. */
  function deeperLabel(count) { return count >= DEEPER_LIMIT ? 'Try it for real! Do the experiment, then come back and tell me.' : 'Go deeper'; }

  // ---- Wonder Journal: hostile storage is assumed, so every read is validated and capped ----
  /** Keep only well-formed entries ({q<=80, fact<=120} strings), newest first, max 20. @param {*} raw @returns {Array<{q:string,fact:string}>} */
  function cleanJournal(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const e of raw) {
      if (!e || typeof e !== 'object' || typeof e.q !== 'string' || typeof e.fact !== 'string') continue;
      const q = strip(e.q).slice(0, Q_MAX), fact = strip(e.fact).slice(0, FACT_MAX);
      if (q && fact) out.push({ q, fact });
      if (out.length >= JOURNAL_MAX) break;
    }
    return out;
  }

  /** Read the journal from a Storage-like object. Oversize, corrupt or missing data gives []. Never throws. */
  function loadJournal(storage) {
    try {
      const s = storage.getItem(JOURNAL_KEY);
      if (typeof s !== 'string' || s.length > JOURNAL_BYTES) return [];
      return cleanJournal(JSON.parse(s));
    } catch (e) { return []; }
  }

  /** Serialise within the 8 KB cap by dropping the oldest entries. @returns {string} */
  function serializeJournal(list) {
    let l = cleanJournal(list);
    let s = JSON.stringify(l);
    while (s.length > JOURNAL_BYTES && l.length) { l = l.slice(0, -1); s = JSON.stringify(l); }
    return s;
  }

  /** Write the journal; returns false when storage is blocked. */
  function saveJournal(storage, list) {
    try { storage.setItem(JOURNAL_KEY, serializeJournal(list)); return true; } catch (e) { return false; }
  }

  /** Add an entry on top (same question replaces the old one). Returns the new list; does not touch storage. */
  function addEntry(list, q, fact) {
    const e = { q: strip(q).slice(0, Q_MAX), fact: strip(fact).slice(0, FACT_MAX) };
    if (!e.q || !e.fact) return cleanJournal(list);
    return cleanJournal([e].concat(cleanJournal(list).filter(x => x.q !== e.q)));
  }

  /** Remove the entry at index i. */
  function removeEntry(list, i) { return cleanJournal(list).filter((_, k) => k !== i); }

  const api = {
    MAX_MESSAGES, MAX_CONTENT, MAX_TOTAL, MAX_IMAGE_BYTES, GRADES, MODES, INTENTS, CANNED, JOURNAL_KEY, JOURNAL_MAX, JOURNAL_BYTES,
    isTried, newLadder, ladderFor, canShowAnswer, afterSend, afterReply, applyFeedback, suggestion, routeIntent,
    trimMessages, buildRequest, friendlyError, errorInfo, careText, confidence, pickFact, breakDue, deeperLabel, BREAK_MS, DEEPER_LIMIT,
    cleanJournal, loadJournal, saveJournal, serializeJournal, addEntry, removeEntry,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AIXStudyLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
