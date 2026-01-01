#!/usr/bin/env python3
"""
Test script to debug Spotify related artists API issues
"""

import os
import sys
from dotenv import load_dotenv
from libs.spotify_oauth_service import get_spotify_oauth_service
from libs.spotify_service import get_spotify_service

load_dotenv()

def test_basic_service():
    print("=" * 60)
    print("Testing Basic Spotify Service (Client Credentials)")
    print("=" * 60)
    
    spotify = get_spotify_service()
    if not spotify:
        print("❌ Basic Spotify service not available")
        return
    
    print("✓ Basic service initialized")
    
    # Test with a well-known artist
    test_artists = [
        "Placebo",
        "Monolink", 
        "The Beatles",
        "Daft Punk"
    ]
    
    for artist_name in test_artists:
        print(f"\n--- Testing: {artist_name} ---")
        
        try:
            # Search for artist
            results = spotify.sp.search(q=f'artist:{artist_name}', type='artist', limit=1)
            
            if not results['artists']['items']:
                print(f"❌ Artist not found: {artist_name}")
                continue
            
            artist = results['artists']['items'][0]
            artist_id = artist['id']
            artist_actual_name = artist['name']
            popularity = artist.get('popularity', 'N/A')
            
            print(f"✓ Found: {artist_actual_name}")
            print(f"  ID: {artist_id}")
            print(f"  Popularity: {popularity}")
            print(f"  Followers: {artist.get('followers', {}).get('total', 'N/A')}")
            print(f"  Genres: {', '.join(artist.get('genres', []))[:50]}")
            
            # Try to get related artists
            print(f"\n  Attempting to fetch related artists...")
            try:
                related = spotify.sp.artist_related_artists(artist_id)
                related_count = len(related.get('artists', []))
                print(f"  ✓ Success! Found {related_count} related artists")
                
                if related_count > 0:
                    print(f"  First 3 related artists:")
                    for ra in related['artists'][:3]:
                        print(f"    - {ra['name']}")
            except Exception as e:
                print(f"  ❌ Failed to get related artists: {e}")
                print(f"     Error type: {type(e).__name__}")
                
        except Exception as e:
            print(f"❌ Error testing {artist_name}: {e}")


def test_oauth_service():
    print("\n\n" + "=" * 60)
    print("Testing OAuth Spotify Service")
    print("=" * 60)
    
    oauth_service = get_spotify_oauth_service()
    if not oauth_service:
        print("❌ OAuth service not available")
        return
    
    print("✓ OAuth service initialized")
    
    # Check for cached token
    cache_path = '.cache'
    token_info = None
    
    if os.path.exists(cache_path):
        print(f"✓ Found cached token at {cache_path}")
        try:
            import json
            with open(cache_path, 'r') as f:
                token_info = json.load(f)
            print("✓ Loaded token from cache")
        except Exception as e:
            print(f"❌ Could not load cached token: {e}")
    
    if not token_info:
        print("\n⚠️  No cached token found")
        print("To test with OAuth:")
        print("  1. Go to your browser and login to the blindtest app")
        print("  2. The .cache file will be created")
        print("  3. Run this script again")
        print("\nOR provide a token manually:")
        
        token = input("\nEnter Spotify access token (or press Enter to skip): ").strip()
        
        if token:
            token_info = {'access_token': token}
        else:
            print("Skipping OAuth tests")
            return
    
    # Get Spotify client with token
    try:
        sp_client = oauth_service.get_spotify_client(token_info)
        if not sp_client:
            print("❌ Could not create authenticated Spotify client")
            return
        
        print("✓ Authenticated Spotify client created")
        
        # Test with artists
        test_artists = ["Placebo", "Monolink", "The Beatles"]
        
        for artist_name in test_artists:
            print(f"\n--- Testing with OAuth: {artist_name} ---")
            fake_artists = oauth_service.get_similar_artists(sp_client, artist_name, limit=3)
            
            if fake_artists:
                print(f"  ✓ Got {len(fake_artists)} similar artists:")
                for fa in fake_artists:
                    print(f"    - {fa}")
            else:
                print(f"  ⚠️  No similar artists found (fallback to genre search)")
        
    except Exception as e:
        print(f"❌ Error testing OAuth: {e}")


def test_api_endpoints_directly():
    print("\n\n" + "=" * 60)
    print("Testing Direct API Access")
    print("=" * 60)
    
    import spotipy
    from spotipy.oauth2 import SpotifyClientCredentials
    
    client_id = os.getenv('SPOTIFY_CLIENT_ID')
    client_secret = os.getenv('SPOTIFY_CLIENT_SECRET')
    
    if not client_id or not client_secret:
        print("❌ Missing credentials")
        return
    
    auth_manager = SpotifyClientCredentials(
        client_id=client_id,
        client_secret=client_secret
    )
    sp = spotipy.Spotify(auth_manager=auth_manager)
    
    # Test a known artist ID
    test_id = "3WrFJ7ztbogyGnTHbHJFl2"  # The Beatles
    
    print(f"\nTesting with The Beatles (ID: {test_id})")
    
    try:
        # Get artist info
        artist = sp.artist(test_id)
        print(f"✓ Artist fetched: {artist['name']}")
        
        # Get related artists
        related = sp.artist_related_artists(test_id)
        print(f"✓ Related artists: {len(related['artists'])} found")
        
    except Exception as e:
        print(f"❌ Error: {e}")


def main():
    print("🎵 Spotify Related Artists Test Script")
    print("Testing various methods to fetch related artists\n")
    
    # Check credentials
    if not os.getenv('SPOTIFY_CLIENT_ID') or not os.getenv('SPOTIFY_CLIENT_SECRET'):
        print("❌ Missing Spotify credentials in .env file")
        return 1
    
    test_basic_service()
    test_oauth_service()
    test_api_endpoints_directly()
    
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print("If related artists fail with 404:")
    print("  1. The artist might not have related artists data")
    print("  2. The Spotify API might have regional restrictions")
    print("  3. The endpoint may require different scopes")
    print("\nFallback strategy: Use genre-based search instead")
    print("=" * 60)
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
