'use strict';

const { dealCards, evaluateHand, compareScores, BLIND_LEVELS, BLIND_LEVEL_DURATION } = require('./poker');

const GAME_STATES = {
  WAITING: 'waiting',
  STARTING: 'starting',
  PREFLOP: 'preflop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown',
  HAND_OVER: 'hand_over',
  GAME_OVER: 'game_over'
};

const ACTION_TIME = 30000; // 30 seconds per action
const START_CHIPS = 1500;

class Game {
  constructor(id, hostId, hostName) {
    this.id = id;
    this.hostId = hostId;
    this.state = GAME_STATES.WAITING;
    this.players = []; // {id, name, chips, cards, folded, allIn, bet, seatIndex, connected, sitOut}
    this.spectators = [];
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.dealerIndex = 0; // seat index of dealer
    this.currentPlayerIndex = -1;
    this.blindLevel = 0;
    this.blindLevelStart = 0;
    this.handNumber = 0;
    this.currentBet = 0;
    this.lastRaiseAmount = 0;
    this.actionTimer = null;
    this.blindTimer = null;
    this.handHistory = [];
    this.winners = []; // final tournament results
    this.finishedAt = null;
    this.createdAt = Date.now();
    this.minPlayers = 2;
    this.maxPlayers = 9;

    // Add host as first player
    this.addPlayer(hostId, hostName);
  }

  addPlayer(id, name) {
    if (this.players.length >= this.maxPlayers) return { error: 'Game is full' };
    if (this.state !== GAME_STATES.WAITING) return { error: 'Game already started' };
    if (this.players.find(p => p.id === id)) return { error: 'Already in game' };

    const seatIndex = this.players.length;
    this.players.push({
      id,
      name,
      chips: START_CHIPS,
      cards: [],
      folded: false,
      allIn: false,
      bet: 0,
      seatIndex,
      connected: true,
      sitOut: false,
      finishPosition: null
    });
    return { success: true };
  }

  removePlayer(id) {
    if (this.state !== GAME_STATES.WAITING) return false;
    const idx = this.players.findIndex(p => p.id === id);
    if (idx === -1) return false;
    this.players.splice(idx, 1);
    // Re-index seats
    this.players.forEach((p, i) => p.seatIndex = i);
    return true;
  }

  setConnected(id, connected) {
    const p = this.players.find(p => p.id === id);
    if (p) p.connected = connected;
  }

  canStart() {
    return this.players.length >= this.minPlayers && this.state === GAME_STATES.WAITING;
  }

  startGame() {
    if (!this.canStart()) return false;
    this.state = GAME_STATES.STARTING;
    this.blindLevel = 0;
    this.blindLevelStart = Date.now();
    this.dealerIndex = Math.floor(Math.random() * this.players.length);
    this.startHand();
    this.startBlindTimer();
    return true;
  }

  startBlindTimer() {
    if (this.blindTimer) clearInterval(this.blindTimer);
    this.blindTimer = setInterval(() => {
      if (this.blindLevel < BLIND_LEVELS.length - 1) {
        this.blindLevel++;
        this.blindLevelStart = Date.now();
        this.emit && this.emit('blind_level_up', { level: this.blindLevel, blinds: this.getCurrentBlinds() });
      }
    }, BLIND_LEVEL_DURATION);
  }

  getCurrentBlinds() {
    return BLIND_LEVELS[Math.min(this.blindLevel, BLIND_LEVELS.length - 1)];
  }

  getActivePlayers() {
    return this.players.filter(p => p.chips > 0 || p.allIn);
  }

  getPlayersInHand() {
    return this.players.filter(p => !p.folded && (p.chips > 0 || p.allIn) && p.cards.length > 0);
  }

