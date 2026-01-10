#!/usr/bin/env python3
"""
Clean up the default.json cache file that was created during testing
"""
import os

cache_dir = ".spotify_cache"
default_cache = os.path.join(cache_dir, "default.json")

if os.path.exists(default_cache):
    os.remove(default_cache)
    print(f"Removed {default_cache}")
else:
    print("No default.json found to clean up")

print("\nRemaining cache files:")
if os.path.exists(cache_dir):
    files = os.listdir(cache_dir)
    if files:
        for f in files:
            print(f"  - {f}")
    else:
        print("  (none)")
else:
    print("  Cache directory doesn't exist")
