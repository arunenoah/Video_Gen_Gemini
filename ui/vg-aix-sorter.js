// Pet Sorter logic — pure (no DOM, no network) so it can be tested with node.
// Bolt learns "cat or dog?" from the creatures a kid sorts, using tiny naive-Bayes feature counting.
(function (root) {
  const LABELS = ['cat', 'dog'];
  const WOBBLE_BELOW = 0.65;            // Bolt wobbles (is unsure) under this confidence
  const MIN_TO_TEST = 6;                // sorted pets needed before "Test Bolt" opens
  const TRAIN_SIZE = 10;                // pets in the tray per play (5 cats + 5 dogs)
  const TEST_SIZE = 4;                  // mystery pets (2 cats + 2 dogs)

  // The only things Bolt can "see": three tags per creature. The drawing is for the kid.
  const FEATURES = {
    ears: ['pointy', 'floppy', 'round'],
    tail: ['fluffy', 'thin', 'curly', 'stubby'],
    sound: ['meow', 'woof', 'squeak'],
  };

  // c(id, name, cls, ears, tail, sound, color, size, quirk?) — quirk is Bolt's line for a deliberately tricky pet.
  const c = (id, name, cls, ears, tail, sound, color, size, quirk) => ({ id, name, cls, ears, tail, sound, color, size, quirk: quirk || null });
  const POOL = [
    c('mittens', 'Mittens', 'cat', 'pointy', 'thin', 'meow', 'gray', 'm'),
    c('pudding', 'Pudding', 'cat', 'pointy', 'fluffy', 'meow', 'orange', 'l'),
    c('noodle', 'Noodle', 'cat', 'pointy', 'curly', 'meow', 'cream', 's'),
    c('sirfold', 'Sir Fold', 'cat', 'floppy', 'thin', 'meow', 'gray', 'm', 'Floppy ears on a cat? Tricky! Some cats really have folded ears.'),
    c('tinytim', 'Tiny Tim', 'cat', 'round', 'thin', 'squeak', 'black', 's', 'A squeaky kitten! Bolt has not heard that before.'),
    c('duchess', 'Duchess', 'cat', 'round', 'fluffy', 'meow', 'white', 'l'),
    c('zigzag', 'Zigzag', 'cat', 'pointy', 'stubby', 'meow', 'orange', 'm', 'A cat with a stubby tail! Bobtail cats are real.'),
    c('peppers', 'Peppers', 'cat', 'pointy', 'curly', 'squeak', 'black', 's'),
    c('biscuit', 'Biscuit', 'dog', 'floppy', 'fluffy', 'woof', 'brown', 'm'),
    c('waffles', 'Waffles', 'dog', 'floppy', 'curly', 'woof', 'cream', 'l'),
    c('pip', 'Pip', 'dog', 'floppy', 'stubby', 'squeak', 'brown', 's', 'A squeaky puppy! Puppies make funny noises.'),
    c('frost', 'Frost', 'dog', 'pointy', 'fluffy', 'woof', 'gray', 'l', 'Pointy ears on a dog? Huskies have them. Tricky!'),
    c('rex', 'Rex', 'dog', 'pointy', 'thin', 'woof', 'brown', 'm'),
    c('doodle', 'Doodle', 'dog', 'round', 'curly', 'woof', 'orange', 'm'),
    c('sprout', 'Sprout', 'dog', 'floppy', 'thin', 'woof', 'white', 's'),
    c('dot', 'Dot', 'dog', 'round', 'stubby', 'squeak', 'black', 's'),
  ];

  /**
   * Split the pool into a training tray and unseen mystery pets, shuffled with the seeded rng.
   * @param {() => number} rand seeded generator (AIXCore.rng)
   * @returns {{train: Object[], test: Object[]}} 10 tray pets (5 cats, 5 dogs) and 4 mystery pets (2 cats, 2 dogs); never overlapping
   */
  function pickTrainAndTest(rand) {
    const shuf = (arr) => {                       // local Fisher-Yates so this file has no dependency on the core
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
      return a;
    };
    const cats = shuf(POOL.filter(p => p.cls === 'cat')), dogs = shuf(POOL.filter(p => p.cls === 'dog'));
    const half = TEST_SIZE / 2, tray = TRAIN_SIZE / 2;
    return {
      test: shuf(cats.slice(0, half).concat(dogs.slice(0, half))),
      train: shuf(cats.slice(half, half + tray).concat(dogs.slice(half, half + tray))),
    };
  }

  /**
   * Count how often each tag value shows up under each label the kid chose.
   * @param {{creature:Object,label:string}[]} examples pets with the pile (label) the kid put them in
   * @returns {{n:Object, counts:Object, total:number}} model; bad entries are ignored, never thrown on
   */
  function train(examples) {
    const model = { n: { cat: 0, dog: 0 }, counts: { cat: {}, dog: {} }, total: 0 };
    (Array.isArray(examples) ? examples : []).forEach(ex => {
      if (!ex || !ex.creature || LABELS.indexOf(ex.label) === -1) return;
      model.n[ex.label]++; model.total++;
      Object.keys(FEATURES).forEach(f => {
        const key = f + '=' + ex.creature[f];
        model.counts[ex.label][key] = (model.counts[ex.label][key] || 0) + 1;
      });
    });
    return model;
  }

  /**
   * Bolt's guess. Naive Bayes with Laplace (+1) smoothing so unseen tags never zero things out.
   * With no examples both labels tie at 0.5 and Bolt says 'cat'.
   * @returns {{label:string, confidence:number}} confidence in 0.5..1 (the winning label's share)
   */
  function predict(model, creature) {
    const logp = {};
    LABELS.forEach(l => {
      let lp = Math.log((model.n[l] + 1) / (model.total + LABELS.length));          // smoothed prior
      Object.keys(FEATURES).forEach(f => {
        const k = FEATURES[f].length, hit = model.counts[l][f + '=' + creature[f]] || 0;
        lp += Math.log((hit + 1) / (model.n[l] + k));                                // smoothed likelihood
      });
      logp[l] = lp;
    });
    const best = logp.cat >= logp.dog ? 'cat' : 'dog', other = best === 'cat' ? 'dog' : 'cat';
    return { label: best, confidence: 1 / (1 + Math.exp(logp[other] - logp[best])) };
  }

  /** Bolt's overall confidence: the average confidence across some pets (drives the live meter). 0.5 for an empty list. */
  function meter(model, creatures) {
    if (!creatures || !creatures.length) return 0.5;
    return creatures.reduce((s, cr) => s + predict(model, cr).confidence, 0) / creatures.length;
  }

  /**
   * Run Bolt over the mystery pets and compare with the truth.
   * @returns {{correct:number,total:number,results:{creature:Object,label:string,confidence:number,right:boolean,unsure:boolean}[]}}
   */
  function scoreTest(model, tests) {
    const results = (tests || []).map(cr => {
      const p = predict(model, cr);
      return { creature: cr, label: p.label, confidence: p.confidence, right: p.label === cr.cls, unsure: p.confidence < WOBBLE_BELOW };
    });
    return { correct: results.filter(r => r.right).length, total: results.length, results };
  }

  /** 1 star for finishing; 2 if Bolt got >= 3 of 4; 3 if 4 of 4 AND the kid showed Bolt >= 8 pets. */
  function starsFor(correct, trained) {
    if (correct >= 4 && trained >= 8) return 3;
    if (correct >= 3) return 2;
    return 1;
  }

  /**
   * Bolt's reaction when a pet lands in a pile. Never negative: a "wrong" pile gets a funny shrug, not a penalty.
   * @param {Object} creature @param {string} label the pile chosen @param {() => number} rand seeded generator
   * @returns {{mood:string,text:string,agree:boolean}} mood is one of AixBolt's moods
   */
  function reaction(creature, label, rand) {
    const pick = (a) => a[Math.floor(rand() * a.length) % a.length];
    const agree = creature.cls === label;
    if (!agree) {
      return { agree, mood: 'confused', text: pick([
        `A ${label} that says "${creature.sound}"? Okay, Bolt will remember that!`,
        `Interesting! ${creature.name} is now a ${label}. Bolt believes you!`,
        `Hmm, Bolt is learning that ${creature.ears} ears mean ${label}. Is that right?`,
      ]) };
    }
    if (creature.quirk) return { agree, mood: 'curious', text: creature.quirk };
    return { agree, mood: pick(['happy', 'proud']), text: pick([
      `Got it! ${creature.name} goes in the ${label} pile.`,
      `${creature.name} says "${creature.sound}"! Bolt is taking notes.`,
      `Ooh, ${creature.tail} tail and ${creature.ears} ears. Bolt remembers!`,
    ]) };
  }

  const api = { LABELS, FEATURES, WOBBLE_BELOW, MIN_TO_TEST, TRAIN_SIZE, TEST_SIZE, POOL, pickTrainAndTest, train, predict, meter, scoreTest, starsFor, reaction };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AIX_SORTER = api;
})(typeof window !== 'undefined' ? window : globalThis);
