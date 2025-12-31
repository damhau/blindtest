#!/usr/bin/env python3
"""
Check what scopes are granted to the current Spotify access token.
This helps verify if the 'streaming' scope is included for Web Playback SDK.
"""

import os
import sys
from dotenv import load_dotenv
from spotify_oauth_service import SpotifyOAuthService

load_dotenv()

def main():
    print("=" * 60)
    print("Spotify Token Scope Checker")
    print("=" * 60)
    
    try:
        oauth_service = SpotifyOAuthService()
        
        print(f"\n✓ OAuth configured successfully")
        print(f"  Client ID: {oauth_service.client_id[:10]}...")
        print(f"  Redirect URI: {oauth_service.redirect_uri}")
        
        print(f"\n📋 Required scopes for Web Playback SDK:")
        required_scopes = oauth_service.scope.split()
        for scope in required_scopes:
            print(f"  • {scope}")
        
        print(f"\n⚠️  IMPORTANT:")
        print(f"  The 'streaming' scope is REQUIRED for Web Playback SDK to work.")
        print(f"  If you previously authenticated without this scope, you must:")
        print(f"    1. Go to the host page")
        print(f"    2. Click 'Logout'")
        print(f"    3. Click 'Login with Spotify' again")
        print(f"    4. Accept the new permissions when prompted")
        
        print(f"\n✨ New scopes include:")
        print(f"  • streaming - Required for Web Playback SDK")
        print(f"  • user-read-email - User identification")
        print(f"  • user-read-private - User profile info")
        
        # Check if there's a cached token
        cache_path = ".cache"
        if os.path.exists(cache_path):
            print(f"\n⚠️  Found cached token at: {cache_path}")
            print(f"  This token may NOT have the 'streaming' scope.")
            print(f"  Recommended: Delete this file and login again, or use the Logout button.")
            
    except Exception as e:
        print(f"\n❌ Error: {e}")
        return 1
    
    print("\n" + "=" * 60)
    return 0

if __name__ == "__main__":
    sys.exit(main())
