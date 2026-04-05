# Improvements & Roadmap

Comprehensive review of the blindtest codebase covering security, performance, UX, gameplay, architecture, and production readiness.

---

## 1. Security

### Critical

- **Session cookies not secure** (`app.py:34`): `SESSION_COOKIE_SECURE = False`. Must be `True` in production with HTTPS. Use env var to toggle.
- **XSS via player names** (`app.py:893`): Regex `<[^>]*>` stripping is insufficient. Use `markupsafe.escape()` or `bleach`. Frontend also uses `innerHTML` with player names in `participant.js` (`updateWaitingParticipants`, `displayFinalScores`) — use `textContent` instead.
- **Token fragments logged** (`app.py:408-411`): Even last 10 chars of access/refresh tokens should not be logged.

### High

- **CORS too permissive** (`app.py:38`): `cors_allowed_origins="*"` allows any domain. Whitelist specific origins.
- **`rejectUnauthorized: false`** in socket config (`host.js:5`, `participant.js:5`): Disables SSL cert validation. Remove in production.
- **No Content Security Policy headers**: External CDNs (Tailwind, Socket.IO, Google Fonts, DiceBear) not restricted.
- **No rate limiting**: Socket events (`submit_answer`, `join_room`, `create_room`) can be spammed. Add per-IP/per-SID cooldowns.
- **Answer validation missing** (`app.py:2294`): No check that answer is an int in range `[0, len(options))`. Malicious client can send arbitrary values.

### Medium

- **No input length/character validation**: Player names allow emojis and special chars that may render poorly. Consider alphanumeric + spaces only.
- **Client response time not capped**: A cheating client could send `client_response_time_ms: 1` to always rank first. Cap to `[0, QUESTION_TIME_LIMIT * 1000 + grace]`.

---

## 2. Memory & Stability

### High

- **Rooms never cleaned up after game ends**: `rooms` dict grows unbounded. Completed rooms stay in memory forever. Add TTL-based cleanup (e.g., delete rooms idle >1 hour with `state == "ended"`).
- **`players` and `spotify_tokens` dicts grow unbounded**: Disconnected entries accumulate. Clean up on disconnect after grace period.
- **`all_questions` array**: For 5 games x 30 songs = 150 question objects held in memory per room. Consider generating per-game instead of upfront.

### Medium

- **Race condition in room cleanup** (`app.py:2438-2494`): Background cleanup task can delete a room while socket handlers are reading it. Use try/except or a lock.
- **Leaderboard service instance cache grows unbounded** (`leaderboard_service.py:15`): `_instances` dict never evicts. Use `functools.lru_cache(maxsize=100)`.
- **Leaderboard file writes not atomic**: Crash during write = corrupted JSON. Write to `.tmp` file then `os.replace()`.

---

## 3. Frontend

### PWA Migration

The app is a strong PWA candidate:
- Already mobile-first with responsive design
- Has `apple-mobile-web-app-capable` meta tags
- Wake lock implemented for screen-on during games

**Missing for PWA:**
- `manifest.json` (app name, icons, theme color, start URL, display mode)
- Service worker for static asset caching and offline fallback page
- Offline page ("You're offline, reconnect to continue")
- Install prompt handling

### Template Duplication

Nav bar, auth check, profile menu, settings modal, and meta tags are duplicated across `index.html`, `host.html`, `participant.html`, and `leaderboard.html`. Any change requires updating 4 files.

**Fix:** Create `base.html` with `{% block content %}` and shared layout. Each page extends it.

### Dark Mode Inconsistency

- `host.html`: Full dark mode support (`dark:` classes throughout)
- `index.html`: No dark mode classes in settings modal
- `participant.html`: No dark mode support at all
- `leaderboard.html`: No dark mode support
- `style.css`: No dark mode variants

**Fix:** Add dark mode to all pages. Sync settings modal CSS between index and host.

### Accessibility

- **Zoom disabled on participant** (`participant.html:6`): `user-scalable=no, maximum-scale=1.0` prevents visually impaired users from zooming. Consider removing.
- **No keyboard navigation for answers**: Participants can't use keys 1-4 or arrow keys to select answers.
- **Screen reader gaps**: Dynamic content updates (scores, timer, standings) not announced via ARIA live regions.
- **Answer buttons lack descriptive ARIA labels** for the current option text.

### Performance

- **Tailwind CSS via CDN**: Full ~50KB stylesheet loaded on every page. Consider building and purging unused styles.
- **DiceBear avatars fetched per render**: `getAvatarUrl()` generates external URLs but `getCachedAvatar()` (which caches to sessionStorage) is only used in some places.
- **No lazy loading** for avatar images in participant lists.
- **Duplicate CSS**: `@keyframes pulse` defined twice in `style.css` (lines 748, 989).

### Misc

- **Console logs in production**: Many `console.log()` calls throughout JS files. Wrap in a debug flag.
- **Inline event handlers** (`onclick="openSettingsModal()"`): Incompatible with strict CSP. Move to `addEventListener`.
- **Global JS variables**: Both `host.js` and `participant.js` pollute global scope. Wrap in IIFE or use modules.

---

## 4. Gameplay Improvements

### Timer Visibility for Participants

Participants don't see the countdown timer. They submit answers without knowing how much time remains. Show a synced timer bar on the participant screen.

### Streak System

No reward for consecutive correct answers. A streak bonus (+10% per consecutive correct, starting at 3) would add tension and reward consistency.

### Difficulty Progression

All questions are equally hard. Vary OpenAI prompt to generate easier fakes for early songs and harder (more plausible) fakes for later songs.