  startHand() {
    this.handNumber++;
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.currentBet = 0;
    this.lastRaiseAmount = 0;

    // Reset player states
    for (const p of this.players) {
      p.cards = [];
      p.folded = false;
      p.allIn = false;
      p.bet = 0;
    }

    const active = this.getActivePlayers();
    if (active.length < 2) {
      this.endGame();
      return;
    }

    // Move dealer button to next active player
    if (this.handNumber > 1) {
      let next = (this.dealerIndex + 1) % this.players.length;
      let attempts = 0;
      while (this.players[next].chips === 0 && attempts < this.players.length) {
        next = (next + 1) % this.players.length;
        attempts++;
      }
      this.dealerIndex = next;
    }

    // Deal 2 cards to each active player
    for (const p of active) {
      p.cards = dealCards(2);
    }

    // Post blinds
    const { small, big, ante } = this.getCurrentBlinds();
    const activeSorted = this.getActivePlayers();

    // Find SB and BB positions relative to dealer
    let sbIdx = this.getNextActiveIndex(this.dealerIndex);
    let bbIdx = this.getNextActiveIndex(sbIdx);

    // Heads up: dealer is SB
    if (activeSorted.length === 2) {
      sbIdx = this.dealerIndex;
      bbIdx = this.getNextActiveIndex(sbIdx);
    }

    const sbPlayer = this.players[sbIdx];
    const bbPlayer = this.players[bbIdx];

    // Post antes
    if (ante > 0) {
      for (const p of activeSorted) {
        const anteAmt = Math.min(ante, p.chips);
        p.chips -= anteAmt;
        this.pot += anteAmt;
        if (p.chips === 0) p.allIn = true;
      }
    }

    // Post small blind
    const sbAmt = Math.min(small, sbPlayer.chips);
    sbPlayer.chips -= sbAmt;
    sbPlayer.bet = sbAmt;
    this.pot += sbAmt;
    if (sbPlayer.chips === 0) sbPlayer.allIn = true;

    // Post big blind
    const bbAmt = Math.min(big, bbPlayer.chips);
    bbPlayer.chips -= bbAmt;
    bbPlayer.bet = bbAmt;
    this.pot += bbAmt;
    if (bbPlayer.chips === 0) bbPlayer.allIn = true;

    this.currentBet = bbAmt;
    this.lastRaiseAmount = bbAmt;

    // First to act preflop: player after BB
    this.state = GAME_STATES.PREFLOP;
    let firstAct = this.getNextActiveIndex(bbIdx);
    this.currentPlayerIndex = firstAct;

    // Store positions for reference
    this.sbIndex = sbIdx;
    this.bbIndex = bbIdx;

    this.startActionTimer();
  }

  getNextActiveIndex(fromIdx) {
    let idx = (fromIdx + 1) % this.players.length;
    let attempts = 0;
    while ((this.players[idx].chips === 0 && !this.players[idx].allIn) || 
           this.players[idx].folded ||
           this.players[idx].cards.length === 0) {
      idx = (idx + 1) % this.players.length;
      attempts++;
      if (attempts >= this.players.length) break;
    }
    return idx;
  }

  getNextToAct(fromIdx) {
    // Get next player who needs to act (not folded, not all-in, has chips)
    let idx = (fromIdx + 1) % this.players.length;
    let attempts = 0;
    while (attempts < this.players.length) {
      const p = this.players[idx];
      if (!p.folded && !p.allIn && p.cards.length > 0 && p.chips > 0) {
        return idx;
      }
      idx = (idx + 1) % this.players.length;
      attempts++;
    }
    return -1;
  }

  startActionTimer() {
    this.clearActionTimer();
    this.actionTimerStart = Date.now();
    this.actionTimer = setTimeout(() => {
      // Auto-fold or check on timeout
      const p = this.players[this.currentPlayerIndex];
      if (!p) return;
      if (p.bet >= this.currentBet) {
        this.handleAction(p.id, 'check', 0);
      } else {
        this.handleAction(p.id, 'fold', 0);
      }
    }, ACTION_TIME);
  }

  clearActionTimer() {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
  }

