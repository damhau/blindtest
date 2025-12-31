"""
Test script to debug Spotify playlist access issues
"""
import os
import spotipy
from spotipy.oauth2 import SpotifyOAuth
from dotenv import load_dotenv

load_dotenv()

# Test with the playlist ID that's failing
TEST_PLAYLIST_ID = "37i9dQZF1DWXRqgorJj26U"  # Légendes du Rock

print("=" * 60)
print("Spotify Playlist Access Test")
print("=" * 60)

# Initialize OAuth
client_id = os.getenv('SPOTIFY_CLIENT_ID')
client_secret = os.getenv('SPOTIFY_CLIENT_SECRET')
redirect_uri = os.getenv('SPOTIFY_REDIRECT_URI')

print(f"\nClient ID: {client_id[:10]}...")
print(f"Redirect URI: {redirect_uri}")

# Create OAuth with ALL possible scopes
scope = "streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative"

sp_oauth = SpotifyOAuth(
    client_id=client_id,
    client_secret=client_secret,
    redirect_uri=redirect_uri,
    scope=scope,
    cache_path=".spotify_cache"
)

# Get token
token_info = sp_oauth.get_cached_token()
if not token_info:
    print("\nNo cached token found. Please authenticate:")
    auth_url = sp_oauth.get_authorize_url()
    print(f"Visit this URL: {auth_url}")
    response = input("Enter the URL you were redirected to: ")
    code = sp_oauth.parse_response_code(response)
    token_info = sp_oauth.get_access_token(code)

sp = spotipy.Spotify(auth=token_info['access_token'])

print(f"\n✓ Authenticated successfully")

# Get user info
try:
    user = sp.current_user()
    print(f"✓ User: {user['display_name']} (ID: {user['id']})")
    print(f"✓ Country: {user.get('country', 'N/A')}")
    market = user.get('country', 'US')
except Exception as e:
    print(f"✗ Error getting user info: {e}")
    market = 'US'

print("\n" + "=" * 60)
print("Testing Playlist Access Methods")
print("=" * 60)

# Method 1: Direct playlist access (what we're currently doing)
print(f"\n1. Testing direct playlist access:")
print(f"   Playlist ID: {TEST_PLAYLIST_ID}")
try:
    playlist = sp.playlist(TEST_PLAYLIST_ID, market=market)
    print(f"   ✓ SUCCESS - Playlist: {playlist['name']}")
    print(f"   ✓ Owner: {playlist['owner']['display_name']}")
    print(f"   ✓ Total tracks: {playlist['tracks']['total']}")
    print(f"   ✓ Public: {playlist['public']}")
    print(f"   ✓ Collaborative: {playlist['collaborative']}")
except Exception as e:
    print(f"   ✗ FAILED: {e}")

# Method 2: Get playlist tracks
print(f"\n2. Testing playlist_tracks():")
try:
    results = sp.playlist_tracks(TEST_PLAYLIST_ID, limit=5, market=market)
    print(f"   ✓ SUCCESS - Retrieved {len(results['items'])} tracks")
    if results['items']:
        first_track = results['items'][0]['track']
        print(f"   ✓ First track: {first_track['name']} by {first_track['artists'][0]['name']}")
except Exception as e:
    print(f"   ✗ FAILED: {e}")

# Method 3: Try without market parameter
print(f"\n3. Testing without market parameter:")
try:
    results = sp.playlist_tracks(TEST_PLAYLIST_ID, limit=5)
    print(f"   ✓ SUCCESS - Retrieved {len(results['items'])} tracks")
except Exception as e:
    print(f"   ✗ FAILED: {e}")

