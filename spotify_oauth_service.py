import os
import spotipy
from spotipy.oauth2 import SpotifyOAuth
from dotenv import load_dotenv

load_dotenv()


class SpotifyOAuthService:
    """
    Spotify service with OAuth authentication for full playback access
    Requires user to authenticate with their Spotify account
    """
    
    def __init__(self):
        self.client_id = os.getenv('SPOTIFY_CLIENT_ID')
        self.client_secret = os.getenv('SPOTIFY_CLIENT_SECRET')
        self.redirect_uri = os.getenv('SPOTIFY_REDIRECT_URI', 'http://localhost:5000/callback')
        
        if not self.client_id or not self.client_secret:
            raise ValueError("Spotify credentials not found in environment variables")
        
        # Scopes needed for playback and reading playlists
        self.scope = "user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative"
        
        self.sp_oauth = SpotifyOAuth(
            client_id=self.client_id,
            client_secret=self.client_secret,
            redirect_uri=self.redirect_uri,
            scope=self.scope,
            cache_path=".spotify_cache"
        )
    
    def get_auth_url(self):
        """Get Spotify authorization URL for user to authenticate"""
        return self.sp_oauth.get_authorize_url()
    
    def get_access_token(self, code):
        """Exchange authorization code for access token"""
        try:
            token_info = self.sp_oauth.get_access_token(code)
            return token_info
        except Exception as e:
            print(f"Error getting access token: {e}")
            return None
    
    def get_spotify_client(self, token_info):
        """Create authenticated Spotify client"""
        if not token_info:
            return None
        
        # Check if token needs refresh
        if self.sp_oauth.is_token_expired(token_info):
            token_info = self.sp_oauth.refresh_access_token(token_info['refresh_token'])
        
        return spotipy.Spotify(auth=token_info['access_token'])
    
    def extract_playlist_id(self, playlist_input):
        """Extract playlist ID from URL or return ID if already provided"""
        if 'spotify.com' in playlist_input:
            if '/playlist/' in playlist_input:
                playlist_id = playlist_input.split('/playlist/')[1].split('?')[0]
                return playlist_id
        return playlist_input
    
    def get_playlist_tracks(self, sp_client, playlist_id, limit=10):
        """
        Fetch tracks from a Spotify playlist using authenticated client
        Returns tuple: (tracks_list, error_message)
        """
        try:
            playlist_id = self.extract_playlist_id(playlist_id)
            
            if not playlist_id or len(playlist_id) < 10:
                return [], "Invalid playlist ID format"
            
            results = sp_client.playlist_tracks(playlist_id, limit=limit)
            tracks = []
            
            for item in results['items']:
                track = item['track']
                if not track:
                    continue
                
                artists = track['artists']
                if not artists:
                    continue
                
                main_artist = artists[0]['name']
                
                # With OAuth, we get access to full tracks, not just previews
                track_data = {
                    'name': track['name'],
                    'artist': main_artist,
                    'uri': track['uri'],  # Spotify URI for playback
                    'preview_url': track.get('preview_url'),  # May still be None, but we can use Web Playback SDK
                    'album': track['album']['name'],
                    'cover_url': track['album']['images'][0]['url'] if track['album']['images'] else None,
                    'duration': track['duration_ms']
                }
                
                tracks.append(track_data)
            
            if not tracks:
                return [], "No tracks found in this playlist."
            
            return tracks, None
        
        except Exception as e:
            error_str = str(e)
            if '404' in error_str:
                return [], "Playlist not found. Make sure the ID is correct."
            elif '401' in error_str or '403' in error_str:
                return [], "Authentication failed. Please log in again."
            else:
                print(f"Error fetching playlist: {e}")
                return [], f"Error loading playlist: {error_str[:100]}"
    
    def get_similar_artists(self, sp_client, artist_name, limit=3):
        """Get similar artists from Spotify"""
        try:
            results = sp_client.search(q=f'artist:{artist_name}', type='artist', limit=1)
            
            if not results['artists']['items']:
                return []
            
            artist_id = results['artists']['items'][0]['id']
            related = sp_client.artist_related_artists(artist_id)
            
            similar_names = [artist['name'] for artist in related['artists'][:limit]]
            return similar_names
        
        except Exception as e:
            print(f"Error getting similar artists: {e}")
            return []


def get_spotify_oauth_service():
    """Helper function to create OAuth service instance"""
    try:
        return SpotifyOAuthService()
    except ValueError as e:
        print(f"Warning: {e}")
        return None
