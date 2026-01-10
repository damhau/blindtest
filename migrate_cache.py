#!/usr/bin/env python3
"""
Migrate old global .spotify_cache file to user-specific cache structure
"""
import os
import json
import spotipy
from spotipy.oauth2 import SpotifyOAuth
from dotenv import load_dotenv

load_dotenv()


def migrate_cache():
    """Migrate old .spotify_cache file to new directory-based structure"""
    old_cache_file = ".spotify_cache"
    new_cache_dir = ".spotify_cache"

    # Check if old cache file exists (as a file, not directory)
    if not os.path.exists(old_cache_file) or os.path.isdir(old_cache_file):
        print("No old cache file to migrate")
        return

    try:
        # Read the old cache
        with open(old_cache_file, "r") as f:
            token_info = json.load(f)

        print(f"Found old cache file with token")

        # Get user ID from the token
        access_token = token_info.get("access_token")
        if not access_token:
            print("No access token found in cache")
            return

        # Use Spotify API to get user ID
        sp = spotipy.Spotify(auth=access_token)
        user_info = sp.current_user()
        user_id = user_info["id"]

        print(f"User ID: {user_id}")

        # Create new cache directory
        os.makedirs(new_cache_dir, exist_ok=True)

        # Write to user-specific cache file
        new_cache_file = os.path.join(new_cache_dir, f"{user_id}.json")
        with open(new_cache_file, "w") as f:
            json.dump(token_info, f)

        print(f"Migrated cache to: {new_cache_file}")

        # Backup and remove old cache file
        backup_file = f"{old_cache_file}.backup"
        os.rename(old_cache_file, backup_file)
        print(f"Backed up old cache to: {backup_file}")
        print("Migration complete!")

    except Exception as e:
        print(f"Error during migration: {e}")
        print("You may need to re-authenticate with Spotify")


if __name__ == "__main__":
    migrate_cache()
