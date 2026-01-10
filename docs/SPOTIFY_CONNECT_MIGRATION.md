# Spotify Connect Migration

## Overview
The app now supports **Spotify Connect** in addition to the Web Playback SDK. This allows playing music on any Spotify-enabled device (phones, speakers, smart TVs, LG TVs, etc.) instead of only in the browser.

## What Changed

### 1. New UI Elements
- **Connect Device Button**: Added to top navigation menu (shows when authenticated)
- **Device Selection Modal**: Shows all available Spotify devices with:
  - Device type icons (📺 TV, 💻 Computer, 📱 Phone, etc.)
  - Active device indicator
  - Volume level display
  - Refresh functionality

### 2. New JavaScript Functions

#### Device Management
- `getAvailableDevices()` - Fetches all available Spotify Connect devices
- `openDeviceModal()` - Opens device selection modal
- `closeDeviceModal()` - Closes device selection modal
- `loadDeviceList()` - Loads and displays available devices
- `selectDevice(device)` - Selects a device for playback
- `updateConnectButton()` - Updates button UI to show selected device

#### Playback Control
- `playTrackOnConnectDevice(trackUri, deviceId)` - Plays track on selected Connect device
- `skipToNextTrack()` - Skips to next track via Spotify API
- `transferPlaybackToDevice(deviceId)` - Transfers playback to specific device

### 3. Modified Functions
- `playSpotifyTrack()` - Now checks if using Connect mode and delegates accordingly
- `initializeSpotifyPlayer()` - Skips Web Playback SDK init when using Connect
- Authentication flow - Shows Connect button when logged in
- Question playback - Uses Connect when device is selected

### 4. New Variables
```javascript
let useSpotifyConnect = false;
let selectedConnectDevice = null;
let availableDevices = [];
```

## How It Works

### User Flow
1. User logs in with Spotify
2. "Connect Device" button appears in top nav
3. User clicks button → Device modal opens
4. Modal shows all available Spotify devices
5. User selects a device (e.g., their LG TV)
6. Button updates to show selected device name
7. Game starts and music plays on selected device

### Technical Flow
```
User selects device
    ↓
useSpotifyConnect = true
selectedConnectDevice = device
    ↓
When track plays:
  new_question event received
    ↓
  Check if useSpotifyConnect && selectedConnectDevice
    ↓
  YES: playTrackOnConnectDevice(uri, deviceId)
    ↓
  Spotify Connect API: PUT /v1/me/player/play?device_id=XXX
    ↓
  Track plays on selected device
```

## API Endpoints Used

### Get Devices
```
GET https://api.spotify.com/v1/me/player/devices
Authorization: Bearer {token}
```

### Play Track on Device
```
PUT https://api.spotify.com/v1/me/player/play?device_id={device_id}
Authorization: Bearer {token}
Content-Type: application/json

{
  "uris": ["spotify:track:..."]
}
```

### Skip Track
```
POST https://api.spotify.com/v1/me/player/next
Authorization: Bearer {token}
```

## Benefits for LG TV

### Why Connect is Better for TV
1. **No Web Playback SDK Required**: SDK doesn't work well on TV browsers
2. **Native Spotify App**: Uses Spotify app on TV for better audio quality
3. **No Browser Limitations**: Avoids browser codec and DRM restrictions
4. **Better Performance**: Native playback is more efficient
5. **Universal Control**: Can control from any device

### LG TV Setup
1. Install Spotify app on LG TV
2. Open Spotify on TV and play any song
3. Open blindtest app in browser (on computer or tablet)
4. Click "Connect Device" and select LG TV
5. Game music now plays through TV's Spotify app

## Required Spotify Scopes

Make sure your OAuth includes:
- `user-read-playback-state` - Read current playback
- `user-modify-playback-state` - Control playback
- `user-read-currently-playing` - See what's playing

## Fallback Behavior

The app gracefully handles both modes:
- **With Connect Device**: Uses Spotify Connect API
- **Without Connect Device**: Falls back to Web Playback SDK (browser)
- **No Auth**: Uses 30-second preview URLs

## Testing

### Test on Web
1. Login with Spotify
2. Open Spotify desktop/mobile app
3. Play any song to make device active
4. In blindtest, click "Connect Device"
5. Select your Spotify device
6. Start game - music should play on selected device

### Test on LG TV (Future)
1. Install Spotify on LG TV
2. Open Spotify and play a song
3. Open blindtest in TV browser or tablet
4. Select LG TV as device
5. Music plays through TV's Spotify

## Files Modified

- `/templates/host.html` - Added Connect button and device modal
- `/static/js/host.js` - Added Connect functions and logic

## Next Steps for Full LG TV Support

1. **TV-Optimized UI**: Larger buttons, spatial navigation
2. **Remote Control**: Handle D-pad navigation
3. **webOS Packaging**: Create LG TV app package
4. **TV Testing**: Test on actual LG webOS device

## Troubleshooting

### No Devices Showing
- Make sure Spotify is open and playing on a device
- Check that user has Spotify Premium
- Verify OAuth scopes are correct

### Playback Not Starting
- Check device is still active (hasn't gone to sleep)
- Verify token hasn't expired
- Try transferring playback first

### Device Goes Offline
- App will show error and prompt to select another device
- User can click Connect button to reselect device
