'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const { Game, GAME_STATES } = require('./game');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const games        = new Map();
const playerSockets = new Map(); // playerId -> socketId

// Clean up stale games
setInterval(() => {
  const now = Date.now();
  for (const [id, game] of games.entries()) {
    const age        = now - game.createdAt;
    const finishAge  = game.finishedAt ? now - game.finishedAt : Infinity;
    if (age > 4 * 3600_000 || finishAge > 30 * 60_000) games.delete(id);
  }
}, 5 * 60_000);

// ─── REST ──────────────────────────────────────────────────────────────────

app.post('/api/games', (req, res) => {
  const { hostName } = req.body;
  if (!hostName?.trim()) return res.status(400).json({ error: 'Host name required' });
  const gameId = uuidv4().slice(0, 8).toUpperCase();
  const hostId = uuidv4();
  const game   = new Game(gameId, hostId, hostName.trim().slice(0, 20));
  games.set(gameId, game);
  res.json({ gameId, hostId, playerId: hostId });
});

app.post('/api/games/:id/join', (req, res) => {
  const game = games.get(req.params.id.toUpperCase());
  if (!game)                                  return res.status(404).json({ error: 'Game not found' });
  if (game.state !== GAME_STATES.WAITING)     return res.status(400).json({ error: 'Game already started' });
  if (game.players.length >= game.maxPlayers) return res.status(400).json({ error: 'Game is full' });
  const { playerName } = req.body;
  if (!playerName?.trim()) return res.status(400).json({ error: 'Player name required' });
  const playerId = uuidv4();
  const result   = game.addPlayer(playerId, playerName.trim().slice(0, 20));
  if (result.error) return res.status(400).json(result);
  res.json({ gameId: game.id, playerId });
});

app.get('/api/games/:id', (req, res) => {
  const game = games.get(req.params.id.toUpperCase());
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json({ gameId: game.id, state: game.state, playerCount: game.players.length, maxPlayers: game.maxPlayers });
});

app.get('/game/:id', (req, res) => res.sendFile(path.join(__dirname, '../public/game.html')));
app.get('/',         (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ─── BROADCAST HELPERS ─────────────────────────────────────────────────────

function broadcastState(game) {
  for (const p of game.players) {
    const sid = playerSockets.get(p.id);
    if (sid) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit('game_state', game.getPublicState(p.id));
    }
  }
  io.to(`spec:${game.id}`).emit('game_state', game.getPublicState(null));
}

function broadcastHandResult(game) {
  const last = game.handHistory[game.handHistory.length - 1];
  if (!last) return;
  const payload = {
    results: last.results.map(r => ({
      playerName: r.player.name,
      playerId:   r.player.id,
      won:        r.won,
      hand:       r.hand ? { name: r.hand.name, rank: r.hand.rank } : null,
      cards:      r.player.cards,
      uncontested: r.uncontested || false
    })),
    community: game.communityCards
  };
  io.to(`game:${game.id}`).emit('hand_result', payload);
  io.to(`spec:${game.id}`).emit('hand_result', payload);
}

function scheduleNextHand(game) {
  if (game._handAdvanceScheduled) return;
  game._handAdvanceScheduled = true;
  setTimeout(() => {
    game._handAdvanceScheduled = false;
    const g = games.get(game.id);
    if (!g) return;
    if (g.state !== GAME_STATES.HAND_OVER && g.state !== GAME_STATES.SHOWDOWN) return;
    const continued = g.nextHand();
    broadcastState(g);
    if (!continued || g.state === GAME_STATES.GAME_OVER) {
      const payload = { winners: g.winners };
      io.to(`game:${g.id}`).emit('game_over', payload);
      io.to(`spec:${g.id}`).emit('game_over', payload);
    }
  }, 5000);
}

function hookGame(game) {
  game.emit = (event, data) => {
    io.to(`game:${game.id}`).emit(event, data);
    io.to(`spec:${game.id}`).emit(event, data);
  };

  // Called when the action timer fires internally
  game.onTimerAction = () => {
    broadcastState(game);
    if (game.state === GAME_STATES.HAND_OVER || game.state === GAME_STATES.SHOWDOWN) {
      broadcastHandResult(game);
      scheduleNextHand(game);
    }
  };

  // Called whenever a new community card street is dealt (including during all-in runout)
  game.onStreetDealt = () => {
    broadcastState(game);
    // If we've reached showdown via runout, wait for runout to finish then broadcast result
    if (game.state === GAME_STATES.SHOWDOWN || game.state === GAME_STATES.HAND_OVER) {
      broadcastHandResult(game);
      scheduleNextHand(game);
    }
  };
}

// ─── SOCKET.IO ─────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  let currentGameId  = null;
  let currentPlayerId = null;

  const getGame = () => currentGameId ? games.get(currentGameId) : null;

  socket.on('join_game', ({ gameId, playerId }) => {
    const gid  = gameId?.toUpperCase();
    const game = games.get(gid);
    if (!game) { socket.emit('error', { message: 'Game not found' }); return; }

    currentGameId = gid;

    const player = game.players.find(p => p.id === playerId);
    if (!player) {
      socket.join(`spec:${gid}`);
      socket.emit('game_state', game.getPublicState(null));
      return;
    }

    currentPlayerId = playerId;
    playerSockets.set(playerId, socket.id);
    game.setConnected(playerId, true);

    socket.join(`game:${gid}`);
    socket.emit('joined', { playerId, gameId: gid, isHost: game.hostId === playerId });
    socket.emit('game_state', game.getPublicState(playerId));
    socket.to(`game:${gid}`).emit('player_connected', { playerId, name: player.name });
  });

  socket.on('start_game', () => {
    const game = getGame();
    if (!game) return;
    if (game.hostId !== currentPlayerId) { socket.emit('error', { message: 'Only the host can start' }); return; }
    if (!game.canStart()) { socket.emit('error', { message: `Need at least ${game.minPlayers} players` }); return; }
    hookGame(game);
    game.startGame();
    broadcastState(game);
  });

  socket.on('action', ({ action, amount }) => {
    const game = getGame();
    if (!game || !currentPlayerId) return;

    const result = game.handleAction(currentPlayerId, action, amount || 0);
    if (result.error) { socket.emit('error', { message: result.error }); return; }

    io.to(`game:${currentGameId}`).emit('player_action', result.actionResult);
    broadcastState(game);

    if (game.state === GAME_STATES.HAND_OVER || game.state === GAME_STATES.SHOWDOWN) {
      broadcastHandResult(game);
      scheduleNextHand(game);
    }
  });

  socket.on('chat', ({ message }) => {
    const game = getGame();
    if (!game || !currentPlayerId) return;
    const player = game.players.find(p => p.id === currentPlayerId);
    if (!player) return;
    const msg = message?.toString().trim().slice(0, 200);
    if (!msg) return;
    const payload = { name: player.name, message: msg, time: Date.now() };
    io.to(`game:${currentGameId}`).emit('chat', payload);
    io.to(`spec:${currentGameId}`).emit('chat', payload);
  });

  socket.on('disconnect', () => {
    const game = getGame();
    if (!game || !currentPlayerId) return;
    game.setConnected(currentPlayerId, false);
    playerSockets.delete(currentPlayerId);
    io.to(`game:${currentGameId}`).emit('player_disconnected', { playerId: currentPlayerId });
    // The game's own action timer will auto-fold them if it's their turn
    console.log(`[Disconnect] ${currentPlayerId} disconnected from ${currentGameId}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🃏 Poker server on http://localhost:${PORT}`));
