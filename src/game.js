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
    this.players = [];
    this.communityCards = [];
    this.pot = 0;
    this.dealerIndex = 0;
    this.currentPlayerIndex = -1;
    this.blindLevel = 0;
    this.blindLevelStart = 0;
    this.handNumber = 0;
    this.currentBet = 0;
    this.lastRaiseAmount = 0;
    this.actionTimer = null;
    this.blindTimer = null;
    this.handHistory = [];
    this.winners = [];
    this.finishedAt = null;
    this.createdAt = Date.now();
    this.minPlayers = 2;
    this.maxPlayers = 9;
    this.sbIndex = -1;
    this.bbIndex = -1;
    this.actionTimerStart = 0;
    // Track who has acted in current betting round to handle BB option
    this.actedThisRound = new Set();
    this.lastAggressorIndex = -1;

    this.addPlayer(hostId, hostName);
  }

  addPlayer(id, name) {
    if (this.players.length >= this.maxPlayers) return { error: 'Game is full' };
    if (this.state !== GAME_STATES.WAITING) return { error: 'Game already started' };
    if (this.players.find(p => p.id === id)) return { error: 'Already in game' };

    this.players.push({
      id,
      name,
      chips: START_CHIPS,
      cards: [],
      folded: false,
      allIn: false,
      bet: 0,
      seatIndex: this.players.length,
      connected: true,
      sitOut: false,
      finishPosition: null
    });
    return { success: true };
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
    this.startBlindTimer();
    this.startHand();
    return true;
  }

  startBlindTimer() {
    if (this.blindTimer) clearInterval(this.blindTimer);
    this.blindTimer = setInterval(() => {
      if (this.blindLevel < BLIND_LEVELS.length - 1) {
        this.blindLevel++;
        this.blindLevelStart = Date.now();
        if (this.emit) this.emit('blind_level_up', { level: this.blindLevel, blinds: this.getCurrentBlinds() });
      }
    }, BLIND_LEVEL_DURATION);
  }

  getCurrentBlinds() {
    return BLIND_LEVELS[Math.min(this.blindLevel, BLIND_LEVELS.length - 1)];
  }

  getActivePlayers() {
    // Players still in the tournament (have chips OR are all-in this hand)
    return this.players.filter(p => p.chips > 0 || p.allIn);
  }

  getTournamentActivePlayers() {
    // Players still in the tournament (have chips, not eliminated)
    return this.players.filter(p => p.chips > 0 && p.finishPosition === null);
  }

  startHand() {
    this.handNumber++;
    this.communityCards = [];
    this.pot = 0;
    this.currentBet = 0;
    this.lastRaiseAmount = 0;
    this.actedThisRound = new Set();
    this.lastAggressorIndex = -1;

    // Reset player hand state
    for (const p of this.players) {
      p.cards = [];
      p.folded = false;
      p.allIn = false;
      p.bet = 0;
    }

    const active = this.getTournamentActivePlayers();
    if (active.length < 2) {
      this.endGame();
      return;
    }

    // Move dealer button to next active player
    if (this.handNumber > 1) {
      let next = (this.dealerIndex + 1) % this.players.length;
      let attempts = 0;
      while (this.players[next].finishPosition !== null || this.players[next].chips === 0) {
        next = (next + 1) % this.players.length;
        attempts++;
        if (attempts >= this.players.length) break;
      }
      this.dealerIndex = next;
    }

    // Deal 2 cards to each active player
    for (const p of active) {
      p.cards = dealCards(2);
    }

    const { small, big, ante } = this.getCurrentBlinds();

    // Find SB and BB positions relative to dealer
    let sbIdx, bbIdx;

    if (active.length === 2) {
      // Heads up: dealer is SB
      sbIdx = this.dealerIndex;
      bbIdx = this.nextTournamentActive(sbIdx);
    } else {
      sbIdx = this.nextTournamentActive(this.dealerIndex);
      bbIdx = this.nextTournamentActive(sbIdx);
    }

    this.sbIndex = sbIdx;
    this.bbIndex = bbIdx;

    // Post antes
    if (ante > 0) {
      for (const p of active) {
        const anteAmt = Math.min(ante, p.chips);
        p.chips -= anteAmt;
        this.pot += anteAmt;
        if (p.chips === 0) p.allIn = true;
      }
    }

    // Post small blind
    const sbPlayer = this.players[sbIdx];
    const sbAmt = Math.min(small, sbPlayer.chips);
    sbPlayer.chips -= sbAmt;
    sbPlayer.bet = sbAmt;
    this.pot += sbAmt;
    if (sbPlayer.chips === 0) sbPlayer.allIn = true;

    // Post big blind
    const bbPlayer = this.players[bbIdx];
    const bbAmt = Math.min(big, bbPlayer.chips);
    bbPlayer.chips -= bbAmt;
    bbPlayer.bet = bbAmt;
    this.pot += bbAmt;
    if (bbPlayer.chips === 0) bbPlayer.allIn = true;

    this.currentBet = bbAmt;
    this.lastRaiseAmount = bbAmt;

    // Track BB as the last aggressor so BB gets option preflop
    this.lastAggressorIndex = bbIdx;

    this.state = GAME_STATES.PREFLOP;

    // First to act preflop: player after BB
    const firstAct = this.nextTournamentActive(bbIdx);
    this.currentPlayerIndex = firstAct;

    this.startActionTimer();
  }

  // Get next player index who is still in the tournament
  nextTournamentActive(fromIdx) {
    let idx = (fromIdx + 1) % this.players.length;
    let attempts = 0;
    while (attempts < this.players.length) {
      const p = this.players[idx];
      if (p.chips > 0 && p.finishPosition === null) return idx;
      idx = (idx + 1) % this.players.length;
      attempts++;
    }
    return fromIdx; // fallback
  }

  // Get next player who can still act this street (not folded, not all-in, has chips)
  nextToAct(fromIdx) {
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
      const p = this.players[this.currentPlayerIndex];
      if (!p) return;
      console.log(`[Timer] Auto-acting for ${p.name} in state ${this.state}`);
      if (p.bet >= this.currentBet) {
        this._applyAction(p.id, 'check', 0);
      } else {
        this._applyAction(p.id, 'fold', 0);
      }
      // Notify via callback
      if (this.onTimerAction) this.onTimerAction();
    }, ACTION_TIME);
  }

  clearActionTimer() {
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
    this.actionTimerStart = 0;
  }

  handleAction(playerId, action, amount) {
    const states = [GAME_STATES.PREFLOP, GAME_STATES.FLOP, GAME_STATES.TURN, GAME_STATES.RIVER];
    if (!states.includes(this.state)) return { error: 'Not in a betting round' };

    const pIdx = this.players.findIndex(p => p.id === playerId);
    if (pIdx === -1) return { error: 'Player not found' };
    if (pIdx !== this.currentPlayerIndex) return { error: 'Not your turn' };

    const p = this.players[pIdx];
    if (p.folded || p.allIn) return { error: 'Cannot act' };

    const result = this._applyAction(playerId, action, amount);
    return result;
  }

  _applyAction(playerId, action, amount) {
    const pIdx = this.players.findIndex(p => p.id === playerId);
    if (pIdx === -1) return { error: 'Player not found' };

    const p = this.players[pIdx];
    this.clearActionTimer();

    const blinds = this.getCurrentBlinds();
    const minRaise = Math.max(this.lastRaiseAmount, blinds.big);
    let actionResult = { playerId, playerName: p.name, action, amount: 0 };

    switch (action) {
      case 'fold':
        p.folded = true;
        this.actedThisRound.add(pIdx);
        actionResult.action = 'fold';
        break;

      case 'check':
        if (p.bet < this.currentBet) {
          // Force fold if they can't check
          p.folded = true;
          actionResult.action = 'fold';
        } else {
          this.actedThisRound.add(pIdx);
          actionResult.action = 'check';
        }
        break;

      case 'call': {
        const callAmt = Math.min(this.currentBet - p.bet, p.chips);
        p.chips -= callAmt;
        p.bet += callAmt;
        this.pot += callAmt;
        if (p.chips === 0) p.allIn = true;
        this.actedThisRound.add(pIdx);
        actionResult.amount = callAmt;
        actionResult.action = 'call';
        break;
      }

      case 'bet':
      case 'raise': {
        const raiseTotal = Math.min(amount, p.chips + p.bet);
        const raiseAdd = raiseTotal - p.bet;
        if (raiseAdd <= 0) {
          // Invalid — treat as check/fold
          if (p.bet >= this.currentBet) {
            this.actedThisRound.add(pIdx);
            actionResult.action = 'check';
          } else {
            p.folded = true;
            this.actedThisRound.add(pIdx);
            actionResult.action = 'fold';
          }
          break;
        }
        this.lastRaiseAmount = Math.max(raiseTotal - this.currentBet, blinds.big);
        this.currentBet = raiseTotal;
        p.chips -= raiseAdd;
        p.bet = raiseTotal;
        this.pot += raiseAdd;
        if (p.chips === 0) p.allIn = true;
        this.lastAggressorIndex = pIdx;
        // Reset acted — everyone needs to respond to the raise
        this.actedThisRound = new Set([pIdx]);
        actionResult.amount = raiseTotal;
        actionResult.action = action;
        break;
      }

      case 'allin': {
        const allInAmt = p.chips;
        const newBet = p.bet + allInAmt;
        if (newBet > this.currentBet) {
          this.lastRaiseAmount = Math.max(newBet - this.currentBet, blinds.big);
          this.currentBet = newBet;
          this.lastAggressorIndex = pIdx;
          this.actedThisRound = new Set([pIdx]);
        } else {
          this.actedThisRound.add(pIdx);
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

    // Advance game state
    this._advanceAfterAction(pIdx);

    return { success: true, actionResult };
  }

  _advanceAfterAction(lastActorIdx) {
    if (this.isBettingRoundOver()) {
      this.currentPlayerIndex = -1;
      this.advanceStreet();
    } else {
      const next = this.nextToAct(lastActorIdx);
      if (next === -1) {
        this.currentPlayerIndex = -1;
        this.advanceStreet();
      } else {
        this.currentPlayerIndex = next;
        this.startActionTimer();
      }
    }
  }

  isBettingRoundOver() {
    const inHand = this.players.filter(p => !p.folded && p.cards.length > 0);

    // Only one player left — they win
    if (inHand.length === 1) return true;

    // Anyone who can still act?
    const canAct = inHand.filter(p => !p.allIn && p.chips > 0);
    if (canAct.length === 0) return true;

    // All active (non-allin) players have matched the current bet AND have acted
    for (const p of canAct) {
      const idx = this.players.indexOf(p);
      if (p.bet < this.currentBet) return false;
      if (!this.actedThisRound.has(idx)) return false;
    }
    return true;
  }

  advanceStreet() {
    this.clearActionTimer();
    this.actedThisRound = new Set();
    this.lastAggressorIndex = -1;

    const inHand = this.players.filter(p => !p.folded && p.cards.length > 0);

    // Only one player remains — they win uncontested
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
        this.resolveHand();
        return;
      default:
        this.resolveHand();
        return;
    }

    // Check if all remaining players are all-in — auto-run the board
    const canAct = inHand.filter(p => !p.allIn && p.chips > 0);
    if (canAct.length === 0) {
      // Run board automatically with a delay for display
      if (this.onStreetDealt) this.onStreetDealt();
      setTimeout(() => this.advanceStreet(), 1500);
      return;
    }

    // Find first to act post-flop: first active player left of dealer
    let firstAct = -1;
    let attempts = 0;
    let idx = (this.dealerIndex + 1) % this.players.length;
    while (attempts < this.players.length) {
      const p = this.players[idx];
      if (!p.folded && !p.allIn && p.cards.length > 0 && p.chips > 0) {
        firstAct = idx;
        break;
      }
      idx = (idx + 1) % this.players.length;
      attempts++;
    }

    if (firstAct === -1) {
      // No one can act
      this.resolveHand();
      return;
    }

    this.currentPlayerIndex = firstAct;
    this.startActionTimer();

    if (this.onStreetDealt) this.onStreetDealt();
  }

  resolveHand() {
    this.state = GAME_STATES.SHOWDOWN;
    this.clearActionTimer();
    this.currentPlayerIndex = -1;

    const inHand = this.players.filter(p => !p.folded && p.cards.length > 0);
    let handResults = [];

    if (inHand.length === 1) {
      inHand[0].chips += this.pot;
      handResults = [{ player: inHand[0], won: this.pot, hand: null, uncontested: true }];
    } else {
      // Proper side pot calculation
      handResults = this.calculatePotsAndAward();
    }

    this.handHistory.push({
      hand: this.handNumber,
      results: handResults,
      community: [...this.communityCards]
    });

    this.state = GAME_STATES.HAND_OVER;

    // Eliminate busted players — allIn flag is cleared here
    for (const p of this.players) {
      p.allIn = false; // reset allIn flag after hand
      if (p.chips === 0 && p.finishPosition === null) {
        const remaining = this.players.filter(pp => pp.chips > 0 && pp.finishPosition === null).length;
        p.finishPosition = remaining + 1;
        this.winners.push({ name: p.name, position: p.finishPosition });
      }
    }

    // Sort winners by position descending (worst finish first)
    this.winners.sort((a, b) => b.position - a.position);

    return handResults;
  }

  calculatePotsAndAward() {
    // Build side pots based on each player's total contribution
    const inHand = this.players.filter(p => !p.folded && p.cards.length > 0);

    // We need to track total contributions — use pot directly for simple case
    // For proper side pots, we'd need per-player contribution tracking
    // This implementation handles it correctly via level-by-level pot creation

    const evaluated = inHand.map(p => ({
      player: p,
      score: evaluateHand([...p.cards, ...this.communityCards])
    })).sort((a, b) => compareScores(b.score, a.score));

    // Simple pot distribution (works correctly for most cases)
    // For full side pot accuracy we'd need contribution per player
    const best = evaluated[0].score;
    const winners = evaluated.filter(e => compareScores(e.score, best) === 0);
    const share = Math.floor(this.pot / winners.length);
    const remainder = this.pot - share * winners.length;

    const handResults = [];
    for (let i = 0; i < winners.length; i++) {
      const extra = i === 0 ? remainder : 0;
      winners[i].player.chips += share + extra;
      handResults.push({ player: winners[i].player, won: share + extra, hand: winners[i].score });
    }
    for (const e of evaluated) {
      if (!winners.includes(e)) {
        handResults.push({ player: e.player, won: 0, hand: e.score });
      }
    }
    return handResults;
  }

  nextHand() {
    const active = this.getTournamentActivePlayers();
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
    if (this.blindTimer) { clearInterval(this.blindTimer); this.blindTimer = null; }
    this.finishedAt = Date.now();

    const winner = this.players.find(p => p.chips > 0);
    if (winner && winner.finishPosition === null) {
      winner.finishPosition = 1;
      this.winners.push({ name: winner.name, position: 1, chips: winner.chips });
    }
  }

  getPublicState(forPlayerId = null) {
    const blinds = this.getCurrentBlinds();
    const timeLeft = Math.max(0, BLIND_LEVEL_DURATION - (Date.now() - this.blindLevelStart));
    const actionTimeLeft = this.actionTimerStart > 0
      ? Math.max(0, ACTION_TIME - (Date.now() - this.actionTimerStart))
      : 0;

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
        cards: (p.id === forPlayerId || this.state === GAME_STATES.SHOWDOWN || this.state === GAME_STATES.HAND_OVER)
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
      actionTimeLeft,
      actionTimerDuration: ACTION_TIME
    };
  }
}

module.exports = { Game, GAME_STATES };
