'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { Game, GAME_STATES } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Store active games
const games = new Map();

// Clean up old games periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, game] of games.entries()) {
    // Remove games older than 4 hours or finished games older than 30min
    const age = now - game.createdAt;
    const finishAge = game.finishedAt ? now - game.finishedAt : Infinity;
    if (age > 4 * 60 * 60 * 1000 || finishAge > 30 * 60 * 1000) {
      games.delete(id);
    }
  }
}, 5 * 60 * 1000);

// REST: Create a new game room
app.post('/api/games', (req, res) => {
  const { hostName } = req.body;
  if (!hostName || hostName.trim().length === 0) {
    return res.status(400).json({ error: 'Host name required' });
  }
  const gameId = uuidv4().slice(0, 8).toUpperCase();
  const hostId = uuidv4();
  const game = new Game(gameId, hostId, hostName.trim().slice(0, 20));
  games.set(gameId, game);
  res.json({ gameId, hostId, playerId: hostId });
});

// REST: Join game (get player ID)
app.post('/api/games/:id/join', (req, res) => {
  const game = games.get(req.params.id.toUpperCase());
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (game.state !== GAME_STATES.WAITING) return res.status(400).json({ error: 'Game already started' });
  if (game.players.length >= game.maxPlayers) return res.status(400).json({ error: 'Game is full' });

  const { playerName } = req.body;
  if (!playerName || playerName.trim().length === 0) {
    return res.status(400).json({ error: 'Player name required' });
  }

  const playerId = uuidv4();
  const result = game.addPlayer(playerId, playerName.trim().slice(0, 20));
  if (result.error) return res.status(400).json(result);

  res.json({ gameId: game.id, playerId });
});

// REST: Check if game exists
app.get('/api/games/:id', (req, res) => {
  const game = games.get(req.params.id.toUpperCase());
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json({ 
    gameId: game.id, 
    state: game.state, 
    playerCount: game.players.length,
    maxPlayers: game.maxPlayers
  });
});

