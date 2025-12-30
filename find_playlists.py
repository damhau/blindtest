#!/usr/bin/env python3
"""
Find valid Spotify playlists by searching
"""
import os
from dotenv import load_dotenv
import spotipy
from spotipy.oauth2 import SpotifyClientCredentials

load_dotenv()

def find_playlists():
    client_id = os.getenv('SPOTIFY_CLIENT_ID')
    client_secret = os.getenv('SPOTIFY_CLIENT_SECRET')
    
    auth_manager = SpotifyClientCredentials(client_id=client_id, client_secret=client_secret)
    sp = spotipy.Spotify(auth_manager=auth_manager)
    
    print("🔍 Searching for public playlists...")
    print()
    
    # Search for popular playlists
    results = sp.search(q='rock', type='playlist', limit=10)
    
    print(f"Found {len(results['playlists']['items'])} playlists:\n")
    
    for idx, playlist in enumerate(results['playlists']['items'], 1):
        if not playlist:
            continue
        print(f"{idx}. {playlist['name']}")
        print(f"   Owner: {playlist['owner']['display_name']}")
        print(f"   ID: {playlist['id']}")
        print(f"   Tracks: {playlist['tracks']['total']}")
        
        # Try to fetch tracks from this playlist
        try:
            tracks = sp.playlist_tracks(playlist['id'], limit=3)
            print(f"   ✓ Accessible - {len(tracks['items'])} tracks fetched")
            
            # Show first track
            if tracks['items']:
                first_track = tracks['items'][0]['track']
                if first_track:
                    print(f"   Sample: {first_track['name']} - {first_track['artists'][0]['name']}")
        except Exception as e:
            print(f"   ❌ Not accessible: {e}")
        
        print()

if __name__ == "__main__":
    find_playlists()
