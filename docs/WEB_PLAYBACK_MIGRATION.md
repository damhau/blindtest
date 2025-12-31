# Web Playback SDK Migration Guide

## Issue: "Invalid token scopes" Error

If you're seeing this error in the browser console:
```
GET https://api.spotify.com/v1/melody/v1/check_scope?scope=web-playback 403 (Forbidden)
Authentication Error: Invalid token scopes.
```

This means your Spotify access token doesn't include the required `streaming` scope for Web Playback SDK.

## Solution: Re-authenticate with Updated Scopes

The OAuth scopes have been updated to include:
- ✅ **streaming** - Required for Web Playback SDK (NEW!)
- ✅ **user-read-email** - User identification (NEW!)
- ✅ **user-read-private** - User profile info (NEW!)
- user-read-playback-state - Control playback
- user-modify-playback-state - Control playback  
- playlist-read-private - Access playlists
- playlist-read-collaborative - Access collaborative playlists

### Steps to Fix:

1. **Open the host page** in your browser

2. **Click the "Logout" button**
   - This will clear your session AND delete the cached token file
   - The cached token (`.cache` file) contains the old scopes

3. **Click "Login with Spotify"**
   - You'll be redirected to Spotify's authorization page
   - You'll see the new permissions listed including "Web Playback"

4. **Click "Agree" / "Accept"** on Spotify's authorization page

5. **You'll be redirected back** to the host page with full Web Playback SDK access

### What Changed?

The `spotify_oauth_service.py` now requests these scopes:
```python
self.scope = "streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative"
```

Previously it was missing:
- `streaming` (critical for Web Playback SDK)
- `user-read-email` (needed for SDK authentication)
- `user-read-private` (needed for SDK authentication)

### Verify Your Token

Run this command to check your current scopes:
```bash
uv run python check_token_scopes.py
```

### Still Having Issues?

1. **Check if you have Spotify Premium**
   - Web Playback SDK requires Premium
   - Without Premium, the app falls back to 30-second preview URLs

2. **Manually delete the cache file**
   ```bash
   rm .cache
   ```

3. **Clear browser cookies** for your domain

4. **Try incognito/private browsing mode** to test with a fresh session

5. **Verify redirect URI** matches exactly in Spotify Dashboard
   - Settings → Redirect URIs → Must match your `.env` SPOTIFY_REDIRECT_URI

### Technical Details

The Web Playback SDK needs the `streaming` scope to:
- Initialize the Spotify.Player instance
- Check scope validity with `/v1/melody/v1/check_scope`
- Obtain Widevine licenses for DRM-protected content
- Stream full tracks in the browser

Without this scope, you'll see 403 Forbidden errors for these operations.

## References

- [Spotify Web Playback SDK Guide](https://developer.spotify.com/documentation/web-playback-sdk/guide/)
- [Spotify Authorization Scopes](https://developer.spotify.com/documentation/web-api/concepts/scopes)
- [Official Example Repo](https://github.com/spotify/spotify-web-playback-sdk-example)
