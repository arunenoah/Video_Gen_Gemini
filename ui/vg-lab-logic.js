// Prompt Lab logic — pure functions (no DOM, no network) so they can be tested with node.
// Cards are the sections of a good prompt; validate() grades each one and assemble() joins them in a fixed order.
(function (root) {
  const F = typeof module !== 'undefined' && module.exports ? require('./vg-formats.js') : root.VGFormats;
  const MAX_LEN = 200;   // per card — long enough for a sentence, short enough that nothing silly gets pasted in

  // kinds: 'both' = picture + video, 'video' = video only. required = must be filled for a "ready" prompt.
  const CARDS = [
    { id: 'idea', kind: 'both', required: true, minWords: 3, title: 'The idea', ask: 'What are you making?',
      why: 'One sentence that says the main thing. Everything else adds detail to it.',
      chips: ['A puppy learning to skateboard', 'A tiny dragon baking cookies', 'A robot planting a garden'] },
    { id: 'happening', kind: 'both', required: true, minWords: 4, title: "What's happening", ask: 'What is going on in the scene?',
      why: 'Action words make a picture feel alive: jumping, spinning, splashing, hiding.',
      chips: ['jumping over a puddle and laughing', 'slowly opening a glowing box', 'chasing a bubble across the grass'] },
    { id: 'who', kind: 'both', required: true, minWords: 2, title: 'Who is in it', ask: 'Who or what is in the scene?',
      why: 'Say what they look like: size, colour, clothes. The AI cannot guess your character.',
      chips: ['a small brown puppy with a red scarf', 'a girl in a yellow raincoat', 'a friendly green dragon'] },
    { id: 'place', kind: 'both', required: true, minWords: 2, title: 'Place', ask: 'Where does it happen?',
      why: 'The place sets the mood: a rainy road feels different from a snowy mountain.',
      chips: ['on a rainy road', 'on a snowy mountain', 'in a sunny meadow', 'under the sea'] },
    { id: 'lighting', kind: 'both', required: true, minWords: 2, title: 'Lighting', ask: 'What is the light like?',
      why: 'Day, night, rain or sunset — light changes the colours of everything.',
      chips: ['bright sunny day', 'dark night with a full moon', 'grey rainy afternoon', 'warm sunset glow'] },
    { id: 'style', kind: 'both', required: false, minWords: 1, title: 'Style / format', ask: 'What should it look like?',
      why: 'Cartoon, watercolor, 3D, clay, or a real photo — pick one look and stick with it.',
      chips: ['cartoon', 'watercolor painting', '3D animated movie', 'clay stop-motion', 'real photo'] },
    { id: 'layout', kind: 'both', required: false, minWords: 3, title: 'Explain it as', ask: 'Which kind of picture explains it best?',
      why: 'The same topic can be shown as a diagram, a cutaway, a comic and more. Pick the one that answers your question.',
      chips: F.FORMATS.map(f => 'explained as a ' + f.name.toLowerCase()) },
    { id: 'shape', kind: 'both', required: false, minWords: 1, title: 'Shape', ask: 'Wide, tall or square?',
      why: 'Wide (16:9) is like TV, tall (9:16) is like a phone, square (1:1) is like a sticker.',
      chips: ['wide 16:9', 'tall 9:16', 'square 1:1'] },
    { id: 'explain', kind: 'video', required: false, minWords: 3, title: 'Who explains', ask: 'Does someone talk or explain?',
      why: 'A narrator or a character can tell the story. Say who and how they sound.',
      chips: ['a kind grandpa narrator with a slow voice', 'the puppy talks in a squeaky voice', 'no talking, only music'] },
    { id: 'motion', kind: 'video', required: true, minWords: 3, title: 'Animation', ask: 'How do things move?',
      why: 'Slow or fast? Bouncy or smooth? Tell the AI how the movement feels.',
      chips: ['smooth and slow', 'bouncy cartoon movement', 'fast and energetic'] },
    { id: 'camera', kind: 'video', required: false, minWords: 2, title: 'Camera (cinematic)', ask: 'Where is the camera?',
      why: 'Movie makers move the camera: zoom in, fly over, follow the hero, look up from the ground.',
      chips: ['slow zoom in', 'camera follows from behind', 'high view flying over', 'close-up on the face'] },
    { id: 'sfx', kind: 'video', required: false, minWords: 2, title: 'SFX (sound effects)', ask: 'What sounds do we hear?',
      why: 'Splash, thunder, footsteps, giggles — little sounds make it feel real.',
      chips: ['rain pattering and thunder', 'happy giggles', 'crunchy footsteps in snow'] },
    { id: 'vfx', kind: 'video', required: false, minWords: 2, title: 'VFX (special effects)', ask: 'Any magic or special effects?',
      why: 'Sparkles, smoke, glowing light or floating bubbles add wow.',
      chips: ['golden sparkles', 'floating bubbles', 'glowing magic dust'] },
    { id: 'endscreen', kind: 'video', required: false, minWords: 3, title: 'End screen', ask: 'How does it finish?',
      why: 'A good ending: fade to black, a title card, or the hero waves goodbye.',
      chips: ['fade to black with the words The End', 'the hero waves goodbye', 'zoom out to a title card'] },
  ];

  function cardsFor(kind) { return CARDS.filter(c => c.kind === 'both' || kind === 'video'); }

  function words(s) { return String(s || '').trim().split(/\s+/).filter(Boolean).length; }

  // → 'missing' (empty) | 'vague' (too short to guide the AI) | 'ok'
  function gradeCard(card, text) {
    const n = words(text);
    if (n === 0) return 'missing';
    return n < card.minWords ? 'vague' : 'ok';
  }

  // → { items:[{id,title,required,status,hint}], score 0-100, ready, nextHint }
  function validate(kind, values) {
    const v = values || {};
    const items = cardsFor(kind).map(c => {
      const status = gradeCard(c, v[c.id]);
      const hint = status === 'missing' ? c.ask : status === 'vague' ? `Say a little more (at least ${c.minWords} words). ${c.ask}` : '';
      return { id: c.id, title: c.title, required: c.required, status, hint };
    });
    const req = items.filter(i => i.required), opt = items.filter(i => !i.required);
    const reqOk = req.filter(i => i.status === 'ok').length;
    const optOk = opt.filter(i => i.status === 'ok').length;
    // required cards are 80% of the score, optional extras the last 20%
    const score = Math.round(80 * reqOk / req.length + (opt.length ? 20 * optOk / opt.length : 20));
    const next = req.find(i => i.status !== 'ok') || opt.find(i => i.status === 'vague');
    return { items, score, ready: reqOk === req.length, nextHint: next ? next.hint : '' };
  }

  // → [{id,title,text}] in card order, only cards the learner actually filled; text is trimmed and capped
  function parts(kind, values) {
    const v = values || {};
    return cardsFor(kind).map(c => ({ id: c.id, title: c.title, text: String(v[c.id] || '').trim().slice(0, MAX_LEN) }))
      .filter(p => p.text);
  }

  function assemble(kind, values) {
    return parts(kind, values).map(p => p.text.replace(/[.\s]+$/, '')).join('. ') + (parts(kind, values).length ? '.' : '');
  }


  // ── Story check: does the story hook, care, wonder and finish? Rule-based, so it is free and instant ──
  const W = (re) => (t) => (t.match(re) || []).length;
  const STORY_CHECKS = [
    { id: 'hook', title: 'A hook at the start', weight: 20,
      tip: 'Start with something that makes the reader ask "what?" — a question, a sound, a surprise.',
      example: 'Suddenly, the garden gate began to glow…',
      test: (t, first) => /[?!"“]/.test(first) || W(/\b(suddenly|secret|mysterious|strange|imagine|what if|once upon|one day|nobody knew|huge|tiny|magic)\b/gi)(first) > 0 },
    { id: 'character', title: 'Someone to care about', weight: 15,
      tip: 'Give your hero a name and one thing about them — brave, tiny, funny, shy.',
      example: 'Pip was a tiny, curious robot who loved collecting shiny buttons.',
      test: (t) => /\b[a-z]+\s+[A-Z][a-z]{2,}/.test(t) || W(/\b(girl|boy|dog|cat|puppy|kitten|robot|dragon|penguin|fairy|bear|bunny|king|queen|friend|princess|monster|turtle|lizard|teacher|grandma|grandpa)\b/gi)(t) > 0 },
    { id: 'problem', title: 'A problem or a goal', weight: 20,
      tip: 'Stories need something to fix or find. What does your hero want, and what is in the way?',
      example: 'But the bridge was broken, and the little bear had to get home before dark.',
      test: (t) => W(/\b(but|problem|lost|stuck|needed|need|wanted|want|wish|trouble|afraid|scared|cannot|can't|couldn't|until|mystery|broken|missing|challenge|trapped|escape|find|search)\b/gi)(t) >= 1 },
    { id: 'senses', title: 'Things we can see, hear and feel', weight: 15,
      tip: 'Add what the hero sees, hears, smells or feels so the reader is right there too.',
      example: 'The air smelled like warm cookies, and the floor felt soft and bouncy.',
      test: (t) => W(/\b(saw|heard|smell|smelled|felt|soft|loud|bright|cold|warm|sweet|shiny|giggle|whisper|roar|crunch|splash|sparkle|happy|sad|excited|nervous|proud|brave|worried|surprised)\b/gi)(t) >= 2 },
    { id: 'twist', title: 'A surprise or twist', weight: 15,
      tip: 'Add a moment nobody expects — it keeps readers turning the page.',
      example: 'To everyone\'s surprise, the scary shadow was just a tiny kitten!',
      test: (t) => W(/\b(suddenly|surprise|surprised|unexpected|secret|turned out|but then|all of a sudden|just then|discovered)\b/gi)(t) > 0 },
    { id: 'ending', title: 'A happy or satisfying ending', weight: 15,
      tip: 'Finish by showing how things changed or what the hero learned.',
      example: 'From that day on, Pip and his friends met every evening to share their treasures.',
      test: (t, first, last) => W(/\b(finally|at last|from that day|the end|happily|learned|learnt|together|home|ever after|so they|and so)\b/gi)(last) > 0 },
  ];

  // → { score 0-100, label, checks:[{id,title,ok,tip,example}], sentences, words }
  function evaluateStory(text) {
    const t = String(text || '').trim().slice(0, 1500);
    const sentences = t.split(/(?<=[.!?])\s+/).filter(s => s.trim());
    const first = sentences[0] || '', last = sentences[sentences.length - 1] || '';
    const checks = STORY_CHECKS.map(c => ({ id: c.id, title: c.title, tip: c.tip, example: c.example,
      ok: t.length > 0 && sentences.length >= (c.id === 'ending' ? 2 : 1) && !!c.test(t, first, last) }));
    const score = t ? STORY_CHECKS.reduce((n, c, i) => n + (checks[i].ok ? c.weight : 0), 0) : 0;
    const label = !t ? 'Write a few sentences to begin' : score >= 85 ? 'Page-turner! Readers will love it' : score >= 55 ? 'Good start — readers are curious'
      : 'Needs more to hold a reader';
    return { score, label, checks, sentences: sentences.length, words: words(t) };
  }

  const api = { CARDS, MAX_LEN, cardsFor, gradeCard, validate, parts, assemble, evaluateStory, STORY_MAX: 1500 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VGLab = api;
})(typeof window !== 'undefined' ? window : globalThis);
