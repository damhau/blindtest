#!/usr/bin/env python3
"""
Quick test script for Spotify API access
"""
import os
from dotenv import load_dotenv
import spotipy
from spotipy.oauth2 import SpotifyClientCredentials

load_dotenv()

def test_spotify_api():
    print("🎵 Testing Spotify API Access")
    print("=" * 50)
    print()
    
    # Check credentials
    client_id = os.getenv('SPOTIFY_CLIENT_ID')
    client_secret = os.getenv('SPOTIFY_CLIENT_SECRET')
    
    print("1. Checking credentials...")
    if not client_id:
        print("   ❌ SPOTIFY_CLIENT_ID not found in .env")
        return False
    else:
        print(f"   ✓ SPOTIFY_CLIENT_ID: {client_id[:10]}...")
    
    if not client_secret:
        print("   ❌ SPOTIFY_CLIENT_SECRET not found in .env")
        return False
    else:
        print(f"   ✓ SPOTIFY_CLIENT_SECRET: {client_secret[:10]}...")
    
    print()
    
    # Test authentication
    print("2. Testing authentication...")
    try:
        auth_manager = SpotifyClientCredentials(
            client_id=client_id,
            client_secret=client_secret
        )
        sp = spotipy.Spotify(auth_manager=auth_manager)
        print("   ✓ Authentication successful")
    except Exception as e:
        print(f"   ❌ Authentication failed: {e}")
        return False
    
    print()
    
    # Test fetching a known public playlist (Spotify's Top 50 Global)
    print("3. Testing playlist access...")
    test_playlist_id = "37i9dQZF1DXcBWIGoYBM5M"  # Top 50 Global
    
    try:
        results = sp.playlist_tracks(test_playlist_id, limit=5)
        track_count = len(results['items'])
        print(f"   ✓ Successfully fetched {track_count} tracks from test playlist")
        
        print()
        print("   Sample tracks:")
        for idx, item in enumerate(results['items'], 1):
            track = item['track']
            if track:
                print(f"   {idx}. {track['name']} - {track['artists'][0]['name']}")
                print(f"      Preview URL: {'Available' if track.get('preview_url') else 'Not available'}")
        
    except Exception as e:
        error_msg = str(e)
        print(f"   ❌ Failed to fetch playlist: {e}")
        
        if '404' in error_msg:
            print()
            print("   💡 Troubleshooting 404 Error:")
            print("   This might be a regional restriction or API issue.")
            print()
            print("   Try these alternatives:")
            print("   1. Search for a track instead (testing basic API access)")
            
            # Try search instead
            try:
                search_results = sp.search(q='artist:Beatles', type='track', limit=3)
                print("      ✓ Search API works!")
                if search_results['tracks']['items']:
                    print(f"      Found {len(search_results['tracks']['items'])} tracks")
            except Exception as search_error:
                print(f"      ❌ Search also failed: {search_error}")
            
            print()
            print("   2. Create your own playlist in Spotify and use that ID")
            print("   3. Check Spotify Developer Dashboard settings:")
            print("      → https://developer.spotify.com/dashboard")
            print("      → Make sure your app has no restrictions")
            
        return False
    
    print()
    print("=" * 50)
    print("✅ All tests passed! Spotify API is working correctly.")
    print()
    print("You can now use these playlist IDs in your app:")
    print("  • Top 50 Global: 37i9dQZF1DXcBWIGoYBM5M")
    print("  • Today's Top Hits: 37i9dQZEVXbMDoHDwVN2tF")
    print("  • Rock Classics: 37i9dQZF1DWXRqgorJj26U")
    
    return True


if __name__ == "__main__":
    try:
        test_spotify_api()
    except KeyboardInterrupt:
        print("\n\nTest interrupted by user")
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
