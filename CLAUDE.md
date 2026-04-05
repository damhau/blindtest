# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Blindtest is a multiplayer music quiz web app. A host creates a room (4-digit PIN), picks a Spotify playlist, and players join to guess the artist of each song. Fake artist names are generated via OpenAI as distractors.

## Commands

```bash
uv sync                    # Install dependencies
uv run python app.py       # Run the app (serves on http://localhost:5000)
```

There is no test suite, linter, or CI pipeline. The `tests/` directory contains manual API verification scripts (Spotify connectivity, playlist access, preview URLs), not automated tests.

## Architecture

**Backend:** Single Flask app (`app.py`) with Socket.IO for real-time multiplayer. Uses eventlet async mode. All game state is in-memory (no database).

**Frontend:** Server-rendered Jinja2 templates with vanilla JS and Tailwind CSS (CDN). No build step.

### Key files

- `app.py` — Flask routes, Socket.IO event handlers, `Room` class, scoring logic, question generation pipeline. This is the main file (~2300 lines).
- `libs/spotify_service.py` — Spotify Client Credentials wrapper (public playlists only)
- `libs/spotify_oauth_service.py` — Spotify OAuth flow (private playlists, Web Playback SDK, Spotify Connect)
- `libs/openai_service.py` — Fake artist name generation with MusicBrainz fallback
- `static/js/host.js` — Host-side game logic, Spotify Web Playback SDK integration
- `static/js/participant.js` — Player-side UI and answer submission
- `static/js/utils.js` — Shared utilities (avatars via DiceBear, toast notifications, connection overlays)
- `static/css/style.css` — Shared styles with CSS custom properties (colors defined as `--color-*` variables)

### Communication model

All game interactions use Socket.IO events (not REST). Key event flows:

- Host: `create_room` -> `join_room` -> `start_game` -> `next_question` (loop) -> `end_game`
- Player: `join_room` -> `submit_answer` (per question) -> `ready_for_next`

### Authentication tiers

1. **No auth (default):** Client Credentials — public playlists only
2. **Spotify OAuth:** Enables private playlists, Liked Songs, Web Playback SDK. Tokens cached per user in `.spotify_cache/`
3. **Spotify Connect:** Delegates playback to any authorized Spotify device

### Scoring

Rank-based + time-based + song progression multiplier. The formula is in `app.py` in the `submit_answer` handler. Points increase for songs later in the game (1x first 50%, 2x 50-80%, 4x last 20%).

## Configuration

Copy `.env.example` to `.env` with: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`, `OPENAI_API_KEY`, `SECRET_KEY`.
