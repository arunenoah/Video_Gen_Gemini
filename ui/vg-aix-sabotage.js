// Sabotage! logic — pure (no DOM, no network) so it can be tested under node.
// Bolt is a tiny nearest-neighbour "AI": it decides food / not food by looking at labelled examples that share feature tags.
// Garbage labels in -> silly decisions out. That is the whole lesson.
(function (root) {
  const FOOD = 'food', NOT = 'not food';
  const K = 3;                       // how many look-alike examples get a vote

  // Every item has exactly 2 of the 5 tags and no two items share a tag pair, so one flipped label always changes that
  // item's own decision (its own example outweighs the two next-nearest neighbours). Lines are gentle and silly, never scary.
  const I = (id, name, tags, label, orderText, ok, bad) => ({ id, name, tags, label, orderText, ok, bad });
  const ITEMS = [
    I('banana', 'banana', ['long', 'sweet'], FOOD, 'Snack time! Bring me the banana!', 'Bolt peels the banana and serves it with a big bow.', 'Bolt tosses the banana in the laundry basket. Banana pyjamas, anyone?'),
    I('apple', 'apple', ['round', 'sweet'], FOOD, 'Snack time! Bring me the apple!', 'Bolt polishes the apple and hands it over. Crunch!', 'Bolt hides the apple in the toy box. The teddy bears look very confused.'),
    I('carrot', 'carrot', ['hard', 'sweet'], FOOD, 'Snack time! Bring me the carrot!', 'Bolt serves a crunchy carrot. Bugs Bunny would be proud.', 'Bolt puts the carrot in the sock drawer. Surprise, socks!'),
    I('cupcake', 'cupcake', ['soft', 'sweet'], FOOD, 'Dessert time! Bring me the cupcake!', 'Bolt carries the cupcake in with a tiny drumroll.', 'Bolt parks the cupcake on the shoe rack. Fancy shoe-cake!'),
    I('shoe', 'shoe', ['long', 'hard'], NOT, 'Tidy time! Put the shoe away!', 'Bolt lines the shoe up by the front door. Neat!', 'Bolt serves a shoe on a fancy plate. Crunchy sole, anyone?'),
    I('ball', 'ball', ['round', 'hard'], NOT, 'Tidy time! Put the ball away!', 'Bolt tosses the ball into the toy box. Goal!', 'Bolt puts the ball on the snack plate. It bounces off the table and rolls away!'),
    I('sock', 'sock', ['long', 'soft'], NOT, 'Tidy time! Put the sock away!', 'Bolt folds the sock and tucks it in the drawer.', 'Bolt serves a sock soup. It is a little bit smelly.'),
    I('pillow', 'pillow', ['round', 'soft'], NOT, 'Tidy time! Put the pillow away!', 'Bolt fluffs the pillow and puts it on the bed.', 'Bolt serves a pillow for lunch. Fluffy, but not very tasty!'),
  ];
  const ORDERS = ITEMS.map(it => ({ id: 'order-' + it.id, item: it.id, text: it.orderText }));

  const byId = (id) => ITEMS.find(it => it.id === id) || null;
  const shuffleCopy = (arr, rand) => {            // Fisher-Yates on a copy
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  };
  const similarity = (a, b) => {                  // Jaccard overlap of two tag lists: 1 = identical, 0 = nothing shared
    const shared = a.filter(t => b.indexOf(t) !== -1).length;
    return shared / (a.length + b.length - shared);
  };

  /**
   * Apply the kid's labels to the items. Unknown / invalid labels fall back to the true label.
   * @param {Object[]} items @param {Object<string,string>} labels item id -> 'food'|'not food' @returns {Object[]} labelled copies
   */
  function labelled(items, labels) {
    const l = labels && typeof labels === 'object' ? labels : {};
    return items.map(it => {
      const v = Object.prototype.hasOwnProperty.call(l, it.id) ? l[it.id] : null;
      return Object.assign({}, it, { label: v === FOOD || v === NOT ? v : it.label });
    });
  }

  /** Bolt "learns" by remembering every labelled example. @param {{tags:string[],label:string}[]} items @returns {Object} model */
  function train(items) {
    return { examples: (Array.isArray(items) ? items : []).map(it => ({ tags: it.tags, label: it.label })) };
  }

  /**
   * Ask Bolt. The K most look-alike examples vote, each vote weighted by similarity squared, so an exact match
   * (the very item Bolt was taught) beats two weaker look-alikes. Nothing learned -> 'not food' (Bolt stays careful).
   * @param {Object} model from train() @param {{tags:string[]}} item @returns {'food'|'not food'}
   */
  function decide(model, item) {
    const ex = model && Array.isArray(model.examples) ? model.examples : [];
    const near = ex.map((e, i) => ({ e, i, s: similarity(item.tags, e.tags) }))
      .sort((a, b) => b.s - a.s || a.i - b.i).slice(0, K);       // index tiebreak keeps it deterministic
    let food = 0, not = 0;
    near.forEach(n => { if (n.e.label === FOOD) food += n.s * n.s; else not += n.s * n.s; });
    return food > not ? FOOD : NOT;
  }

  /**
   * Run orders through Bolt. `correct` means Bolt's decision matches the TRUE label (so the right thing happens).
   * @param {Object} model @param {{id:string,item:string,text:string}[]} orders @returns {{order:Object,item:Object,decision:string,correct:boolean}[]}
   */
  function runOrders(model, orders) {
    return (Array.isArray(orders) ? orders : []).map(order => {
      const item = byId(order.item);
      if (!item) return null;
      const decision = decide(model, item);
      return { order, item, decision, correct: decision === item.label };
    }).filter(Boolean);
  }

  /**
   * Pick n orders. Items the kid sabotaged come first so the silly outcomes always show up; the rest is seeded random.
   * @param {() => number} rand @param {number} n @param {string[]} flippedIds @returns {Object[]} orders (shuffled)
   */
  function pickOrders(rand, n, flippedIds) {
    const flipped = new Set(Array.isArray(flippedIds) ? flippedIds : []);
    const mustHave = shuffleCopy(ORDERS.filter(o => flipped.has(o.item)), rand).slice(0, n);
    const rest = shuffleCopy(ORDERS.filter(o => mustHave.indexOf(o) === -1), rand).slice(0, Math.max(0, n - mustHave.length));
    return shuffleCopy(mustHave.concat(rest), rand);
  }

  /** The items in a fresh seeded order. @param {() => number} rand @returns {Object[]} */
  function pickItems(rand) { return shuffleCopy(ITEMS, rand); }

  /** What happened in an order: the cartoon line. @param {{item:Object,correct:boolean}} r @returns {string} */
  function outcomeLine(r) { return r.correct ? r.item.ok : r.item.bad; }

  /** How many labels differ from the truth. @param {Object[]} items @param {Object<string,string>} labels @returns {number} */
  function countFlips(items, labels) {
    const l = labels && typeof labels === 'object' ? labels : {};
    return items.filter(it => Object.prototype.hasOwnProperty.call(l, it.id) && (l[it.id] === FOOD || l[it.id] === NOT) && l[it.id] !== it.label).length;
  }

  /** @param {Object[]} items @param {Object} labels @returns {string[]} ids whose label is currently wrong */
  function flippedIds(items, labels) {
    const l = labels && typeof labels === 'object' ? labels : {};
    return items.filter(it => (l[it.id] === FOOD || l[it.id] === NOT) && l[it.id] !== it.label).map(it => it.id);
  }

  /**
   * Stars: 1 for finishing; 2 if the kid sabotaged >= 3 labels AND fixed Bolt back to >= 4/5; 3 if at least one label was flipped AND the final run is 5/5.
   * @param {number} flips labels sabotaged in phase A @param {number} finalCorrect correct orders in the last run (0..5) @returns {1|2|3}
   */
  function starsFor(flips, finalCorrect) {
    // No sabotage = lesson never seen, so a perfect run alone can't earn 3 stars.
    if (flips >= 1 && finalCorrect >= 5) return 3;
    if (flips >= 3 && finalCorrect >= 4) return 2;
    return 1;
  }

  const api = { FOOD, NOT, K, ITEMS, ORDERS, labelled, train, decide, runOrders, pickOrders, pickItems, outcomeLine, countFlips, flippedIds, starsFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AIX_SABOTAGE = api;
})(typeof window !== 'undefined' ? window : globalThis);
