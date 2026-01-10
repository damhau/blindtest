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

    def __init__(self, user_id=None, use_cache=True):
        self.client_id = os.getenv("SPOTIFY_CLIENT_ID")
        self.client_secret = os.getenv("SPOTIFY_CLIENT_SECRET")
        self.redirect_uri = os.getenv("SPOTIFY_REDIRECT_URI", "http://localhost:5000/callback")

        if not self.client_id or not self.client_secret:
            raise ValueError("Spotify credentials not found in environment variables")

        # Scopes needed for Web Playback SDK and reading playlists
        # streaming: Required for Web Playback SDK
        # user-read-email, user-read-private: Required for SDK authentication
        # user-read-playback-state, user-modify-playback-state: Control playback
        # playlist-read-private, playlist-read-collaborative: Access user playlists
        # user-top-read: Access user's top artists and tracks
        # user-library-read: Access user's saved tracks
        self.scope = "streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative user-top-read user-library-read"

        # Create per-user cache directory and determine cache path
        self.cache_dir = ".spotify_cache"
        self.cache_path = None

        if use_cache:
            os.makedirs(self.cache_dir, exist_ok=True)
            # Use user-specific cache file if user_id provided
            if user_id:
                self.cache_path = os.path.join(self.cache_dir, f"{user_id}.json")
            else:
                # For global service without user_id, don't use cache
                self.cache_path = None

        self.sp_oauth = SpotifyOAuth(
            client_id=self.client_id,
            client_secret=self.client_secret,
            redirect_uri=self.redirect_uri,
            scope=self.scope,
            cache_path=self.cache_path,
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
        """Create authenticated Spotify client and return (client, refreshed_token_info)"""
        if not token_info:
            return None, None

        # Check if token needs refresh
        if self.sp_oauth.is_token_expired(token_info):
            print("Token expired, refreshing...")
            token_info = self.sp_oauth.refresh_access_token(token_info["refresh_token"])

        client = spotipy.Spotify(auth=token_info["access_token"])
        return client, token_info

    def get_liked_songs_tracks(self, sp_client, limit=50):
        """
        Fetch tracks from user's Liked Songs collection
        Returns tuple: (tracks_list, error_message)
        """
        try:
            results = sp_client.current_user_saved_tracks(limit=limit)
            tracks = []

            for item in results["items"]:
                track = item["track"]
                if not track:
                    continue

                artists = track["artists"]
                if not artists:
                    continue

                main_artist = artists[0]["name"]

                track_data = {
                    "name": track["name"],
                    "artist": main_artist,
                    "uri": track["uri"],
                    "preview_url": track.get("preview_url"),
                    "album": track["album"]["name"],
                    "cover_url": (
                        track["album"]["images"][0]["url"] if track["album"]["images"] else None
                    ),
                    "duration": track["duration_ms"],
                }

                tracks.append(track_data)

            if not tracks:
                return [], "No liked songs found."

            return tracks, None

        except Exception as e:
            print(f"Error fetching liked songs: {e}")
            return [], f"Error fetching liked songs: {str(e)}"

    def extract_playlist_id(self, playlist_input):
        """Extract playlist ID from URL or return ID if already provided"""
        if "spotify.com" in playlist_input:
            if "/playlist/" in playlist_input:
                playlist_id = playlist_input.split("/playlist/")[1].split("?")[0]
                return playlist_id
        return playlist_input

    def get_playlist_tracks(self, sp_client, playlist_id, limit=10, fetch_pool_size=200):
        """
        Fetch tracks from a Spotify playlist using authenticated client
        Fetches a larger pool from random offset for better variety
        Returns tuple: (tracks_list, error_message)
        """
        try:
            # Handle special "Liked Songs" collection
            if playlist_id == "liked-songs":
                return self.get_liked_songs_tracks(sp_client, limit)

            playlist_id = self.extract_playlist_id(playlist_id)

            if not playlist_id or len(playlist_id) < 10:
                return [], "Invalid playlist ID format"

            # Get current user's market for better track availability
            try:
                user_profile = sp_client.current_user()
                market = user_profile.get("country", "US")
            except:
                market = "US"

            # Get playlist info to know total tracks
            try:
                playlist_info = sp_client.playlist(playlist_id, fields="tracks.total")
                total_tracks = playlist_info["tracks"]["total"]
                print(f"Playlist has {total_tracks} total tracks")
            except:
                total_tracks = fetch_pool_size

            # Determine fetch strategy based on playlist size
            if total_tracks <= fetch_pool_size:
                # Small playlist: fetch all
                pool_size = total_tracks
                offset = 0
                print(f"Fetching all {pool_size} tracks")
            else:
                # Large playlist: fetch random chunk
                import random

                pool_size = fetch_pool_size
                max_offset = total_tracks - pool_size
                offset = random.randint(0, max_offset)
                print(f"Fetching {pool_size} tracks from offset {offset} (total: {total_tracks})")

            # Fetch tracks in batches with pagination
            all_tracks = []
            remaining = pool_size
            current_offset = offset

            while remaining > 0:
                batch_size = min(100, remaining)  # Spotify API max is 100 per request
                results = sp_client.playlist_tracks(
                    playlist_id, limit=batch_size, offset=current_offset, market=market
                )

                for item in results["items"]:
                    track = item["track"]
                    if not track:
                        continue

                    artists = track["artists"]
                    if not artists:
                        continue

                    main_artist = artists[0]["name"]

                    # With OAuth, we get access to full tracks, not just previews
                    track_data = {
                        "name": track["name"],
                        "artist": main_artist,
                        "uri": track["uri"],  # Spotify URI for playback
                        "preview_url": track.get(
                            "preview_url"
                        ),  # May still be None, but we can use Web Playback SDK
                        "album": track["album"]["name"],
                        "cover_url": (
                            track["album"]["images"][0]["url"] if track["album"]["images"] else None
                        ),
                        "duration": track["duration_ms"],
                    }

                    all_tracks.append(track_data)

                # Break if we got fewer items than requested (end of playlist)
                if len(results["items"]) < batch_size:
                    break

                remaining -= batch_size
                current_offset += batch_size

            if not all_tracks:
                return [], "No tracks found in this playlist."

            print(f"Fetched {len(all_tracks)} tracks from playlist")

            # Randomly select from pool if limit specified
            if limit and len(all_tracks) > limit:
                import random

                selected_tracks = random.sample(all_tracks, limit)
                return selected_tracks, None

            return all_tracks, None

        except Exception as e:
            error_str = str(e)
            if "404" in error_str:
                return [], "Playlist not found. Make sure the ID is correct."
            elif "401" in error_str or "403" in error_str:
                return [], "Authentication failed. Please log in again."
            else:
                print(f"Error fetching playlist: {e}")
                return [], f"Error loading playlist: {error_str[:100]}"

    def get_similar_artists(self, sp_client, artist_name, limit=3):
        """Get similar artists using genre-based search (related artists API is deprecated)"""
        try:
            # Search for the artist
            results = sp_client.search(q=f"artist:{artist_name}", type="artist", limit=1)

            if not results["artists"]["items"]:
                print(f"No artist found for: {artist_name}")
                return self._generate_plausible_names(artist_name, limit)

            artist = results["artists"]["items"][0]
            artist_id = artist["id"]
            artist_actual_name = artist["name"]
            print(f"Found artist {artist_actual_name} (ID: {artist_id})")

            # Try genre-based search (related artists endpoint is deprecated)
            genres = artist.get("genres", [])

            if genres:
                print(f"Using genres: {', '.join(genres[:2])}")
                # Use the first genre to find similar artists
                try:
                    genre_results = sp_client.search(
                        q=f'genre:"{genres[0]}"', type="artist", limit=20
                    )
                    similar_names = [
                        a["name"]
                        for a in genre_results["artists"]["items"]
                        if a["name"] != artist_actual_name and a.get("popularity", 0) > 20
                    ][:limit]

                    if len(similar_names) >= limit:
                        print(f"Found {len(similar_names)} artists via genre search")
                        return similar_names
                except Exception as e:
                    print(f"Genre search failed: {e}")

            # If no genres or not enough results, search for artists with similar style
            print(f"Trying text-based search for similar artists")
            try:
                # Search for artists that might be similar based on name patterns
                search_results = sp_client.search(
                    q=artist_actual_name.split()[0], type="artist", limit=20
                )
                similar_names = [
                    a["name"]
                    for a in search_results["artists"]["items"]
                    if a["name"] != artist_actual_name and a.get("popularity", 0) > 10
                ][:limit]

                if similar_names:
                    print(f"Found {len(similar_names)} artists via text search")
                    return similar_names
            except Exception as e:
                print(f"Text search failed: {e}")

            # Ultimate fallback: generate plausible artist names
            print(f"Using name generation fallback")
            return self._generate_plausible_names(artist_name, limit)

        except Exception as e:
            print(f"Error in get_similar_artists: {e}")
            return self._generate_plausible_names(artist_name, limit)

    def _generate_plausible_names(self, artist_name, count=3):
        """Generate plausible fake artist names as last resort"""
        import random

        prefixes = ["The", "New", "Young", "Modern", "Electric", "Digital", "Urban", "Wild"]
        suffixes = ["Band", "Project", "Collective", "Sound", "Music", "Wave", "Echo"]
        adjectives = ["Blue", "Red", "Dark", "Bright", "Silent", "Loud", "Fast", "Slow"]
        nouns = ["Moon", "Sun", "Star", "Ocean", "Mountain", "River", "Forest", "Desert"]

        names = []
        for _ in range(count):
            style = random.choice(["prefix_suffix", "adjective_noun", "single"])
            if style == "prefix_suffix":
                names.append(f"{random.choice(prefixes)} {random.choice(suffixes)}")
            elif style == "adjective_noun":
                names.append(f"{random.choice(adjectives)} {random.choice(nouns)}")
            else:
                names.append(f"{random.choice(nouns)}{random.choice(suffixes)}")

        return names

    def clear_user_cache(self, user_id=None):
        """Clear cache for a specific user or the current instance's user"""
        cache_path = self.cache_path
        if user_id:
            cache_path = os.path.join(self.cache_dir, f"{user_id}.json")

        if os.path.exists(cache_path):
            try:
                os.remove(cache_path)
                print(f"Removed cached token at {cache_path}")
                return True
            except Exception as e:
                print(f"Could not remove cache file {cache_path}: {e}")
                return False
        return True


def get_spotify_oauth_service(user_id=None, use_cache=True):
    """Helper function to create OAuth service instance"""
    try:
        return SpotifyOAuthService(user_id=user_id, use_cache=use_cache)
    except ValueError as e:
        print(f"Warning: {e}")
        return None
