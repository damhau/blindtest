# Song Selection Issue Analysis

## Problem
User has a playlist with **327 tracks** but keeps getting the same songs.

## Root Cause

### Current Code Flow:
```python
# app.py line 501
tracks, error = spotify_oauth_service.get_playlist_tracks(sp_client, room.playlist_id, limit=50)

# spotify_oauth_service.py line 134
results = sp_client.playlist_tracks(playlist_id, limit=limit, market=market)
# ☝️ Only fetches ONE page (max 50 items)
```

### What's Happening:
1. **Only fetches first 50 tracks** from the 327-track playlist
2. Shuffles those same 50 tracks every time
3. Over multiple games, you see the same 50 songs repeatedly
4. **283 tracks never get selected!** (327 - 50 = 277)

## Solution Options

### Option 1: Fetch All Tracks (Best for smaller playlists < 500 tracks)
```python
def get_playlist_tracks(self, sp_client, playlist_id, limit=None):
    """Fetch ALL tracks from playlist with pagination"""
    
    # ... existing code ...
    
    # Fetch all tracks with pagination
    all_tracks = []
    offset = 0
    batch_size = 100  # Spotify API max per request
    
    while True:
        results = sp_client.playlist_tracks(
            playlist_id, 
            limit=batch_size, 
            offset=offset, 
            market=market
        )
        
        for item in results['items']:
            # ... existing track processing ...
            all_tracks.append(track_data)
        
        # Check if we've fetched everything
        if len(results['items']) < batch_size:
            break
        
        offset += batch_size
    
    # If limit specified, return random subset
    if limit and len(all_tracks) > limit:
        import random
        return random.sample(all_tracks, limit), None
    
    return all_tracks, None
```

**Pros:**
- True randomization across entire playlist
- Simple to implement
- Works well for playlists < 500 tracks

**Cons:**
- Slower for huge playlists (2000+ tracks)
- More API calls

### Option 2: Fetch Random Offset (Fast but less random)
```python
def get_playlist_tracks(self, sp_client, playlist_id, limit=50):
    """Fetch tracks from random offset in playlist"""
    
    # Get playlist info to know total tracks
    playlist_info = sp_client.playlist(playlist_id, fields='tracks.total')
    total_tracks = playlist_info['tracks']['total']
    
    # Calculate random offset
    max_offset = max(0, total_tracks - limit)
    random_offset = random.randint(0, max_offset)
    
    results = sp_client.playlist_tracks(
        playlist_id,
        limit=limit,
        offset=random_offset,
        market=market
    )
    
    # ... process tracks ...
```

**Pros:**
- Fast (only 2 API calls)
- Works for any playlist size

**Cons:**
- Songs near each other in playlist more likely to appear together
- Less truly random

### Option 3: Hybrid Approach (Recommended)
```python
def get_playlist_tracks(self, sp_client, playlist_id, limit=50, fetch_pool_size=200):
    """Fetch larger pool then randomly select"""
    
    # Get playlist total
    playlist_info = sp_client.playlist(playlist_id, fields='tracks.total')
    total_tracks = playlist_info['tracks']['total']
    
    # Decide strategy based on playlist size
    if total_tracks <= 200:
        # Small playlist: fetch all
        pool_size = total_tracks
        offset = 0
    else:
        # Large playlist: fetch random chunk
        pool_size = min(fetch_pool_size, total_tracks)
        max_offset = total_tracks - pool_size
        offset = random.randint(0, max_offset)
    
    # Fetch tracks in batches
    all_tracks = []
    remaining = pool_size
    
    while remaining > 0:
        batch_size = min(100, remaining)
        results = sp_client.playlist_tracks(
            playlist_id,
            limit=batch_size,
            offset=offset,
            market=market
        )
        
        for item in results['items']:
            # ... process tracks ...
            all_tracks.append(track_data)
        
        remaining -= batch_size
        offset += batch_size
    
    # Randomly select from pool
    if len(all_tracks) > limit:
        import random
        return random.sample(all_tracks, limit), None
    
    return all_tracks, None
```

**Pros:**
- Good balance of speed and randomness
- Fetches 200 tracks from random position
- Shuffles within that pool
- Handles both small and large playlists

**Cons:**
- Slightly more complex

## Recommendation

For your 327-track playlist, I recommend **Option 3 (Hybrid)**:
- Fetches 200 random tracks from your playlist
- Much better variety than current 50
- Still reasonably fast (2-3 API calls)
- Will give you different songs across games

## Impact

**Current (50 tracks):**
- Probability of seeing same song in 10-song game: ~20%
- Songs never seen: 277 out of 327 (85%)

**After fix (200 tracks):**
- Probability of seeing same song in 10-song game: ~5%
- Songs never seen in one fetch: 127 out of 327 (39%)
- But offset randomization means different 200 each game!

**With full fetch (327 tracks):**
- Probability of seeing same song in 10-song game: ~3%
- Songs never seen: 0 (100% coverage)