# Method 4: Check if playlist is in user's library
print(f"\n4. Checking user's playlists:")
try:
    playlists = []
    results = sp.current_user_playlists(limit=50)
    while results:
        for playlist in results['items']:
            if playlist:
                playlists.append({
                    'id': playlist['id'],
                    'name': playlist['name'],
                    'owner': playlist['owner']['display_name']
                })
        if results['next']:
            results = sp.next(results)
        else:
            break
    
    print(f"   ✓ Found {len(playlists)} playlists")
    
    # Check if our test playlist is in the list
    found = False
    for p in playlists:
        if p['id'] == TEST_PLAYLIST_ID:
            print(f"   ✓ Test playlist IS in user's library: {p['name']}")
            found = True
            break
    
    if not found:
        print(f"   ⚠ Test playlist NOT in user's library")
        print(f"   → You need to 'Follow' or 'Save' this playlist in Spotify first")
        
    # Show first few playlists
    print(f"\n   First 5 playlists:")
    for p in playlists[:5]:
        print(f"     - {p['name']} (by {p['owner']}) [ID: {p['id']}]")
        
except Exception as e:
    print(f"   ✗ FAILED: {e}")

# Method 5: Try with fields parameter
print(f"\n5. Testing with fields parameter:")
try:
    results = sp.playlist_tracks(
        TEST_PLAYLIST_ID,
        limit=5,
        market=market,
        fields='items(track(name,artists,uri,preview_url))'
    )
    print(f"   ✓ SUCCESS - Retrieved tracks with custom fields")
except Exception as e:
    print(f"   ✗ FAILED: {e}")

# Method 6: Search for public playlists
print(f"\n6. Testing playlist search:")
print(f"   Searching for: 'rock classics'")
try:
    results = sp.search(q='rock classics', type='playlist', limit=10, market=market)
    playlists = results['playlists']['items']
    print(f"   ✓ SUCCESS - Found {len(playlists)} playlists")
    
    # Show search results
    print(f"\n   Search results:")
    for idx, playlist in enumerate(playlists[:5], 1):
        print(f"     {idx}. {playlist['name']} (by {playlist['owner']['display_name']})")
        print(f"        ID: {playlist['id']}")
        print(f"        Tracks: {playlist['tracks']['total']}")
        
        # Try to access the first search result
        if idx == 1:
            print(f"\n   Testing access to first result:")
            try:
                test_tracks = sp.playlist_tracks(playlist['id'], limit=3, market=market)
                print(f"      ✓ Can access tracks! Retrieved {len(test_tracks['items'])} tracks")
                if test_tracks['items']:
                    first = test_tracks['items'][0]['track']
                    print(f"      ✓ First track: {first['name']} by {first['artists'][0]['name']}")
            except Exception as e2:
                print(f"      ✗ Cannot access tracks: {e2}")
        
except Exception as e:
    print(f"   ✗ FAILED: {e}")

# Method 7: Search for "Légendes du Rock" specifically
print(f"\n7. Testing search for 'Légendes du Rock':")
try:
    results = sp.search(q='Légendes du Rock', type='playlist', limit=5, market=market)
    playlists = results['playlists']['items']
    print(f"   ✓ Found {len(playlists)} playlists")
    
    for idx, playlist in enumerate(playlists, 1):
        print(f"   {idx}. {playlist['name']} (by {playlist['owner']['display_name']})")
        print(f"      ID: {playlist['id']}")
        print(f"      Public: {playlist.get('public', 'N/A')}")
        
        # Try accessing it
        try:
            test_tracks = sp.playlist_tracks(playlist['id'], limit=2, market=market)
            print(f"      ✓ CAN ACCESS - Has {len(test_tracks['items'])} tracks")
        except Exception as e2:
            print(f"      ✗ CANNOT ACCESS: {e2}")
        
except Exception as e:
    print(f"   ✗ FAILED: {e}")

print("\n" + "=" * 60)
print("Recommendations:")
print("=" * 60)
print("1. Make sure the playlist is saved/followed in your Spotify library")
print("2. Try accessing the playlist URL in Spotify to verify it exists")
print("3. Check if the playlist is available in your country")
print("4. Verify OAuth scopes include: playlist-read-private, playlist-read-collaborative")
print("=" * 60)
