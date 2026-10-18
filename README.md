# Brickfall

An arcade block breaker built for iPhone: 10 levels plus rotating bosses (Dragon, Mothership, Star Cruiser, Hive Queen), flying creatures, bonus objectives, lava levels, and 10 power-ups.

**Play:** https://brickfall.onrender.com

On iPhone, open the link in Safari, tap Share, then **Add to Home Screen** to play it full screen like an app.

- Pause any time and tap **Save & quit**; tap **Continue** next time to pick up where you left off. Saves stay on the device for the current week.
- Shared weekly top 10 for everyone who plays the site, reset every Monday at midnight Pacific.

## Leaderboard server

`server.js` is a small Node service (Render web service) backed by Postgres. It needs `DATABASE_URL`; optional `ALLOWED_ORIGINS` (default `https://brickfall.onrender.com`).
