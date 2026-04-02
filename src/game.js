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

const ACTION_TIME  = 30000;  // ms per player action
const START_CHIPS  = 1500;
const RUNOUT_DELAY = 1800;   // ms between auto-dealt streets (all-in runout)

class Game {
  constructor(id, hostId, hostName) {
    this.id              = id;
    this.hostId          = hostId;
    this.state           = GAME_STATES.WAITING;
    this.players         = [];
    this.communityCards  = [];
    this.pot             = 0;
    this.dealerIndex     = 0;
    this.currentPlayerIndex = -1;
    this.blindLevel      = 0;
    this.blindLevelStart = 0;
    this.handNumber      = 0;
    this.currentBet      = 0;
    this.lastRaiseAmount = 0;
    this.actionTimer     = null;
    this.blindTimer      = null;
    this.runoutTimer     = null;
    this.handHistory     = [];
    this.winners         = [];
    this.finishedAt      = null;
    this.createdAt       = Date.now();
    this.minPlayers      = 2;
    this.maxPlayers      = 9;
    this.sbIndex         = -1;
    this.bbIndex         = -1;
    this.actionTimerStart = 0;
    this.actedThisRound  = new Set();
    this._handAdvanceScheduled = false;

    // Server hooks — set after construction
    this.onStateChange = null;  // () => void  — broadcast state to all clients
    this.onHandOver    = null;  // () => void  — broadcast result + schedule next hand
    this.onBlindLevelUp = null; // (data) => void

    this.addPlayer(hostId, hostName);
  }

  // ─── PLAYER MANAGEMENT ────────────────────────────────────────────────────

  addPlayer(id, name) {
    if (this.players.length >= this.maxPlayers) return { error: 'Game is full' };
    if (this.state !== GAME_STATES.WAITING)     return { error: 'Game already started' };
    if (this.players.find(p => p.id === id))    return { error: 'Already in game' };
    this.players.push({
      id, name,
      chips: START_CHIPS,
      cards: [], folded: false, allIn: false, bet: 0,
      seatIndex: this.players.length,
      connected: true, finishPosition: null
    });
    return { success: true };
  }

  setConnected(id, connected) {
    const p = this.players.find(p => p.id === id);
    if (p) p.connected = connected;
  }

  // ─── HELPERS ──────────────────────────────────────────────────────────────

  livePlayers() {
    return this.players.filter(p => p.chips > 0 && p.finishPosition === null);
  }

  inHandPlayers() {
    return this.players.filter(p => !p.folded && p.cards.length > 0);
  }

  nextLive(fromIdx) {
    let idx = (fromIdx + 1) % this.players.length;
    for (let i = 0; i < this.players.length; i++) {
      if (this.players[idx].chips > 0 && this.players[idx].finishPosition === null) return idx;
      idx = (idx + 1) % this.players.length;
    }
    return fromIdx;
  }

