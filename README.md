# 🎵 Blindtest Multiplayer App

A web-based multiplayer music quiz game using Spotify playlists. Players compete to guess the artist of songs played from a Spotify playlist!

## Features

- 🎮 **Multiplayer**: Host creates a room, players join with a 4-digit PIN
- 🎵 **Spotify Integration**: Use any public Spotify playlist
- 🤖 **AI-Generated Options**: OpenAI generates plausible fake artist names
- 🎨 **Color-Coded Answers**: Red, Blue, Yellow, Green buttons for easy mobile play
- 🏆 **Live Scoring**: Real-time leaderboard updates
- 📱 **Responsive Design**: Works on desktop and mobile

## Setup

### Prerequisites

- Python 3.8+
- Spotify Developer Account
- OpenAI API Account

### Installation

1. **Clone and navigate to the project:**
```bash
cd /home/damien/code/perso/blindtest
```

2. **Install uv (if not already installed):**
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

3. **Install dependencies:**
```bash
uv sync
```

4. **Get API Credentials:**

   **Spotify:**
   - Go to https://developer.spotify.com/dashboard
   - Create a new app
   - Copy Client ID and Client Secret

   **OpenAI:**
   - Go to https://platform.openai.com/api-keys
   - Create a new API key

5. **Create `.env` file:**
```bash
cp .env.example .env
```

6. **Edit `.env` with your credentials:**
```
SPOTIFY_CLIENT_ID=your_actual_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_actual_spotify_client_secret
OPENAI_API_KEY=your_actual_openai_api_key
SECRET_KEY=any_random_secret_key_here
```

7. **Run the application:**
```bash
uv run python app.py
```

Or activate the virtual environment first:
```bash
source .venv/bin/activate
python app.py
```

8. **Open in browser:**
   - Host: http://localhost:5000/host
   - Participant: http://localhost:5000/participant
   - Or start at: http://localhost:5000

## How to Play

### As a Host:

1. Go to `/host` or click "Create Room"
2. Enter a Spotify playlist ID or URL
   - Example: `https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M`
   - Or just the ID: `37i9dQZF1DXcBWIGoYBM5M`
3. Share the 4-digit PIN with players
4. Wait for players to join
5. Click "Start Game"
6. For each song:
   - Audio plays automatically
   - 4 artist options shown with colors
   - Click "Next Song" to reveal answer and continue

### As a Player:

1. Go to `/participant` or click "Join Room"
2. Enter your name
3. Enter the 4-digit PIN from the host
4. Wait for the game to start
5. For each song:
   - Tap the colored button (Red/Blue/Yellow/Green)
   - Get instant feedback on your answer
   - See your score and leaderboard

## Finding Spotify Playlists

1. Open Spotify (web or app)
2. Find any public playlist
3. Click "Share" → "Copy Playlist Link"
4. Paste the entire URL or just extract the ID

Example URLs:
- `https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M`
- ID only: `37i9dQZF1DXcBWIGoYBM5M`

## Project Structure

```
blindtest/
├── app.py                  # Flask backend with Socket.IO
├── spotify_service.py      # Spotify API integration
├── openai_service.py       # Generate fake artist names
├── requirements.txt        # Python dependencies
├── .env.example           # Environment variables template
├── templates/             # HTML templates
│   ├── index.html        # Home page
│   ├── host.html         # Host interface
│   └── participant.html  # Player interface
└── static/
    ├── css/
    │   └── style.css     # Styles
    └── js/
        ├── host.js       # Host logic
        └── participant.js # Player logic
```

## Technologies Used

- **Backend**: Python, Flask, Flask-SocketIO
- **Frontend**: HTML, CSS, JavaScript, Socket.IO client
- **APIs**: Spotify Web API, OpenAI GPT-3.5
- **Real-time**: WebSockets for live multiplayer

## Troubleshooting

**"Spotify service not configured"**
- Check your `.env` file has correct Spotify credentials
- Make sure you created a Spotify app at developer.spotify.com

**"Could not load playlist tracks"**
- Verify the playlist is public
- Check the playlist ID is correct
- Some playlists don't have preview URLs (use different playlist)

**Players can't connect**
- Make sure both host and players use the same server
- Check firewall settings if hosting remotely

## Future Enhancements

- [ ] Add timer for each question
- [ ] Support for multiple game modes
- [ ] Player avatars
- [ ] Sound effects
- [ ] Game history/statistics
- [ ] Private playlists support
- [ ] Custom difficulty levels

## License

MIT License - feel free to use and modify!
