// "How do you want it explained?" — the picture formats an explanation can take, shared by Chat, Pictures and Prompt Lab.
// Pure data + pure functions (no DOM, no network) so they can be tested with node.
(function (root) {
  // kw = words in the child's question that make this format a good fit; {t} = the topic
  const FORMATS = [
    { id: 'whole', icon: '🚗', name: 'Whole-object view', asks: 'What does it look like?', example: 'Full car exterior',
      phrase: 'A clear picture of the whole {t}, seen from the outside.', kw: ['look like', 'what is', "what's", 'what are'] },
    { id: 'labelled', icon: '🏷️', name: 'Labelled diagram', asks: 'What are its main parts?', example: 'Label wheels, doors, lights and bonnet',
      phrase: 'A labelled diagram of {t} with the main parts named by simple arrows and labels.', kw: ['part', 'parts', 'made of', 'label', 'called'] },
    { id: 'interior', icon: '🪑', name: 'Interior view', asks: 'What is inside?', example: 'Dashboard, seats, steering wheel and pedals',
      phrase: 'The inside of {t}, showing what you would see if you stepped in.', kw: ['inside', 'interior'] },
    { id: '3d', icon: '🧊', name: '3D view', asks: 'What shape is it? How are parts positioned?', example: 'Car from above and at an angle',
      phrase: 'A 3D view of {t} from above and from an angle, so the shape and position of the parts are clear.', kw: ['shape', 'size', '3d', 'angle', 'big'] },
    { id: 'cutaway', icon: '✂️', name: 'Cutaway / cross-section', asks: 'What is hidden inside?', example: 'Engine and cabin revealed',
      phrase: 'A cutaway cross-section of {t}, with part of the outside removed to reveal what is hidden inside.', kw: ['hidden', 'inside', 'under', 'cut', 'cross'] },
    { id: 'exploded', icon: '💥', name: 'Exploded view', asks: 'How do the parts fit together?', example: 'Wheels, body, engine and chassis separated',
      phrase: 'An exploded view of {t}, with the parts floating apart in the order they fit together.', kw: ['fit', 'together', 'built', 'build', 'put together', 'assemble', 'work', 'works'] },
    { id: 'closeup', icon: '🔍', name: 'Close-up', asks: 'What does one part look like in detail?', example: 'Engine or brake assembly',
      phrase: 'A big close-up of the most important part of {t}, showing its details.', kw: ['detail', 'close', 'zoom', 'tiny', 'small'] },
    { id: 'steps', icon: '🔢', name: 'Step-by-step panels', asks: 'How does something happen?', example: 'Starting the car and moving forward',
      phrase: 'Step-by-step panels numbered 1, 2, 3, 4 showing how {t} happens, one simple step in each panel.', kw: ['how do', 'how does', 'how can', 'steps', 'happen', 'make', 'made', 'grow'] },
    { id: 'process', icon: '➡️', name: 'Process diagram', asks: 'How does it work?', example: 'Energy flows from fuel to engine to wheels',
      phrase: 'A simple process diagram of how {t} works, with arrows showing what flows from one part to the next.', kw: ['work', 'works', 'how does', 'how do', 'energy', 'flow', 'why'] },
    { id: 'compare', icon: '⚖️', name: 'Comparison image', asks: 'How are two things different?', example: 'Petrol car versus electric car',
      phrase: 'A side-by-side comparison picture that shows how the two things in {t} are different.', kw: [' vs ', 'versus', 'difference', 'different', 'compare', 'same as', 'or '] },
    { id: 'beforeafter', icon: '🔁', name: 'Before-and-after image', asks: 'What changes?', example: 'Flat tyre versus inflated tyre',
      phrase: 'A before-and-after picture of {t}, with BEFORE on the left and AFTER on the right.', kw: ['before', 'after', 'change', 'become', 'turn into', 'grow', 'melt', 'freeze'] },
    { id: 'scene', icon: '🌍', name: 'Real-world scene', asks: 'Where and how is it used?', example: 'A family driving a car',
      phrase: 'A real-world scene that shows where and how {t} is used by people every day.', kw: ['where', 'used', 'use', 'when do', 'people'] },
    { id: 'analogy', icon: '💡', name: 'Visual analogy', asks: 'How can a difficult idea become familiar?', example: 'Engine as the car’s “muscles”',
      phrase: 'A visual analogy that explains {t} by comparing it to something a child already knows from everyday life.', kw: ['why', 'what is', "what's", 'like a', 'explain', 'mean'] },
    { id: 'comic', icon: '📖', name: 'Comic / storyboard', asks: 'How can a story explain it?', example: 'A child discovers why a car needs brakes',
      phrase: 'A four-panel comic strip with a friendly child character who discovers how {t} works.', kw: ['story', 'why', 'tell', 'adventure'] },
  ];
  const DEFAULTS = ['whole', 'labelled', 'process', 'analogy'];    // when nothing in the question hints at a format
  const byId = (id) => FORMATS.find(f => f.id === id);

  // The thing being asked about, without the question words: "How does a car work?" → "a car"
  function topicOf(text) {
    let t = String(text || '').replace(/[?!.]+$/, '').trim().slice(0, 120);
    t = t.replace(/^(can you |could you |please |tell me |explain |show me )+/i, '')
         .replace(/^(how|what|why|where|when|who)\b(\s+(does|do|is|are|did|can|was|were))?\s+/i, '')
         .replace(/\s+(work|works|happen|happens)$/i, '').trim();
    return t || String(text || '').trim().slice(0, 120);
  }

  // → { top:[3–4 best-fit formats], more:[the rest] }. Fit = how many keyword hints appear in the question.
  function suggestFormats(question) {
    const q = ' ' + String(question || '').toLowerCase() + ' ';
    const scored = FORMATS.map((f, i) => ({ f, i, s: f.kw.filter(k => q.includes(k)).length }));
    const hits = scored.filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.f);
    const top = [];
    for (const f of hits.concat(DEFAULTS.map(byId))) { if (top.length < 4 && !top.includes(f)) top.push(f); }
    return { top, more: FORMATS.filter(f => !top.includes(f)) };
  }

  // The picture prompt for a topic in one format (kept well under the 1000-char server limit)
  function buildFormatPrompt(topic, format) {
    const t = String(topic || 'it').trim().slice(0, 120) || 'it';
    return format.phrase.replace('{t}', t) + ' Bright, simple, friendly and easy for a child to understand.';
  }

  const api = { FORMATS, topicOf, suggestFormats, buildFormatPrompt, byId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VGFormats = api;
})(typeof window !== 'undefined' ? window : globalThis);
