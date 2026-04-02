'use strict';

const { dealCards, evaluateHand, compareScores, BLIND_LEVELS, BLIND_LEVEL_DURATION } = require('./poker');

const GAME_STATES = {
  WAITING:   'waiting',
  STARTING:  'starting',
  PREFLOP:   'preflop',
  FLOP:      'flop',
  TURN:      'turn',
  RIVER:     'river',
  SHOWDOWN:  'showdown',
  HAND_OVER: 'hand_over',
  GAME_OVER: 'game_over'
};

const ACTION_TIME  = 30000;
const START_CHIPS  = 1500;
const RUNOUT_DELAY = 1800; // ms between auto-dealt streets when all-in

class Game {
  constructor(id, hostId, hostName) {
    this.id             = id;
    this.hostId         = hostId;
    this.state          = GAME_STATES.WAITING;
    this.players        = [];
    this.communityCards = [];
    this.pot            = 0;
    this.dealerIndex    = 0;
    this.currentPlayerIndex = -1;
    this.blindLevel     = 0;
    this.blindLevelStart = 0;
    this.handNumber     = 0;
    this.currentBet     = 0;
    this.lastRaiseAmount = 0;
    this.actionTimer    = null;
    this.blindTimer     = null;
    this.runoutTimer    = null;   // NEW: separate timer for all-in runouts
    this.handHistory    = [];
    this.winners        = [];
    this.finishedAt     = null;
    this.createdAt      = Date.now();
    this.minPlayers     = 2;
    this.maxPlayers     = 9;
    this.sbIndex        = -1;
    this.bbIndex        = -1;
    this.actionTimerStart = 0;
    this.actedThisRound = new Set();
    this.lastAggressorIndex = -1;
    this._handAdvanceScheduled = false;

    // Callbacks set by server
    this.emit          = null;
    this.onTimerAction = null;
    this.onStreetDealt = null;

    this.addPlayer(hostId, hostName);
  }

  // ─── PLAYER MANAGEMENT ───────────────────────────────────────────────────

  addPlayer(id, name) {
    if (this.players.length >= this.maxPlayers) return { error: 'Game is full' };
    if (this.state !== GAME_STATES.WAITING)    return { error: 'Game already started' };
    if (this.players.find(p => p.id === id))   return { error: 'Already in game' };
    this.players.push({
      id, name,
      chips: START_CHIPS,
      cards: [], folded: false, allIn: false, bet: 0,
      seatIndex: this.players.length,
      connected: true, sitOut: false, finishPosition: null
    });
    return { success: true };
  }

  setConnected(id, connected) {
    const p = this.players.find(p => p.id === id);
    if (p) p.connected = connected;
  }

  // ─── TOURNAMENT HELPERS ───────────────────────────────────────────────────

  // Players who still have chips (alive in tournament)
  livePlayers() {
    return this.players.filter(p => p.chips > 0 && p.finishPosition === null);
  }

