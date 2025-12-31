#!/usr/bin/env python3
"""
Simple test script to directly call Spotify related artists API
Tests artist ID: 6RZUqkomCmb8zCRqc9eznB (Placebo)
"""

import os
import json
import requests
from dotenv import load_dotenv

load_dotenv()

def test_with_token_from_cache():
    """Use token from .cache file"""
    cache_path = '.cache'
    
    if not os.path.exists(cache_path):
        print("❌ No .cache file found. Login to the app first.")
        return None
    
    with open(cache_path, 'r') as f:
        token_info = json.load(f)
    
    return token_info.get('access_token')


def test_with_client_credentials():
    """Get token using Client Credentials flow"""
    client_id = os.getenv('SPOTIFY_CLIENT_ID')
    client_secret = os.getenv('SPOTIFY_CLIENT_SECRET')
    
    if not client_id or not client_secret:
        print("❌ Missing credentials")
        return None
    
    auth_url = 'https://accounts.spotify.com/api/token'
    auth_data = {
        'grant_type': 'client_credentials'
    }
    
    response = requests.post(
        auth_url,
        auth=(client_id, client_secret),
        data=auth_data
    )
    
    if response.status_code == 200:
        return response.json().get('access_token')
    else:
        print(f"❌ Failed to get token: {response.status_code}")
        return None


def test_related_artists(access_token, artist_id='6RZUqkomCmb8zCRqc9eznB'):
    """Test the related artists endpoint"""
    
    headers = {
        'Authorization': f'Bearer {access_token}'
    }
    
    # First, verify the artist exists
    artist_url = f'https://api.spotify.com/v1/artists/{artist_id}'
    print(f"\n🔍 Step 1: Verifying artist exists")
    print(f"   GET {artist_url}")
    
    artist_response = requests.get(artist_url, headers=headers)
    print(f"   Status: {artist_response.status_code} {artist_response.reason}")
    
    if artist_response.status_code != 200:
        print(f"   ❌ Artist itself not found!")
        print(f"   Response: {artist_response.text}")
        return False
    
    artist_data = artist_response.json()
    print(f"   ✅ Artist found: {artist_data.get('name')}")
    print(f"   Popularity: {artist_data.get('popularity')}")
    print(f"   Followers: {artist_data.get('followers', {}).get('total')}")
    
    # Now try related artists
    url = f'https://api.spotify.com/v1/artists/{artist_id}/related-artists'
    
    print(f"\n🎯 Step 2: Getting related artists")
    print(f"   GET {url}")
    print(f"   Token: {access_token[:20]}...")
    
    response = requests.get(url, headers=headers)
    
    print(f"\n📊 Response:")
    print(f"   Status Code: {response.status_code}")
    print(f"   Status: {response.reason}")
    
    if response.status_code == 200:
        data = response.json()
        artists = data.get('artists', [])
        print(f"\n✅ SUCCESS! Found {len(artists)} related artists:")
        for i, artist in enumerate(artists[:5], 1):
            print(f"   {i}. {artist['name']} (popularity: {artist.get('popularity', 'N/A')})")
        
        if len(artists) > 5:
            print(f"   ... and {len(artists) - 5} more")
        
        return True
    else:
        print(f"\n❌ FAILED!")
        print(f"   Response headers: {dict(response.headers)}")
        print(f"   Response body: {response.text}")
        return False


def main():
    print("=" * 70)
    print("Spotify Related Artists API Test")
    print("=" * 70)
    
    # Test artist info
    print("\nArtist: Placebo")
    print("Web URL: https://open.spotify.com/artist/6RZUqkomCmb8zCRqc9eznB")
    print("API Endpoint: /v1/artists/6RZUqkomCmb8zCRqc9eznB/related-artists")
    
    # Try with OAuth token first
    print("\n" + "-" * 70)
    print("TEST 1: Using OAuth token from .cache")
    print("-" * 70)
    
    oauth_token = test_with_token_from_cache()
    if oauth_token:
        success = test_related_artists(oauth_token)
        if success:
            print("\n🎉 OAuth token works!")
            return 0
    else:
        print("Skipping OAuth test (no .cache file)")
    
    # Try with Client Credentials
    print("\n" + "-" * 70)
    print("TEST 2: Using Client Credentials token")
    print("-" * 70)
    
    cc_token = test_with_client_credentials()
    if cc_token:
        success = test_related_artists(cc_token)
        if success:
            print("\n🎉 Client Credentials token works!")
            return 0
    
    print("\n" + "=" * 70)
    print("CONCLUSION")
    print("=" * 70)
    print("Both authentication methods failed to access related artists.")
    print("This could mean:")
    print("  - The endpoint requires specific scopes")
    print("  - Regional restrictions apply")
    print("  - The artist has no related artists data")
    print("=" * 70)
    
    return 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
