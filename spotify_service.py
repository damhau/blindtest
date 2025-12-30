import os
import spotipy
from spotipy.oauth2 import SpotifyClientCredentials
from dotenv import load_dotenv

load_dotenv()


class SpotifyService:
    def __init__(self):
        client_id = os.getenv('SPOTIFY_CLIENT_ID')
        client_secret = os.getenv('SPOTIFY_CLIENT_SECRET')
        
        if not client_id or not client_secret:
            raise ValueError("Spotify credentials not found in environment variables")
        
        auth_manager = SpotifyClientCredentials(
            client_id=client_id,
            client_secret=client_secret
        )
        self.sp = spotipy.Spotify(auth_manager=auth_manager)

    def extract_playlist_id(self, playlist_input):
        """Extract playlist ID from URL or return ID if already provided"""
        if 'spotify.com' in playlist_input:
            # Extract from URL
            if '/playlist/' in playlist_input:
                playlist_id = playlist_input.split('/playlist/')[1].split('?')[0]
                return playlist_id
        return playlist_input

    def get_playlist_tracks(self, playlist_id, limit=10):
        """
        Fetch tracks from a Spotify playlist
        Returns tuple: (tracks_list, error_message)
        """
        try:
            playlist_id = self.extract_playlist_id(playlist_id)
            
            # Validate playlist ID format
            if not playlist_id or len(playlist_id) < 10:
                return [], "Invalid playlist ID format"
            
            results = self.sp.playlist_tracks(playlist_id, limit=limit)
            tracks = []
            
            for item in results['items']:
                track = item['track']
                if not track:
                    continue
                    
                # Get main artist
                artists = track['artists']
                if not artists:
                    continue
                    
                main_artist = artists[0]['name']
                
                # Get preview URL (30 second preview)
                preview_url = track.get('preview_url')
                
                # Some tracks don't have preview URLs
                if not preview_url:
                    continue
                
                track_data = {
                    'name': track['name'],
                    'artist': main_artist,
                    'preview_url': preview_url,
                    'album': track['album']['name'],
                    'cover_url': track['album']['images'][0]['url'] if track['album']['images'] else None,
                    'duration': track['duration_ms']
                }
                
                tracks.append(track_data)
            
            if not tracks:
                return [], "No tracks with preview URLs found in this playlist. Try a different playlist."
            
            return tracks, None
        
        except Exception as e:
            error_str = str(e)
            if '404' in error_str:
                return [], "Playlist not found. Make sure the playlist is public and the ID is correct."
            elif '401' in error_str or '403' in error_str:
                return [], "Authentication failed. Check your Spotify API credentials."
            else:
                print(f"Error fetching playlist: {e}")
                return [], f"Error loading playlist: {error_str[:100]}"

    def search_artist(self, artist_name):
        """Search for artist to verify they exist"""
        try:
            results = self.sp.search(q=f'artist:{artist_name}', type='artist', limit=1)
            if results['artists']['items']:
                return results['artists']['items'][0]['name']
            return None
        except Exception as e:
            print(f"Error searching artist: {e}")
            return None

    def get_similar_artists(self, artist_name, limit=3):
        """
        Get similar artists from Spotify (alternative to OpenAI for fake answers)
        """
        try:
            # Search for the artist
            results = self.sp.search(q=f'artist:{artist_name}', type='artist', limit=1)
            
            if not results['artists']['items']:
                return []
            
            artist_id = results['artists']['items'][0]['id']
            
            # Get related artists
            related = self.sp.artist_related_artists(artist_id)
            
            similar_names = [artist['name'] for artist in related['artists'][:limit]]
            
            return similar_names
        
        except Exception as e:
            print(f"Error getting similar artists: {e}")
            return []


# Helper function to create service instance
def get_spotify_service():
    try:
        return SpotifyService()
    except ValueError as e:
        print(f"Warning: {e}")
        return None
