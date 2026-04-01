# ♠ Felt & Fortune — No-Limit Hold'em Sit & Go

Multiplayer poker game with full NL Hold'em sit-and-go structure.

## Features
- 2–9 players per table
- Full NL Hold'em betting (fold, check, call, raise, all-in)
- Sit & Go blind structure (10-min levels, 13 levels)
- Dealer button moves each hand
- Side pots handled
- Custom hand: **Five of a Kind** (ranks between Straight Flush and Royal Flush)
- Cards dealt with replacement (unlimited duplicates possible)
- Real-time multiplayer via Socket.io
- Host generates room → shares link → others join
- Action timer (30s per decision, auto-fold on timeout)
- In-game chat
- Tournament results / standings at end

---

## Deploy in 2 Minutes (Free)

### Option A: Railway (Recommended)

1. Push this folder to a GitHub repo:
   ```bash
   cd poker-game
   git init
   git add .
   git commit -m "Initial commit"
   # Create a repo on github.com, then:
   git remote add origin https://github.com/YOUR_USERNAME/poker-game.git
   git push -u origin main
   ```

2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
3. Select your repo — Railway auto-detects Node.js
4. Click **Deploy** — get your live URL in ~60 seconds
5. Share the URL with friends!

### Option B: Render (Also Free)

1. Push to GitHub (same as above)
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your GitHub repo
4. Build command: `npm install`
5. Start command: `npm start`
6. Click **Create Web Service**

### Option C: Run Locally

```bash
cd poker-game
npm install
npm start
# Open http://localhost:3000
# Share your local IP: http://YOUR_IP:3000
```

---

## How to Play

1. **Host** visits the site, enters their name, clicks "Deal Me In"
2. **Host** copies the invite link and sends it to friends
3. **Players** click the link, enter their name, join the table
4. **Host** clicks "Start Game" when everyone is seated (2–9 players)
5. Play No-Limit Hold'em — last player with chips wins!

## Blind Structure

| Level | Small | Big | Ante |
|-------|-------|-----|------|
| 1     | 10    | 20  | 0    |
| 2     | 15    | 30  | 0    |
| 3     | 25    | 50  | 0    |
| 4     | 50    | 100 | 0    |
| 5     | 75    | 150 | 25   |
| 6     | 100   | 200 | 25   |
| 7     | 150   | 300 | 50   |
| 8     | 200   | 400 | 50   |
| 9     | 300   | 600 | 75   |
| 10    | 400   | 800 | 100  |
| 11    | 500   | 1000| 150  |
| 12    | 750   | 1500| 200  |
| 13    | 1000  | 2000| 300  |

Each level lasts 10 minutes. Starting chips: 1,500.

## Hand Rankings (High to Low)

1. **Royal Flush** — A K Q J 10 suited
2. **Five of a Kind** ⭐ — Five cards of same rank (with replacement)
3. **Straight Flush** — Five consecutive cards of same suit
4. **Four of a Kind** — Four cards of same rank
5. **Full House** — Three of a kind + pair
6. **Flush** — Five cards of same suit
7. **Straight** — Five consecutive cards
8. **Three of a Kind**
9. **Two Pair**
10. **One Pair**
11. **High Card**

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Server port |
