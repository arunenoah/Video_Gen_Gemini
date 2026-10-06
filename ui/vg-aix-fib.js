// Fib Finder logic — pure (no DOM, no network) so it can be tested with node.
// Each round is a kid question, a chatbot answer of five short sentences and exactly ONE made-up sentence (the fib).
// Every other sentence is a real, checkable fact. Content is kid-safe: animals, space, nature, everyday science.
(function (root) {
  // fib = index of the made-up sentence (0-based). It is spread around on purpose so "always the last one" never works.
  const R = (id, topic, question, sentences, fib, truth, tip) => ({ id, topic, question, sentences, fib, truth, tip });

  const ROUNDS = [
    R('octopus', 'Animals', 'How do octopuses move around?', [
      'An octopus has eight arms.',
      'It has no bones, so it can squeeze through any gap bigger than its hard little beak.',
      'Octopuses move by flapping two big wings.',
      'An octopus has three hearts.',
      'It can also squirt water out of a funnel to zoom along.',
    ], 2, 'Octopuses have no wings at all! They crawl with their arms and squirt water to zoom along.',
      'Ask: where does an octopus live? Under water, where wings would not help much. Then check a sea-animal book.'),

    R('sun', 'Space', 'What is the Sun?', [
      'The Sun is a star.',
      'It is a giant ball of solid rock.',
      'Sunlight takes about eight minutes to reach the Earth.',
      'More than a million Earths could fit inside the Sun.',
      'Plants use sunlight to make their food.',
    ], 1, 'The Sun is a giant ball of super-hot glowing gas, not rock. Rock would melt there in a blink!',
      'Look it up in a space book or on a museum website and see what the Sun is made of.'),

    R('bees', 'Animals', 'How do bees make honey?', [
      'Bees visit flowers to collect a sweet juice called nectar.',
      'They make honey out of the leaves of trees.',
      'A bee can tell its friends where the flowers are by doing a wiggle dance.',
      'Each hive has one queen bee who lays the eggs.',
      'Bees beat their wings so fast that they make a buzzing sound.',
    ], 1, 'Honey is made from flower nectar, not leaves. Bees add special juices and let the water dry out of it.',
      'Ask a grown-up to help you check how honey is made. The word "nectar" is the clue.'),

    R('moon', 'Space', 'What is the Moon like?', [
      'The Moon travels around the Earth.',
      'The Moon is bigger than the Earth.',
      'The Moon does not make its own light. It shines by bouncing back sunlight.',
      'Astronauts have walked on the Moon.',
      'Their footprints are still there, because the Moon has no wind or rain to wipe them away.',
    ], 1, 'The Moon is much smaller than the Earth. Nearly four Moons side by side would stretch across the Earth!',
      'Compare sizes in a picture book that shows the Earth and the Moon side by side.'),

    R('penguins', 'Animals', 'Tell me about penguins!', [
      'Penguins are birds.',
      'They cannot fly in the sky, but they are brilliant swimmers.',
      'Penguins live at the North Pole, right next to the polar bears.',
      'Emperor penguin dads keep an egg warm by balancing it on their feet.',
      'Penguin feathers are packed tightly and stay waterproof.',
    ], 2, 'Penguins live mostly in the south, and polar bears live in the north. They never meet in the wild!',
      'Find a map or globe. Look at where penguins live and where polar bears live.'),

    R('rainbow', 'Weather', 'How do rainbows happen?', [
      'Rainbows appear when sunlight shines through raindrops.',
      'White sunlight is really a mix of many colours.',
      'If you walk far enough, you can reach the end of a rainbow and touch it.',
      'Red is on the outside edge of a rainbow.',
      'To see a rainbow, the Sun is usually behind you and the rain is in front.',
    ], 2, 'A rainbow is light bending in raindrops, so it is not a thing you can touch. It moves away as you walk!',
      'Think about it: could light be touched? Then ask a grown-up to help you check how rainbows form.'),

    R('giraffe', 'Animals', 'What are giraffes like?', [
      'A giraffe is the tallest animal that lives on land.',
      'A giraffe has seven neck bones, the same number as you.',
      'Giraffes sleep for twelve hours every night, curled up in a ball.',
      'A giraffe has a very long dark tongue that grabs leaves.',
      'A newborn giraffe can be about as tall as a grown-up person.',
    ], 2, 'Giraffes sleep very little, often just a few hours a day, and they usually nap standing up.',
      'If a sentence sounds odd, check it in two different places, like a book and a zoo website.'),

    R('puddle', 'Everyday science', 'Where do puddles go?', [
      'The Sun warms a puddle and the water slowly turns into invisible vapour.',
      'Turning from water into vapour is called evaporation.',
      'Puddles disappear because the water turns into bits of rock when it gets warm.',
      'Vapour floats up and cools down to help make clouds.',
      'Puddles dry up faster on a warm, windy day.',
    ], 2, 'Water does not turn into rock! It turns into vapour, which is water in the air that you cannot see.',
      'Try it! Put a little water on a plate in a sunny spot and watch it shrink over the day.'),

    R('whale', 'Animals', 'Tell me about blue whales!', [
      'The blue whale is the biggest animal we know has ever lived.',
      'Blue whales breathe underwater through gills, like fish.',
      'Blue whales eat tiny shrimp-like animals called krill.',
      'A baby blue whale drinks its mother\'s milk.',
      'A blue whale is a mammal, just like you.',
    ], 1, 'Whales are mammals, so they breathe air with lungs. They come up to the surface to blow and breathe.',
      'Ask: do fish drink milk from their mums? Whales do, and that is a clue that they are not fish.'),

    R('magnet', 'Everyday science', 'What can magnets do?', [
      'A magnet has two ends called poles.',
      'Opposite poles pull together, and matching poles push apart.',
      'A magnet can pick up a steel paper clip.',
      'Magnets stick to every metal, even aluminium cans and gold rings.',
      'The Earth acts like a giant magnet, which is why a compass works.',
    ], 3, 'Magnets only stick to some metals, like iron and steel. Aluminium and gold do not stick at all.',
      'Test it yourself with a fridge magnet and some things around the house. Which ones stick?'),

    R('frog', 'Animals', 'How does a frog grow up?', [
      'A baby frog is called a tadpole.',
      'Tadpoles live in water and breathe with gills.',
      'Frog eggs laid together are called frogspawn.',
      'A tadpole turns into a frog in just one night.',
      'As a tadpole grows, it sprouts legs and its tail slowly shrinks away.',
    ], 3, 'Turning into a frog takes weeks or even months. Bit by bit, legs grow and the tail shrinks.',
      'Look for a picture series of a frog life cycle and count how many steps it has.'),

    R('tree', 'Nature', 'What do trees do all day?', [
      'Trees take in carbon dioxide from the air.',
      'Leaves look green because of a green stuff called chlorophyll.',
      'Roots drink up water from the soil.',
      'Trees get most of their food by eating the soil with their roots.',
      'Trees give out oxygen, which we breathe.',
    ], 3, 'Trees make their own food in their leaves using sunlight, air and water. The roots mostly drink water.',
      'Plants are famous for using sunlight to make food. Does that match "eating soil"? Check a plant book.'),

    R('cat', 'Animals', 'What are cats like?', [
      'Cats can see in much dimmer light than people can.',
      'A cat\'s whiskers help it feel things that are close by.',
      'All cats are born with orange fur.',
      'A cat may sleep for twelve to sixteen hours a day.',
      'A kitten has baby teeth that fall out as it grows.',
    ], 2, 'Cats come in lots of colours: black, white, grey, stripy, spotty and orange too!',
      'Think of all the cats you have seen. Were they all orange? Checking with your own eyes counts!'),

    R('ants', 'Animals', 'How do ants work together?', [
      'An ant is an insect with six legs.',
      'An ant\'s body has three parts: head, middle and tail end.',
      'Ants leave smelly trails so that their friends can follow.',
      'An ant can carry something many times heavier than itself.',
      'Every ant colony is run by a king ant who tells everybody what to do.',
    ], 4, 'Ant colonies have a queen who lays eggs. Workers do the jobs without a boss giving orders.',
      'Search a kids\' nature site for "ant colony" and see who lives in the nest.'),
  ];

  /** Fisher-Yates on a copy so the ROUNDS table is never reordered. */
  function shuffled(arr, rand) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * Draw rounds for one play. Seeded rand means a new seed gives a new mix; no round repeats within a play.
   * @param {() => number} rand floats in [0,1)  @param {number} n how many rounds (clamped to 1..ROUNDS.length)
   * @returns {Object[]} n different rounds
   */
  function pickRounds(rand, n) {
    const count = Math.max(1, Math.min(ROUNDS.length, Math.floor(Number(n)) || 1));
    return shuffled(ROUNDS, rand).slice(0, count);
  }

  /**
   * Did the kid tap the made-up sentence?
   * @param {Object} round @param {number} idx tapped sentence index
   * @returns {{correct:boolean, fibIndex:number}} never throws; a bad index is simply not correct
   */
  function check(round, idx) {
    const fibIndex = round && Number.isInteger(round.fib) ? round.fib : -1;
    return { correct: fibIndex >= 0 && idx === fibIndex, fibIndex };
  }

  /**
   * 1 star for finishing, 2 when at least two were found on the first try, 3 when every round was.
   * @param {number} firstTryCorrect @param {number} total rounds played @returns {1|2|3}
   */
  function starsFor(firstTryCorrect, total) {
    const f = Math.max(0, Math.floor(Number(firstTryCorrect)) || 0);
    const t = Math.max(0, Math.floor(Number(total)) || 0);
    if (t > 0 && f >= t) return 3;
    return f >= 2 ? 2 : 1;
  }

  const api = { ROUNDS, pickRounds, check, starsFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AIX_FIB = api;
})(typeof window !== 'undefined' ? window : globalThis);