  nextToAct(fromIdx) {
    let idx = (fromIdx + 1) % this.players.length;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[idx];
      if (!p.folded && !p.allIn && p.cards.length > 0 && p.chips > 0) return idx;
      idx = (idx + 1) % this.players.length;
    }
    return -1;
  }

  // ─── GAME START ───────────────────────────────────────────────────────────

  canStart() {
    return this.players.length >= this.minPlayers && this.state === GAME_STATES.WAITING;
  }

  startGame() {
    if (!this.canStart()) return false;
    this.state           = GAME_STATES.STARTING;
    this.blindLevel      = 0;
    this.blindLevelStart = Date.now();
    this.dealerIndex     = Math.floor(Math.random() * this.players.length);
    this._startBlindTimer();
    this.startHand();
    return true;
  }

  _startBlindTimer() {
    if (this.blindTimer) clearInterval(this.blindTimer);
    this.blindTimer = setInterval(() => {
      if (this.blindLevel < BLIND_LEVELS.length - 1) {
        this.blindLevel++;
        this.blindLevelStart = Date.now();
        if (this.onBlindLevelUp) this.onBlindLevelUp({ level: this.blindLevel, blinds: this.getCurrentBlinds() });
      }
    }, BLIND_LEVEL_DURATION);
  }

  getCurrentBlinds() {
    return BLIND_LEVELS[Math.min(this.blindLevel, BLIND_LEVELS.length - 1)];
  }

  // ─── HAND START ───────────────────────────────────────────────────────────

  startHand() {
    this._clearActionTimer();
    this._clearRunoutTimer();
    this._handAdvanceScheduled = false;

    this.handNumber++;
    this.communityCards  = [];
    this.pot             = 0;
    this.currentBet      = 0;
    this.lastRaiseAmount = 0;
    this.actedThisRound  = new Set();

    for (const p of this.players) {
      p.cards = []; p.folded = false; p.allIn = false; p.bet = 0;
    }

    const live = this.livePlayers();
    if (live.length < 2) { this.endGame(); return; }

    // Advance dealer
    if (this.handNumber > 1) {
      this.dealerIndex = this.nextLive(this.dealerIndex);
    }

    // Deal hole cards to live players
    for (const p of live) p.cards = dealCards(2);

    // Blinds
    const { small, big, ante } = this.getCurrentBlinds();
    let sbIdx, bbIdx;
    if (live.length === 2) {
      sbIdx = this.dealerIndex;
      bbIdx = this.nextLive(sbIdx);
    } else {
      sbIdx = this.nextLive(this.dealerIndex);
      bbIdx = this.nextLive(sbIdx);
    }
    this.sbIndex = sbIdx;
    this.bbIndex = bbIdx;

    // Post antes
    if (ante > 0) {
      for (const p of live) {
        const a = Math.min(ante, p.chips);
        p.chips -= a; this.pot += a;
        if (p.chips === 0) p.allIn = true;
      }
    }

    // Post SB
    const sbAmt = Math.min(small, this.players[sbIdx].chips);
    this.players[sbIdx].chips -= sbAmt;
    this.players[sbIdx].bet    = sbAmt;
    this.pot += sbAmt;
    if (this.players[sbIdx].chips === 0) this.players[sbIdx].allIn = true;

    // Post BB
    const bbAmt = Math.min(big, this.players[bbIdx].chips);
    this.players[bbIdx].chips -= bbAmt;
    this.players[bbIdx].bet    = bbAmt;
    this.pot += bbAmt;
    if (this.players[bbIdx].chips === 0) this.players[bbIdx].allIn = true;

    this.currentBet      = bbAmt;
    this.lastRaiseAmount = bbAmt;

    this.state = GAME_STATES.PREFLOP;
    this.currentPlayerIndex = this.nextLive(bbIdx);
    this._startActionTimer();
  }

  // ─── ACTIONS ──────────────────────────────────────────────────────────────

  handleAction(playerId, action, amount) {
    const betting = [GAME_STATES.PREFLOP, GAME_STATES.FLOP, GAME_STATES.TURN, GAME_STATES.RIVER];
    if (!betting.includes(this.state))        return { error: 'Not in a betting round' };
    const pIdx = this.players.findIndex(p => p.id === playerId);
    if (pIdx === -1)                          return { error: 'Player not found' };
    if (pIdx !== this.currentPlayerIndex)     return { error: 'Not your turn' };
    const p = this.players[pIdx];
    if (p.folded || p.allIn)                  return { error: 'Cannot act' };
    return this._applyAction(playerId, action, amount);
  }

  _applyAction(playerId, action, amount) {
    const pIdx = this.players.findIndex(p => p.id === playerId);
    if (pIdx === -1) return { error: 'Player not found' };
    const p = this.players[pIdx];
    this._clearActionTimer();

    const { big } = this.getCurrentBlinds();
    const result = { playerId, playerName: p.name, action, amount: 0 };

    switch (action) {
      case 'fold':
        p.folded = true;
        this.actedThisRound.add(pIdx);
        break;

      case 'check':
        if (p.bet < this.currentBet) {
          p.folded = true; result.action = 'fold';
        }
        this.actedThisRound.add(pIdx);
        break;

      case 'call': {
        const amt = Math.min(this.currentBet - p.bet, p.chips);
        p.chips -= amt; p.bet += amt; this.pot += amt;
        if (p.chips === 0) p.allIn = true;
        this.actedThisRound.add(pIdx);
        result.amount = amt;
        break;
      }

      case 'bet':
      case 'raise': {
        const total = Math.min(amount, p.chips + p.bet);
        const add   = total - p.bet;
        if (add <= 0) {
          if (p.bet >= this.currentBet) { this.actedThisRound.add(pIdx); result.action = 'check'; }
          else { p.folded = true; this.actedThisRound.add(pIdx); result.action = 'fold'; }
          break;
        }
        this.lastRaiseAmount = Math.max(total - this.currentBet, big);
        this.currentBet      = total;
        p.chips -= add; p.bet = total; this.pot += add;
        if (p.chips === 0) p.allIn = true;
        this.actedThisRound = new Set([pIdx]);
        result.amount = total;
        break;
      }

      case 'allin': {
        const add    = p.chips;
        const newBet = p.bet + add;
        if (newBet > this.currentBet) {
          this.lastRaiseAmount = Math.max(newBet - this.currentBet, big);
          this.currentBet      = newBet;
          this.actedThisRound  = new Set([pIdx]);
        } else {
          this.actedThisRound.add(pIdx);
        }
        p.bet = newBet; this.pot += add; p.chips = 0; p.allIn = true;
        result.amount = newBet;
        break;
      }

      default:
        return { error: 'Unknown action' };
    }

    result.action = result.action || action;
    this._advanceAfterAction(pIdx);
    return { success: true, actionResult: result };
  }

  _advanceAfterAction(lastIdx) {
    if (this._isBettingRoundOver()) {
      this.currentPlayerIndex = -1;
      this._advanceStreet();
    } else {
      const next = this.nextToAct(lastIdx);
      if (next === -1) {
        this.currentPlayerIndex = -1;
        this._advanceStreet();
      } else {
        this.currentPlayerIndex = next;
        this._startActionTimer();
      }
    }
  }

  _isBettingRoundOver() {
    const inHand = this.inHandPlayers();
    if (inHand.length <= 1) return true;
    const canAct = inHand.filter(p => !p.allIn && p.chips > 0);
    if (canAct.length === 0) return true;
    for (const p of canAct) {
      const idx = this.players.indexOf(p);
      if (p.bet < this.currentBet)       return false;
      if (!this.actedThisRound.has(idx)) return false;
    }
    return true;
  }

  // ─── STREET ADVANCEMENT ───────────────────────────────────────────────────

  _advanceStreet() {
    this._clearActionTimer();
    this.actedThisRound = new Set();

    const inHand = this.inHandPlayers();
    if (inHand.length <= 1) { this._resolveHand(); return; }

    for (const p of this.players) p.bet = 0;
    this.currentBet      = 0;
    this.lastRaiseAmount = this.getCurrentBlinds().big;

    // Deal the next community card(s)
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
        // River is done — resolve immediately
        this._resolveHand();
        return;
      default:
        this._resolveHand();
        return;
    }

    // Broadcast the new card to clients
    if (this.onStateChange) this.onStateChange();

    // Check if everyone remaining is all-in (no one left to bet)
    const canAct = inHand.filter(p => !p.allIn && p.chips > 0);
    if (canAct.length === 0) {
      // All-in runout: schedule next street automatically
      this._clearRunoutTimer();
      this.runoutTimer = setTimeout(() => {
        this.runoutTimer = null;
        this._advanceStreet();
      }, RUNOUT_DELAY);
      return;
    }

    // Normal betting: find first to act left of dealer
    let firstAct = -1;
    let idx = (this.dealerIndex + 1) % this.players.length;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[idx];
      if (!p.folded && !p.allIn && p.cards.length > 0 && p.chips > 0) {
        firstAct = idx; break;
      }
      idx = (idx + 1) % this.players.length;
    }

    if (firstAct === -1) { this._resolveHand(); return; }
    this.currentPlayerIndex = firstAct;
    this._startActionTimer();
  }

  // ─── RESOLUTION ───────────────────────────────────────────────────────────

  _resolveHand() {
    this._clearActionTimer();
    this._clearRunoutTimer();
    this.state = GAME_STATES.SHOWDOWN;
    this.currentPlayerIndex = -1;

    const inHand = this.inHandPlayers();
    let handResults;

    if (inHand.length === 1) {
      const won = this.pot;
      inHand[0].chips += won;
      this.pot = 0;
      handResults = [{ player: inHand[0], won, hand: null, uncontested: true }];
    } else {
      handResults = this._awardPots();
    }

    this.handHistory.push({ hand: this.handNumber, results: handResults, community: [...this.communityCards] });
    this.state = GAME_STATES.HAND_OVER;

    // Clear allIn flags and record eliminations
    for (const p of this.players) {
      p.allIn = false;
      if (p.chips === 0 && p.finishPosition === null) {
        const stillLive = this.players.filter(x => x.chips > 0 && x.finishPosition === null).length;
        p.finishPosition = stillLive + 1;
        this.winners.push({ name: p.name, position: p.finishPosition });
      }
    }
    this.winners.sort((a, b) => b.position - a.position);

    // *** KEY FIX: always fire onHandOver so the server can broadcast results
    //     and schedule the next hand — regardless of whether we got here via
    //     a player action OR an async runout timer ***
    if (this.onHandOver) this.onHandOver();

    return handResults;
  }

  _awardPots() {
    const inHand = this.inHandPlayers();
    const evaluated = inHand.map(p => ({
      player: p,
      score:  evaluateHand([...p.cards, ...this.communityCards])
    })).sort((a, b) => compareScores(b.score, a.score));

    const best    = evaluated[0].score;
    const winners = evaluated.filter(e => compareScores(e.score, best) === 0);
    const share   = Math.floor(this.pot / winners.length);
    const rem     = this.pot - share * winners.length;

    const results = [];
    for (let i = 0; i < winners.length; i++) {
      const extra = i === 0 ? rem : 0;
      winners[i].player.chips += share + extra;
      results.push({ player: winners[i].player, won: share + extra, hand: winners[i].score });
    }
    for (const e of evaluated) {
      if (!winners.find(w => w.player === e.player))
        results.push({ player: e.player, won: 0, hand: e.score });
    }
    this.pot = 0;  // pot fully distributed
    return results;
  }

  // ─── TIMERS ───────────────────────────────────────────────────────────────

  _startActionTimer() {
    this._clearActionTimer();
    this.actionTimerStart = Date.now();
    this.actionTimer = setTimeout(() => {
      this.actionTimer = null;
      const p = this.players[this.currentPlayerIndex];
      if (!p) return;
      console.log(`[Timer] Auto-acting for ${p.name} in state ${this.state}`);
      const auto = p.bet >= this.currentBet ? 'check' : 'fold';
      this._applyAction(p.id, auto, 0);
      // onHandOver will be called inside _resolveHand if needed;
      // if hand is still going, onStateChange handles the broadcast
      if (this.onStateChange) this.onStateChange();
    }, ACTION_TIME);
  }

  _clearActionTimer() {
    if (this.actionTimer) { clearTimeout(this.actionTimer); this.actionTimer = null; }
    this.actionTimerStart = 0;
  }

  _clearRunoutTimer() {
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
    this._clearActionTimer();
    this._clearRunoutTimer();
    if (this.blindTimer) { clearInterval(this.blindTimer); this.blindTimer = null; }
    this.finishedAt = Date.now();
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
      id: this.id, state: this.state,
      players: this.players.map(p => ({
        id: p.id, name: p.name,
        chips: p.chips, bet: p.bet,
        folded: p.folded, allIn: p.allIn,
        seatIndex: p.seatIndex, connected: p.connected,
        finishPosition: p.finishPosition,
        cards: (p.id === forPlayerId || this.state === GAME_STATES.SHOWDOWN || this.state === GAME_STATES.HAND_OVER)
          ? p.cards : p.cards.map(() => ({ rank: '?', suit: '?' })),
        hasCards: p.cards.length > 0
      })),
      communityCards: this.communityCards,
      pot: this.pot, currentBet: this.currentBet,
      dealerIndex: this.dealerIndex,
      currentPlayerIndex: this.currentPlayerIndex,
      sbIndex: this.sbIndex, bbIndex: this.bbIndex,
      handNumber: this.handNumber,
      blindLevel: this.blindLevel,
      blinds: { small: blinds.small, big: blinds.big, ante: blinds.ante },
      blindTimeLeft: timeLeft,
      hostId: this.hostId, winners: this.winners,
      actionTimeLeft, actionTimerDuration: ACTION_TIME
    };
  }
}

module.exports = { Game, GAME_STATES };