### Intermediate Leaderboard for Participants

Participants only see scores at game end. Showing intermediate standings after each correct answer reveal builds competition and engagement.

### Series Game UX

- No countdown between games in a series
- Score reset is abrupt with no explanation
- Add "Game 1 Complete! Game 2 starts in 5..." transition screen

### Additional Game Modes

Currently only "Guess the Artist" mode. Potential additions:
- **Guess the Song Title**: Play audio, show 4 song titles
- **Guess the Year/Decade**: When was this song released?
- **Guess the Album**: Which album is this track from?
- **Speed Round**: 5-second timer, double points
- **Blind Mode**: No options shown, players type their answer

### Power-Ups

- **Skip**: Host can skip a broken/unavailable track
- **Hint**: Show a clue ("This artist is from the UK")
- **2x Card**: Player uses once per game for double points on one question
- **Steal**: Correct answer after someone else gets it wrong earns their lost points

### Configurable Rules

Timer duration (15s) and option count (4) are hardcoded. Allow host to configure:
- Timer: 10s / 15s / 20s / 30s
- Options: 2 / 4 / 6
- Scoring: Standard / Speed-only / Flat

---

## 5. Backend Architecture

### Eventlet Deprecation

`eventlet` is used for async mode but is deprecated in favor of native async. Migrate to `python-socketio` with `aiohttp` or `gevent`. This also fixes potential threading/locking issues.

### No Persistence Layer

All state is in-memory. Server restart = all data lost. Leaderboard uses JSON files (good start) but rooms, game history, and player sessions are ephemeral.

**Recommendation:** Add SQLite for development, PostgreSQL for production. Store:
- Game results and history
- Player stats and leaderboard
- Room state snapshots (for crash recovery)

### OpenAI Service Improvements

- **No timeout** on API calls (`openai_service.py`). If OpenAI is slow, game start hangs. Add `timeout=30`.
- **No retry with backoff**: If a call fails, it falls back to MusicBrainz immediately. Add 1 retry with exponential backoff before fallback.
- **No cost tracking/limiting**: A 5-game x 30-song series makes ~150 OpenAI calls. Add estimated cost logging and a per-game cap.
- **Fake artist validation**: Generated names aren't checked against Spotify to verify they don't accidentally match real artists.

### Error Handling

- **Bare `except:` clauses** (`app.py`): Catches `SystemExit` and `KeyboardInterrupt`. Use specific exceptions.
- **Broad `except Exception`**: Hides bugs. Log with `exc_info=True` everywhere.
- **Inconsistent error format**: Socket errors use `{"message": "..."}`, REST errors use `{"error": "..."}` or plain text. Standardize.

### Magic Numbers

Hardcoded values scattered across codebase:
- `15` seconds timer
- `30` seconds grace period
- `200` tracks fetch pool
- `30` max songs, `5` max games

Extract to a constants file or make configurable via env vars.

---

## 6. Production & Deployment

### Missing Infrastructure

- **No Dockerfile**: Can't containerize. Add multi-stage Dockerfile.
- **No docker-compose**: For local dev with all services.
- **No CI/CD pipeline**: No GitHub Actions, no automated tests on PR.
- **No health endpoint**: Add `GET /health` returning service status (Spotify, OpenAI, leaderboard storage).
- **No structured logging**: Use JSON format for log aggregation (ELK, CloudWatch).
- **No error tracking**: Add Sentry or similar for production error visibility.
- **No WSGI server**: Running with Flask dev server. Use Gunicorn with eventlet worker.
- **No reverse proxy config**: Need Nginx for SSL termination, static files, WebSocket proxying.

### Scaling Limitations

- **Single process**: Can't scale horizontally. Add Redis for distributed SocketIO and session storage.
- **Synchronous OpenAI calls**: Block the event loop. Use async client or task queue (Celery/RQ).
- **No CDN for static assets**: Serve `static/` through Nginx or a CDN in production.

### Environment & Configuration

- **No startup validation**: App starts even if `SPOTIFY_CLIENT_ID` is missing. Validate required env vars at boot.
- **`SECRET_KEY` defaults to `"dev-secret-key"`** (`app.py:34`): Should fail loudly in production if not set.
- **Port not configurable**: Hardcoded. Use `os.getenv("PORT", 5000)`.

---

## 7. Testing

### Current State

Only manual integration test scripts in `tests/` (Spotify connectivity, preview URLs). No automated test suite.

### Needed

- **Unit tests**: Scoring algorithm, question generation, room state machine, leaderboard service
- **Integration tests**: Full game flow via SocketIO test client, multi-player scenarios
- **E2E tests**: Playwright/Cypress browser tests for host and participant flows
- **Load tests**: Locust scripts for 100+ concurrent players

---

## 8. Code Quality Quick Wins

- Remove dead CSS (`.answer-option.correct`, `.answer-option.incorrect` with "Removed" comments)
- Consolidate duplicate `@keyframes pulse` in `style.css`
- Extract repeated token refresh pattern into a helper function
- Add docstrings to `handle_start_game` (900+ lines, no documentation)
- Remove unused imports (`leave_room` in `app.py`)
- Standardize error response format across REST and Socket handlers
- Add `__all__` exports to `libs/` modules

---

## Priority Summary

| Priority | Items |
|----------|-------|
| **Now** | XSS fixes, room cleanup, answer validation, rate limiting |
| **Soon** | PWA manifest + service worker, base.html template, timer for participants, health endpoint |
| **Next** | Streak system, game modes, Docker, structured logging, unit tests |
| **Later** | Database migration, async architecture, social features, CI/CD, load testing |
