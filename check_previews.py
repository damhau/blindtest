#!/usr/bin/env python3
"""
Find playlists with tracks that have preview URLs
"""
import os
from dotenv import load_dotenv
import spotipy
from spotipy.oauth2 import SpotifyClientCredentials

load_dotenv()

def check_playlist_previews(playlist_id):
    """Check how many tracks in a playlist have preview URLs"""
    client_id = os.getenv('SPOTIFY_CLIENT_ID')
    client_secret = os.getenv('SPOTIFY_CLIENT_SECRET')
    
    auth_manager = SpotifyClientCredentials(client_id=client_id, client_secret=client_secret)
    sp = spotipy.Spotify(auth_manager=auth_manager)
    
    try:
        results = sp.playlist_tracks(playlist_id, limit=50)
        
        total = len(results['items'])
        with_preview = 0
        without_preview = 0
        
        print(f"Checking playlist {playlist_id}...")
        print(f"Total tracks: {total}\n")
        
        for item in results['items']:
            track = item['track']
            if not track:
                continue
            
            has_preview = track.get('preview_url') is not None
            
            if has_preview:
                with_preview += 1
                print(f"✓ {track['name']} - {track['artists'][0]['name']}")
            else:
                without_preview += 1
                print(f"✗ {track['name']} - {track['artists'][0]['name']}")
        
        print(f"\n{'='*60}")
        print(f"Summary:")
        print(f"  With preview URLs: {with_preview} ({with_preview/total*100:.1f}%)")
        print(f"  Without preview URLs: {without_preview} ({without_preview/total*100:.1f}%)")
        
        if with_preview >= 10:
            print(f"\n✅ This playlist has enough tracks ({with_preview}) for the game!")
        else:
            print(f"\n⚠️  This playlist only has {with_preview} tracks with previews. Need at least 10.")
        
    except Exception as e:
        print(f"Error: {e}")

def find_playlists_with_previews():
    """Search for playlists and check preview availability"""
    client_id = os.getenv('SPOTIFY_CLIENT_ID')
    client_secret = os.getenv('SPOTIFY_CLIENT_SECRET')
    
    auth_manager = SpotifyClientCredentials(client_id=client_id, client_secret=client_secret)
    sp = spotipy.Spotify(auth_manager=auth_manager)
    
    print("🔍 Searching for playlists with preview URLs...\n")
    
    queries = ['hits', 'pop', 'rock', 'party']
    good_playlists = []
    
    for query in queries:
        results = sp.search(q=query, type='playlist', limit=5)
        
        for playlist in results['playlists']['items']:
            if not playlist:
                continue
            
            try:
                tracks = sp.playlist_tracks(playlist['id'], limit=20)
                
                with_preview = 0
                for item in tracks['items']:
                    track = item.get('track')
                    if track and track.get('preview_url'):
                        with_preview += 1
                
                preview_pct = (with_preview / len(tracks['items']) * 100) if tracks['items'] else 0
                
                if with_preview >= 10:
                    good_playlists.append({
                        'name': playlist['name'],
                        'id': playlist['id'],
                        'owner': playlist['owner']['display_name'],
                        'tracks': playlist['tracks']['total'],
                        'previews': with_preview,
                        'preview_pct': preview_pct
                    })
                    
            except Exception as e:
                continue
    
    print(f"\n✅ Found {len(good_playlists)} playlists with preview URLs:\n")
    
    for idx, p in enumerate(good_playlists[:10], 1):
        print(f"{idx}. {p['name']}")
        print(f"   ID: {p['id']}")
        print(f"   Owner: {p['owner']}")
        print(f"   Tracks: {p['tracks']} ({p['previews']} with previews - {p['preview_pct']:.0f}%)")
        print()

if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1:
        # Check specific playlist
        playlist_id = sys.argv[1]
        check_playlist_previews(playlist_id)
    else:
        # Search for good playlists
        find_playlists_with_previews()