  handleAction(playerId, action, amount) {
    if (this.state === GAME_STATES.HAND_OVER || this.state === GAME_STATES.GAME_OVER) return { error: 'Hand over' };

    const pIdx = this.players.findIndex(p => p.id === playerId);
    if (pIdx === -1) return { error: 'Player not found' };
    if (pIdx !== this.currentPlayerIndex) return { error: 'Not your turn' };

    const p = this.players[pIdx];
    if (p.folded || p.allIn) return { error: 'Cannot act' };

    this.clearActionTimer();

    const blinds = this.getCurrentBlinds();
    const minRaise = Math.max(this.lastRaiseAmount, blinds.big);

    let actionResult = { playerId, playerName: p.name, action, amount: 0 };

    switch (action) {
      case 'fold':
        p.folded = true;
        actionResult.action = 'fold';
        break;

      case 'check':
        if (p.bet < this.currentBet) return { error: 'Cannot check, must call or raise' };
        actionResult.action = 'check';
        break;

      case 'call': {
        const callAmt = Math.min(this.currentBet - p.bet, p.chips);
        p.chips -= callAmt;
        p.bet += callAmt;
        this.pot += callAmt;
        if (p.chips === 0) p.allIn = true;
        actionResult.amount = callAmt;
        actionResult.action = 'call';
        break;
      }

      case 'bet':
      case 'raise': {
        // amount = total bet size
        const raiseTotal = Math.min(amount, p.chips + p.bet);
        const raiseAdd = raiseTotal - p.bet;
        if (raiseAdd <= 0) return { error: 'Invalid raise amount' };
        if (raiseTotal < this.currentBet + minRaise && raiseAdd < p.chips) {
          return { error: `Minimum raise to ${this.currentBet + minRaise}` };
        }
        this.lastRaiseAmount = raiseTotal - this.currentBet;
        this.currentBet = raiseTotal;
        p.chips -= raiseAdd;
        p.bet = raiseTotal;
        this.pot += raiseAdd;
        if (p.chips === 0) p.allIn = true;
        actionResult.amount = raiseTotal;
        actionResult.action = action;
        break;
      }

      case 'allin': {
        const allInAmt = p.chips;
        const newBet = p.bet + allInAmt;
        if (newBet > this.currentBet) {
          this.lastRaiseAmount = Math.max(this.lastRaiseAmount, newBet - this.currentBet);
          this.currentBet = newBet;
        }
        p.bet = newBet;
        this.pot += allInAmt;
        p.chips = 0;
        p.allIn = true;
        actionResult.amount = newBet;
        actionResult.action = 'allin';
        break;
      }

      default:
        return { error: 'Unknown action' };
    }

    // Check if betting round is over
    if (this.isBettingRoundOver()) {
      this.advanceStreet();
    } else {
      this.currentPlayerIndex = this.getNextToAct(pIdx);
      if (this.currentPlayerIndex === -1) {
        this.advanceStreet();
      } else {
        this.startActionTimer();
      }
    }

    return { success: true, actionResult };
  }

  isBettingRoundOver() {
    const inHand = this.players.filter(p => !p.folded && p.cards.length > 0);
    
    // Only one player left
    if (inHand.length === 1) return true;
    
    // All but one all-in
    const canAct = inHand.filter(p => !p.allIn && p.chips > 0);
    if (canAct.length === 0) return true;
    if (canAct.length === 1 && canAct[0].bet >= this.currentBet) return true;

    // Everyone has acted and bets are equal
    const allMatched = inHand.every(p => p.allIn || p.bet === this.currentBet);
    return allMatched;
  }

  advanceStreet() {
    this.clearActionTimer();

    const inHand = this.players.filter(p => !p.folded && p.cards.length > 0);
    
    // If only one player, they win
    if (inHand.length === 1) {
      this.resolveHand();
      return;
    }

    // Reset bets for new street
    for (const p of this.players) p.bet = 0;
    this.currentBet = 0;
    this.lastRaiseAmount = this.getCurrentBlinds().big;

    switch (this.state) {
      case GAME_STATES.PREFLOP:
        this.communityCards = dealCards(3);
        this.state = GAME_STATES.FLOP;
        break;
      case GAME_STATES.FLOP:
        this.communityCards.push(...dealCards(1));
        this.state = GAME_STATES.TURN;
        break;
      case GAME_STATES.TURN:
        this.communityCards.push(...dealCards(1));
        this.state = GAME_STATES.RIVER;
        break;
      case GAME_STATES.RIVER:
        this.state = GAME_STATES.SHOWDOWN;
        this.resolveHand();
        return;
    }

    // Check if all remaining players are all-in — run out board
    const canAct = inHand.filter(p => !p.allIn && p.chips > 0);
    if (canAct.length <= 1) {
      // Auto-advance to showdown
      setTimeout(() => this.advanceStreet(), 1500);
      return;
    }

    // First to act post-flop: first active player left of dealer
    let firstAct = this.getNextActiveIndex(this.dealerIndex - 1);
    // Skip folded / all-in
    let attempts = 0;
    while ((this.players[firstAct].folded || this.players[firstAct].allIn || this.players[firstAct].chips === 0) && attempts < this.players.length) {
      firstAct = (firstAct + 1) % this.players.length;
      attempts++;
    }
    this.currentPlayerIndex = firstAct;
    this.startActionTimer();
  }

  calculateSidePots() {
    const inHand = this.players.filter(p => !p.folded && p.cards.length > 0);
    // For simplicity, handle main pot (full side pot calc is complex)
    // A proper implementation tracks contributions per player
    return [{ amount: this.pot, eligible: inHand.map(p => p.id) }];
  }