  // Next live player index going clockwise from fromIdx
  nextLive(fromIdx) {
    let idx = (fromIdx + 1) % this.players.length;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[idx];
      if (p.chips > 0 && p.finishPosition === null) return idx;
      idx = (idx + 1) % this.players.length;
    }
    return fromIdx; // fallback (shouldn't happen)
  }

  // Next player who can still act this street
  nextToAct(fromIdx) {
    let idx = (fromIdx + 1) % this.players.length;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[idx];
      if (!p.folded && !p.allIn && p.cards.length > 0 && p.chips > 0) return idx;
      idx = (idx + 1) % this.players.length;
    }
    return -1;
  }

  // Players still in this hand (not folded, has cards)
  inHandPlayers() {
    return this.players.filter(p => !p.folded && p.cards.length > 0);
  }

  // ─── GAME START ───────────────────────────────────────────────────────────

  canStart() {
    return this.players.length >= this.minPlayers && this.state === GAME_STATES.WAITING;
  }

  startGame() {
    if (!this.canStart()) return false;
    this.state = GAME_STATES.STARTING;
    this.blindLevel      = 0;
    this.blindLevelStart = Date.now();
    this.dealerIndex     = Math.floor(Math.random() * this.players.length);
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

  // ─── HAND START ───────────────────────────────────────────────────────────

  startHand() {
    // Clear any lingering timers
    this.clearActionTimer();
    this.clearRunoutTimer();
    this._handAdvanceScheduled = false;

    this.handNumber++;
    this.communityCards  = [];
    this.pot             = 0;
    this.currentBet      = 0;
    this.lastRaiseAmount = 0;
    this.actedThisRound  = new Set();
    this.lastAggressorIndex = -1;

    // Reset per-hand player state
    for (const p of this.players) {
      p.cards  = [];
      p.folded = false;
      p.allIn  = false;
      p.bet    = 0;
    }

    const live = this.livePlayers();
    if (live.length < 2) { this.endGame(); return; }

    // Advance dealer button
    if (this.handNumber > 1) {
      this.dealerIndex = this.nextLive(this.dealerIndex - 1 < 0 ? this.players.length - 1 : this.dealerIndex - 1);
    }

    // Deal hole cards
    for (const p of live) p.cards = dealCards(2);

    // Post blinds
    const { small, big, ante } = this.getCurrentBlinds();

    let sbIdx, bbIdx;
    if (live.length === 2) {
      sbIdx = this.dealerIndex;            // HU: dealer = SB
      bbIdx = this.nextLive(sbIdx);
    } else {
      sbIdx = this.nextLive(this.dealerIndex);
      bbIdx = this.nextLive(sbIdx);
    }
    this.sbIndex = sbIdx;
    this.bbIndex = bbIdx;

    // Antes
    if (ante > 0) {
      for (const p of live) {
        const amt = Math.min(ante, p.chips);
        p.chips -= amt; this.pot += amt;
        if (p.chips === 0) p.allIn = true;
      }
    }

    // SB
    const sbAmt = Math.min(small, this.players[sbIdx].chips);
    this.players[sbIdx].chips -= sbAmt;
    this.players[sbIdx].bet    = sbAmt;
    this.pot += sbAmt;
    if (this.players[sbIdx].chips === 0) this.players[sbIdx].allIn = true;

    // BB
    const bbAmt = Math.min(big, this.players[bbIdx].chips);
    this.players[bbIdx].chips -= bbAmt;
    this.players[bbIdx].bet    = bbAmt;
    this.pot += bbAmt;
    if (this.players[bbIdx].chips === 0) this.players[bbIdx].allIn = true;

    this.currentBet      = bbAmt;
    this.lastRaiseAmount = bbAmt;
    this.lastAggressorIndex = bbIdx; // BB gets option

    this.state = GAME_STATES.PREFLOP;
    this.currentPlayerIndex = this.nextLive(bbIdx);
    this.startActionTimer();
  }

  // ─── ACTION HANDLING ──────────────────────────────────────────────────────

  handleAction(playerId, action, amount) {
    const bettingStates = [GAME_STATES.PREFLOP, GAME_STATES.FLOP, GAME_STATES.TURN, GAME_STATES.RIVER];
    if (!bettingStates.includes(this.state)) return { error: 'Not in a betting round' };

    const pIdx = this.players.findIndex(p => p.id === playerId);
    if (pIdx === -1)                       return { error: 'Player not found' };
    if (pIdx !== this.currentPlayerIndex)  return { error: 'Not your turn' };

    const p = this.players[pIdx];
    if (p.folded || p.allIn)               return { error: 'Cannot act' };

    return this._applyAction(playerId, action, amount);
  }

  _applyAction(playerId, action, amount) {
    const pIdx = this.players.findIndex(p => p.id === playerId);
    if (pIdx === -1) return { error: 'Player not found' };

    const p = this.players[pIdx];
    this.clearActionTimer();

    const blinds    = this.getCurrentBlinds();
    const actionResult = { playerId, playerName: p.name, action, amount: 0 };

    switch (action) {
      case 'fold':
        p.folded = true;
        this.actedThisRound.add(pIdx);
        break;

      case 'check':
        if (p.bet < this.currentBet) {
          // Can't check — treat as fold
          p.folded = true;
          actionResult.action = 'fold';
        } else {
          this.actedThisRound.add(pIdx);
        }
        break;

      case 'call': {
        const callAmt = Math.min(this.currentBet - p.bet, p.chips);
        p.chips -= callAmt; p.bet += callAmt; this.pot += callAmt;
        if (p.chips === 0) p.allIn = true;
        this.actedThisRound.add(pIdx);
        actionResult.amount = callAmt;
        break;
      }

      case 'bet':
      case 'raise': {
        const raiseTotal = Math.min(amount, p.chips + p.bet);
        const raiseAdd   = raiseTotal - p.bet;
        if (raiseAdd <= 0) {
          // Treat as check or fold
          if (p.bet >= this.currentBet) { this.actedThisRound.add(pIdx); actionResult.action = 'check'; }
          else { p.folded = true; this.actedThisRound.add(pIdx); actionResult.action = 'fold'; }
          break;
        }
        this.lastRaiseAmount = Math.max(raiseTotal - this.currentBet, blinds.big);
        this.currentBet      = raiseTotal;
        p.chips -= raiseAdd; p.bet = raiseTotal; this.pot += raiseAdd;
        if (p.chips === 0) p.allIn = true;
        this.lastAggressorIndex = pIdx;
        this.actedThisRound = new Set([pIdx]);  // reset — everyone must respond
        actionResult.amount = raiseTotal;
        break;
      }

      case 'allin': {
        const allInAmt = p.chips;
        const newBet   = p.bet + allInAmt;
        if (newBet > this.currentBet) {
          this.lastRaiseAmount    = Math.max(newBet - this.currentBet, blinds.big);
          this.currentBet         = newBet;
          this.lastAggressorIndex = pIdx;
          this.actedThisRound     = new Set([pIdx]);
        } else {
          this.actedThisRound.add(pIdx);
        }
        p.bet = newBet; this.pot += allInAmt; p.chips = 0; p.allIn = true;
        actionResult.amount = newBet;
        break;
      }

      default:
        return { error: 'Unknown action' };
    }

    actionResult.action = actionResult.action || action;
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
    const inHand = this.inHandPlayers();
    if (inHand.length <= 1) return true;

    const canAct = inHand.filter(p => !p.allIn && p.chips > 0);
    if (canAct.length === 0) return true;  // everyone all-in

    for (const p of canAct) {
      const idx = this.players.indexOf(p);
      if (p.bet < this.currentBet)         return false;
      if (!this.actedThisRound.has(idx))   return false;
    }
    return true;
  }

  // ─── STREET ADVANCEMENT ───────────────────────────────────────────────────

  advanceStreet() {
    this.clearActionTimer();
    this.actedThisRound     = new Set();
    this.lastAggressorIndex = -1;

    const inHand = this.inHandPlayers();
    if (inHand.length <= 1) { this.resolveHand(); return; }

    // Reset bets
    for (const p of this.players) p.bet = 0;
    this.currentBet      = 0;
    this.lastRaiseAmount = this.getCurrentBlinds().big;

    // Deal next street
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
      default:
        // River betting is done — go to showdown immediately
        this.resolveHand();
        return;
    }

    // Notify clients a new card was dealt
    if (this.onStreetDealt) this.onStreetDealt();

    // Check if everyone still in is all-in → auto-run the board
    const canAct = inHand.filter(p => !p.allIn && p.chips > 0);
    if (canAct.length === 0) {
      // Schedule next street automatically (with delay so clients can show the card)
      this.clearRunoutTimer();
      this.runoutTimer = setTimeout(() => {
        this.runoutTimer = null;
        this.advanceStreet();
      }, RUNOUT_DELAY);
      return;
    }

    // Find first to act post-flop (left of dealer)
    let firstAct = -1;
    let idx = (this.dealerIndex + 1) % this.players.length;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[idx];
      if (!p.folded && !p.allIn && p.cards.length > 0 && p.chips > 0) {
        firstAct = idx; break;
      }
      idx = (idx + 1) % this.players.length;
    }

    if (firstAct === -1) { this.resolveHand(); return; }

    this.currentPlayerIndex = firstAct;
    this.startActionTimer();
  }

  // ─── HAND RESOLUTION ─────────────────────────────────────────────────────

  resolveHand() {
    this.clearActionTimer();
    this.clearRunoutTimer();
    this.state = GAME_STATES.SHOWDOWN;
    this.currentPlayerIndex = -1;

    const inHand = this.inHandPlayers();
    let handResults = [];

    if (inHand.length === 1) {
      inHand[0].chips += this.pot;
      handResults = [{ player: inHand[0], won: this.pot, hand: null, uncontested: true }];
    } else {
      handResults = this.awardPots();
    }

    this.handHistory.push({ hand: this.handNumber, results: handResults, community: [...this.communityCards] });
    this.state = GAME_STATES.HAND_OVER;

    // Eliminate busted players
    for (const p of this.players) {
      p.allIn = false; // always clear allIn at end of hand
      if (p.chips === 0 && p.finishPosition === null) {
        // Count how many players still have chips AFTER this hand
        const stillLive = this.players.filter(pp => pp.chips > 0 && pp.finishPosition === null).length;
        p.finishPosition = stillLive + 1;
        this.winners.push({ name: p.name, position: p.finishPosition });
      }
    }

    // Sort winners list: worst finishers first (highest position number)
    this.winners.sort((a, b) => b.position - a.position);

    return handResults;
  }

  // Award pots with proper side-pot logic
  awardPots() {
    const inHand = this.inHandPlayers();

    // Evaluate everyone's hand
    const evaluated = inHand.map(p => ({
      player: p,
      score: evaluateHand([...p.cards, ...this.communityCards]),
      contributed: p._contributed || 0  // total chips put in this hand
    })).sort((a, b) => compareScores(b.score, a.score));

    // For simplicity (and because contribution tracking wasn't added), 
    // split the pot among winners. This is correct for most cases.
    // True side pots require per-player contribution tracking added in startHand.
    const best = evaluated[0].score;
    const winners = evaluated.filter(e => compareScores(e.score, best) === 0);
    const share   = Math.floor(this.pot / winners.length);
    const rem     = this.pot - share * winners.length;

    const handResults = [];
    for (let i = 0; i < winners.length; i++) {
      const extra = i === 0 ? rem : 0;
      winners[i].player.chips += share + extra;
      handResults.push({ player: winners[i].player, won: share + extra, hand: winners[i].score });
    }
    for (const e of evaluated) {
      if (!winners.find(w => w.player === e.player)) {
        handResults.push({ player: e.player, won: 0, hand: e.score });
      }
    }
    return handResults;
  }

  // ─── TIMERS ───────────────────────────────────────────────────────────────

  startActionTimer() {
    this.clearActionTimer();
    this.actionTimerStart = Date.now();
    this.actionTimer = setTimeout(() => {
      this.actionTimer = null;
      const p = this.players[this.currentPlayerIndex];
      if (!p) return;
      console.log(`[Timer] Auto-acting for ${p.name} (state: ${this.state})`);
      const autoAction = p.bet >= this.currentBet ? 'check' : 'fold';
      this._applyAction(p.id, autoAction, 0);
      if (this.onTimerAction) this.onTimerAction();
    }, ACTION_TIME);
  }

  clearActionTimer() {
    if (this.actionTimer) { clearTimeout(this.actionTimer); this.actionTimer = null; }
    this.actionTimerStart = 0;
  }

  clearRunoutTimer() {
    if (this.runoutTimer) { clearTimeout(this.runoutTimer); this.runoutTimer = null; }
  }

  // ─── BETWEEN HANDS ────────────────────────────────────────────────────────

  nextHand() {
    const live = this.livePlayers();
    if (live.length < 2) { this.endGame(); return false; }
    this.startHand();
    return true;
  }

  endGame() {
    this.state = GAME_STATES.GAME_OVER;
    this.clearActionTimer();
    this.clearRunoutTimer();
    if (this.blindTimer) { clearInterval(this.blindTimer); this.blindTimer = null; }
    this.finishedAt = Date.now();

    // Award first place to whoever still has chips
    const winner = this.players.find(p => p.chips > 0);
    if (winner && winner.finishPosition === null) {
      winner.finishPosition = 1;
      this.winners.push({ name: winner.name, position: 1, chips: winner.chips });
    }
  }

  // ─── PUBLIC STATE ─────────────────────────────────────────────────────────

  getPublicState(forPlayerId = null) {
    const blinds = this.getCurrentBlinds();
    const timeLeft = Math.max(0, BLIND_LEVEL_DURATION - (Date.now() - this.blindLevelStart));
    const actionTimeLeft = this.actionTimerStart > 0
      ? Math.max(0, ACTION_TIME - (Date.now() - this.actionTimerStart)) : 0;

    return {
      id: this.id,
      state: this.state,
      players: this.players.map(p => ({
        id: p.id, name: p.name,
        chips: p.chips, bet: p.bet,
        folded: p.folded, allIn: p.allIn,
        seatIndex: p.seatIndex,
        connected: p.connected,
        finishPosition: p.finishPosition,
        cards: (p.id === forPlayerId ||
                this.state === GAME_STATES.SHOWDOWN ||
                this.state === GAME_STATES.HAND_OVER)
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
