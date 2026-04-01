'use strict';

const SUITS = ['s', 'h', 'd', 'c']; // spades, hearts, diamonds, clubs
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const RANK_VAL = {};
RANKS.forEach((r, i) => RANK_VAL[r] = i + 2);

// Hand rank constants (higher = better)
const HAND_RANKS = {
  HIGH_CARD: 1,
  ONE_PAIR: 2,
  TWO_PAIR: 3,
  THREE_OF_A_KIND: 4,
  STRAIGHT: 5,
  FLUSH: 6,
  FULL_HOUSE: 7,
  FOUR_OF_A_KIND: 8,
  STRAIGHT_FLUSH: 9,
  FIVE_OF_A_KIND: 10,   // NEW: below royal flush
  ROYAL_FLUSH: 11
};

const HAND_NAMES = {
  1: 'High Card',
  2: 'One Pair',
  3: 'Two Pair',
  4: 'Three of a Kind',
  5: 'Straight',
  6: 'Flush',
  7: 'Full House',
  8: 'Four of a Kind',
  9: 'Straight Flush',
  10: 'Five of a Kind',
  11: 'Royal Flush'
};

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

// Deal with replacement - unlimited duplicates
function dealCard() {
  const rank = RANKS[Math.floor(Math.random() * RANKS.length)];
  const suit = SUITS[Math.floor(Math.random() * SUITS.length)];
  return { rank, suit };
}

function dealCards(n) {
  const cards = [];
  for (let i = 0; i < n; i++) cards.push(dealCard());
  return cards;
}

function rankVal(card) {
  return RANK_VAL[card.rank];
}

// Get all 5-card combinations from an array of cards
function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, k - 1).map(c => [first, ...c]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

function evaluateHand(cards) {
  // cards: array of {rank, suit}, evaluate best 5-card hand
  if (cards.length < 5) return null;

  const combos = cards.length === 5 ? [cards] : combinations(cards, 5);
  let best = null;

  for (const combo of combos) {
    const score = scoreFive(combo);
    if (!best || compareScores(score, best) > 0) {
      best = score;
    }
  }
  return best;
}

function scoreFive(cards) {
  const vals = cards.map(rankVal).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const ranks = cards.map(c => c.rank);

  const isFlush = suits.every(s => s === suits[0]);
  const counts = {};
  for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  const countArr = Object.entries(counts)
    .map(([v, c]) => ({ v: +v, c }))
    .sort((a, b) => b.c - a.c || b.v - a.v);

  // Five of a kind (with replacement, 5 same rank)
  if (countArr[0].c === 5) {
    return { rank: HAND_RANKS.FIVE_OF_A_KIND, tiebreak: [countArr[0].v], name: HAND_NAMES[10], cards };
  }

  // Straight detection
  const uniqueVals = [...new Set(vals)].sort((a, b) => b - a);
  let isStraight = false;
  let straightHigh = 0;

  if (uniqueVals.length === 5) {
    if (uniqueVals[0] - uniqueVals[4] === 4) {
      isStraight = true;
      straightHigh = uniqueVals[0];
    }
    // Wheel: A-2-3-4-5
    if (uniqueVals[0] === 14 && uniqueVals[1] === 5 && uniqueVals[2] === 4 && uniqueVals[3] === 3 && uniqueVals[4] === 2) {
      isStraight = true;
      straightHigh = 5;
    }
  }

  // Royal flush: A-K-Q-J-10 suited
  if (isFlush && isStraight && straightHigh === 14) {
    return { rank: HAND_RANKS.ROYAL_FLUSH, tiebreak: [14], name: HAND_NAMES[11], cards };
  }

  // Straight flush
  if (isFlush && isStraight) {
    return { rank: HAND_RANKS.STRAIGHT_FLUSH, tiebreak: [straightHigh], name: HAND_NAMES[9], cards };
  }

  // Four of a kind
  if (countArr[0].c === 4) {
    return { rank: HAND_RANKS.FOUR_OF_A_KIND, tiebreak: [countArr[0].v, countArr[1].v], name: HAND_NAMES[8], cards };
  }

  // Full house
  if (countArr[0].c === 3 && countArr[1].c === 2) {
    return { rank: HAND_RANKS.FULL_HOUSE, tiebreak: [countArr[0].v, countArr[1].v], name: HAND_NAMES[7], cards };
  }

  // Flush
  if (isFlush) {
    return { rank: HAND_RANKS.FLUSH, tiebreak: vals, name: HAND_NAMES[6], cards };
  }

  // Straight
  if (isStraight) {
    return { rank: HAND_RANKS.STRAIGHT, tiebreak: [straightHigh], name: HAND_NAMES[5], cards };
  }

  // Three of a kind
  if (countArr[0].c === 3) {
    const kickers = countArr.slice(1).map(x => x.v);
    return { rank: HAND_RANKS.THREE_OF_A_KIND, tiebreak: [countArr[0].v, ...kickers], name: HAND_NAMES[4], cards };
  }

  // Two pair
  if (countArr[0].c === 2 && countArr[1].c === 2) {
    const kicker = countArr[2] ? countArr[2].v : 0;
    return { rank: HAND_RANKS.TWO_PAIR, tiebreak: [countArr[0].v, countArr[1].v, kicker], name: HAND_NAMES[3], cards };
  }

  // One pair
  if (countArr[0].c === 2) {
    const kickers = countArr.slice(1).map(x => x.v);
    return { rank: HAND_RANKS.ONE_PAIR, tiebreak: [countArr[0].v, ...kickers], name: HAND_NAMES[2], cards };
  }

  // High card
  return { rank: HAND_RANKS.HIGH_CARD, tiebreak: vals, name: HAND_NAMES[1], cards };
}

function compareScores(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.max(a.tiebreak.length, b.tiebreak.length); i++) {
    const av = a.tiebreak[i] || 0;
    const bv = b.tiebreak[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0; // tie
}

// Sit-and-go blind structure
const BLIND_LEVELS = [
  { small: 10,  big: 20,   ante: 0  },
  { small: 15,  big: 30,   ante: 0  },
  { small: 25,  big: 50,   ante: 0  },
  { small: 50,  big: 100,  ante: 0  },
  { small: 75,  big: 150,  ante: 25  },
  { small: 100, big: 200,  ante: 25  },
  { small: 150, big: 300,  ante: 50  },
  { small: 200, big: 400,  ante: 50  },
  { small: 300, big: 600,  ante: 75  },
  { small: 400, big: 800,  ante: 100 },
  { small: 500, big: 1000, ante: 150 },
  { small: 750, big: 1500, ante: 200 },
  { small: 1000,big: 2000, ante: 300 },
];

const BLIND_LEVEL_DURATION = 10 * 60 * 1000; // 10 minutes per level

module.exports = {
  dealCards,
  dealCard,
  evaluateHand,
  compareScores,
  HAND_RANKS,
  HAND_NAMES,
  BLIND_LEVELS,
  BLIND_LEVEL_DURATION,
  RANK_VAL
};