  resolveHand() {
    this.state = GAME_STATES.SHOWDOWN;
    this.clearActionTimer();

    const inHand = this.players.filter(p => !p.folded && p.cards.length > 0);

    let handResults = [];
    if (inHand.length === 1) {
      // Uncontested win
      inHand[0].chips += this.pot;
      handResults = [{ player: inHand[0], won: this.pot, hand: null, uncontested: true }];
    } else {
      // Evaluate hands
      const evaluated = inHand.map(p => ({
        player: p,
        score: evaluateHand([...p.cards, ...this.communityCards])
      }));

      evaluated.sort((a, b) => compareScores(b.score, a.score));
      
      // Simple pot split (handles ties)
      const best = evaluated[0].score;
      const winners = evaluated.filter(e => compareScores(e.score, best) === 0);
      const share = Math.floor(this.pot / winners.length);
      const remainder = this.pot - share * winners.length;

      for (let i = 0; i < winners.length; i++) {
        const extra = i === 0 ? remainder : 0;
        winners[i].player.chips += share + extra;
        handResults.push({ player: winners[i].player, won: share + extra, hand: winners[i].score });
      }
      // Add losers
      for (const e of evaluated) {
        if (!winners.includes(e)) {
          handResults.push({ player: e.player, won: 0, hand: e.score });
        }
      }
    }

    this.handHistory.push({ hand: this.handNumber, results: handResults, community: [...this.communityCards] });
    this.state = GAME_STATES.HAND_OVER;

    // Eliminate busted players
    for (const p of this.players) {
      if (p.chips === 0 && !p.allIn) {
        if (p.finishPosition === null) {
          p.finishPosition = this.players.filter(pp => pp.chips > 0).length + 1;
          this.winners.unshift({ name: p.name, position: p.finishPosition });
        }
      }
    }

    return handResults;
  }

  nextHand() {
    const active = this.players.filter(p => p.chips > 0);
    if (active.length < 2) {
      this.endGame();
      return false;
    }
    this.startHand();
    return true;
  }

  endGame() {
    this.state = GAME_STATES.GAME_OVER;
    this.clearActionTimer();
    if (this.blindTimer) clearInterval(this.blindTimer);
    this.finishedAt = Date.now();
    
    // Record winner
    const winner = this.players.find(p => p.chips > 0);
    if (winner && winner.finishPosition === null) {
      winner.finishPosition = 1;
      this.winners.unshift({ name: winner.name, position: 1, chips: winner.chips });
    }
  }

  getPublicState(forPlayerId = null) {
    const blinds = this.getCurrentBlinds();
    const timeLeft = Math.max(0, BLIND_LEVEL_DURATION - (Date.now() - this.blindLevelStart));
    
    return {
      id: this.id,
      state: this.state,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        bet: p.bet,
        folded: p.folded,
        allIn: p.allIn,
        seatIndex: p.seatIndex,
        connected: p.connected,
        finishPosition: p.finishPosition,
        // Only show cards to the player themselves (or at showdown)
        cards: (p.id === forPlayerId || this.state === GAME_STATES.SHOWDOWN)
          ? p.cards
          : p.cards.map(() => ({ rank: '?', suit: '?' })),
        hasCards: p.cards.length > 0
      })),
      communityCards: this.communityCards,
      pot: this.pot,
      currentBet: this.currentBet,
      dealerIndex: this.dealerIndex,
      currentPlayerIndex: this.currentPlayerIndex,
      sbIndex: this.sbIndex,
      bbIndex: this.bbIndex,
      handNumber: this.handNumber,
      blindLevel: this.blindLevel,
      blinds: { small: blinds.small, big: blinds.big, ante: blinds.ante },
      blindTimeLeft: timeLeft,
      hostId: this.hostId,
      winners: this.winners,
      actionTimeLeft: this.actionTimerStart ? Math.max(0, ACTION_TIME - (Date.now() - this.actionTimerStart)) : 0,
      actionTimerDuration: ACTION_TIME
    };
  }

  getCallAmount(playerId) {
    const p = this.players.find(p => p.id === playerId);
    if (!p) return 0;
    return Math.min(this.currentBet - p.bet, p.chips);
  }

  getMinRaise(playerId) {
    const p = this.players.find(p => p.id === playerId);
    if (!p) return 0;
    const blinds = this.getCurrentBlinds();
    const minRaise = Math.max(this.lastRaiseAmount, blinds.big);
    return Math.min(this.currentBet + minRaise, p.chips + p.bet);
  }
}

module.exports = { Game, GAME_STATES };
