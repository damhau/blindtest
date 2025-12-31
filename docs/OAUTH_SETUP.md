# Spotify OAuth Setup Guide

## Configure Spotify Developer App

1. **Go to Spotify Developer Dashboard**
   - https://developer.spotify.com/dashboard

2. **Create or Edit your app**
   - Click on your app name

3. **Add Redirect URI**
   - Click "Edit Settings"
   - Under "Redirect URIs", add:
     ```
     http://localhost:5000/callback
     ```
   - Click "Add"
   - Click "Save" at the bottom

4. **Update your .env file**
   ```bash
   SPOTIFY_CLIENT_ID=your_client_id
   SPOTIFY_CLIENT_SECRET=your_client_secret
   SPOTIFY_REDIRECT_URI=http://localhost:5000/callback
   OPENAI_API_KEY=your_openai_key
   SECRET_KEY=your_flask_secret
   ```

## How It Works

### For Hosts:
1. When creating a room, the host can choose to:
   - **Login with Spotify** (recommended) - Full track playback with Spotify Premium
   - **Skip** - Use preview URLs (30 seconds, limited availability)

2. After logging in with Spotify:
   - Host authorizes the app
   - Gets redirected back with authentication
   - Can play full tracks from any playlist they have access to

### For Participants:
- No Spotify login needed
- They just join with the PIN and play

## Testing

1. Start the server:
   ```bash
   uv run python app.py
   ```

2. Go to http://localhost:5000/host

3. Click "Login with Spotify"

4. Authorize the app

5. You'll be redirected back and can create a room with full playback!

## Notes

- **Spotify Premium** is recommended but not strictly required
- Preview URLs (30 seconds) still work as fallback
- OAuth tokens are session-based and expire after some time
- Each host authenticates individually