// Serve game page for all game routes
app.get('/game/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/game.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Socket.io
io.on('connection', (socket) => {
  let currentGameId = null;
  let currentPlayerId = null;

  function getGame() {
    return currentGameId ? games.get(currentGameId) : null;
  }

  function broadcastGameState(game) {
    for (const player of game.players) {
      const socketId = playerSockets.get(player.id);
      if (socketId) {
        const s = io.sockets.sockets.get(socketId);
        if (s) s.emit('game_state', game.getPublicState(player.id));
      }
    }
    // Also emit to spectators
    socket.to(`game:${game.id}:spectators`).emit('game_state', game.getPublicState());
  }

  function emitToPlayer(playerId, event, data) {
    const socketId = playerSockets.get(playerId);
    if (socketId) {
      const s = io.sockets.sockets.get(socketId);
      if (s) s.emit(event, data);
    }
  }

  socket.on('join_game', ({ gameId, playerId }) => {
    const game = games.get(gameId?.toUpperCase());
    if (!game) {
      socket.emit('error', { message: 'Game not found' });
      return;
    }

    const player = game.players.find(p => p.id === playerId);
    if (!player) {
      // Join as spectator
      socket.join(`game:${gameId}:spectators`);
      currentGameId = gameId.toUpperCase();
      socket.emit('game_state', game.getPublicState());
      return;
    }

    currentGameId = gameId.toUpperCase();
    currentPlayerId = playerId;
    playerSockets.set(playerId, socket.id);
    game.setConnected(playerId, true);

    socket.join(`game:${currentGameId}`);
    socket.emit('joined', { playerId, gameId: currentGameId, isHost: game.hostId === playerId });
    socket.emit('game_state', game.getPublicState(playerId));
    socket.to(`game:${currentGameId}`).emit('player_connected', { playerId, name: player.name });
  });

  socket.on('start_game', () => {
    const game = getGame();
    if (!game) return;
    if (game.hostId !== currentPlayerId) {
      socket.emit('error', { message: 'Only the host can start the game' });
      return;
    }
    if (!game.canStart()) {
      socket.emit('error', { message: `Need at least ${game.minPlayers} players to start` });
      return;
    }

    // Set up emit for blind level changes
    game.emit = (event, data) => {
      io.to(`game:${currentGameId}`).emit(event, data);
    };

    game.startGame();
    broadcastGameState(game);

    // Set up hand-over auto-advance
    scheduleHandAdvance(game);
  });

  socket.on('action', ({ action, amount }) => {
    const game = getGame();
    if (!game) return;
    if (!currentPlayerId) return;

    const result = game.handleAction(currentPlayerId, action, amount || 0);
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }

    // Broadcast action to all
    io.to(`game:${currentGameId}`).emit('player_action', result.actionResult);
    broadcastGameState(game);

    if (game.state === GAME_STATES.HAND_OVER || game.state === GAME_STATES.SHOWDOWN) {
      const lastHand = game.handHistory[game.handHistory.length - 1];
      io.to(`game:${currentGameId}`).emit('hand_result', {
        results: lastHand ? lastHand.results.map(r => ({
          playerName: r.player.name,
          playerId: r.player.id,
          won: r.won,
          hand: r.hand ? { name: r.hand.name, rank: r.hand.rank } : null,
          cards: r.player.cards,
          uncontested: r.uncontested || false
        })) : [],
        community: game.communityCards
      });
      scheduleHandAdvance(game);
    }
  });

  socket.on('next_hand', () => {
    const game = getGame();
    if (!game) return;
    if (game.hostId !== currentPlayerId) return;
    if (game.state !== GAME_STATES.HAND_OVER) return;
    advanceHand(game);
  });

  socket.on('chat', ({ message }) => {
    const game = getGame();
    if (!game || !currentPlayerId) return;
    const player = game.players.find(p => p.id === currentPlayerId);
    if (!player) return;
    const msg = message?.toString().trim().slice(0, 200);
    if (!msg) return;
    io.to(`game:${currentGameId}`).emit('chat', { name: player.name, message: msg, time: Date.now() });
  });

  socket.on('disconnect', () => {
    const game = getGame();
    if (game && currentPlayerId) {
      game.setConnected(currentPlayerId, false);
      playerSockets.delete(currentPlayerId);
      io.to(`game:${currentGameId}`).emit('player_disconnected', { playerId: currentPlayerId });
      
      // If it's their turn, auto-fold after a delay
      if (game.currentPlayerIndex !== -1 && 
          game.players[game.currentPlayerIndex]?.id === currentPlayerId) {
        setTimeout(() => {
          const g = games.get(currentGameId);
          if (g && g.players[g.currentPlayerIndex]?.id === currentPlayerId) {
            const result = g.handleAction(currentPlayerId, 'fold', 0);
            if (result.success) {
              broadcastGameState(g);
              if (g.state === GAME_STATES.HAND_OVER) {
                scheduleHandAdvance(g);
              }
            }
          }
        }, 5000);
      }
    }
  });

  function advanceHand(game) {
    const continued = game.nextHand();
    if (continued) {
      broadcastGameState(game);
    } else {
      // Game over
      io.to(`game:${currentGameId}`).emit('game_over', {
        winners: game.winners,
        players: game.players.map(p => ({ name: p.name, position: p.finishPosition || 1 }))
      });
      broadcastGameState(game);
    }
  }

  function scheduleHandAdvance(game) {
    // Auto-advance to next hand after showing results
    setTimeout(() => {
      const g = games.get(currentGameId);
      if (!g) return;
      if (g.state === GAME_STATES.HAND_OVER || g.state === GAME_STATES.SHOWDOWN) {
        advanceHand(g);
        broadcastGameState(g);
        // If it ended
        if (g.state === GAME_STATES.GAME_OVER) {
          io.to(`game:${currentGameId}`).emit('game_over', {
            winners: g.winners
          });
        }
      }
    }, 5000); // 5 second delay to show results
  }
});

// Track player socket mappings
const playerSockets = new Map();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🃏 Poker server running on http://localhost:${PORT}`);
});
