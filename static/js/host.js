// Initialize theme immediately to prevent flash
(function () {
  const savedTheme = localStorage.getItem('theme') || 'light';
  if (savedTheme === 'dark') {
    document.documentElement.classList.add('dark');
  } else if (savedTheme === 'auto') {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.classList.add('dark');
    }
  }
})();

// Fullscreen mode
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().then(() => {
      console.log('Entered fullscreen');
    }).catch((err) => {
      console.error('Fullscreen request failed:', err);
    });
  } else {
    document.exitFullscreen().catch((err) => {
      console.error('Exit fullscreen failed:', err);
    });
  }
}

document.addEventListener('fullscreenchange', () => {
  const isFs = !!document.fullscreenElement;
  console.log('Fullscreen changed:', isFs);
  document.body.classList.toggle('is-fullscreen', isFs);
});


// Force secure WebSocket when using HTTPS
const socket = io({
  transports: ['websocket', 'polling'],
  secure: window.location.protocol === 'https:',
  rejectUnauthorized: false
});

let currentPin = null;
let currentQuestion = null;
let isAuthenticated = false;
let spotifyPlayer = null;
let deviceId = null;
let gamesInSeries = 1;
let currentGameNumber = 1;

// Spotify Connect variables
let useSpotifyConnect = false;
let selectedConnectDevice = null;
let availableDevices = [];

// Connection resilience tracking
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let isReconnecting = false;

// DOM Elements
const loginScreen = document.getElementById('loginScreen');
const createScreen = document.getElementById('createScreen');
const waitingScreen = document.getElementById('waitingScreen');
const standingsModal = document.getElementById('standingsModal');
const gameScreen = document.getElementById('gameScreen');
const endScreen = document.getElementById('endScreen');
const authStatus = document.getElementById('authStatus');
const loginOptions = document.getElementById('loginOptions');
const skipLoginBtn = document.getElementById('skipLoginBtn');

const playlistIdInput = document.getElementById('playlistId');
const createRoomBtn = document.getElementById('createRoomBtn');
const roomPinDisplay = document.getElementById('roomPin');
const participantsList = document.getElementById('participants');
const participantCount = document.getElementById('participantCount');
const startGameBtn = document.getElementById('startGameBtn');

const songNumber = document.getElementById('songNumber');
const totalSongs = document.getElementById('totalSongs');
const multiplierValue = document.getElementById('multiplierValue');
const audioPlayer = document.getElementById('audioPlayer');
const nextSongBtn = document.getElementById('nextSongBtn');
const scoresList = document.getElementById('scoresList');
const intermediateScoresList = document.getElementById('intermediateScoresList');
const finalScores = document.getElementById('finalScores');
const newGameBtn = document.getElementById('newGameBtn');
const playlistSelector = document.getElementById('playlistSelector');
const playlistLoading = document.getElementById('playlistLoading');
const playlistGrid = document.getElementById('playlistGrid');
const manualInput = document.getElementById('manualInput');
const songCountSlider = document.getElementById('songCountSlider');
const songCountValue = document.getElementById('songCountValue');

let selectedPlaylistId = null;
let spotifyAccessToken = null;
let questionTimer = null;
let questionStartTime = null;
const QUESTION_TIME_LIMIT = 15; // seconds

// Update song count display when slider changes
if (songCountSlider && songCountValue) {
  songCountSlider.addEventListener('input', (e) => {
    songCountValue.textContent = e.target.value;
  });
}

// Update games count display when slider changes
const gamesCountSlider = document.getElementById('gamesCountSlider');
const gamesCountValue = document.getElementById('gamesCountValue');
if (gamesCountSlider && gamesCountValue) {
  gamesCountSlider.addEventListener('input', (e) => {
    gamesCountValue.textContent = e.target.value;
  });
}

// Helper function to update auth UI
function updateAuthUI(authenticated) {
  if (authenticated) {
    if (authStatus) {
      authStatus.classList.remove('hidden');
      authStatus.style.display = 'block';
    }
    if (loginOptions) {
      loginOptions.classList.add('hidden');
    }
  } else {
    if (authStatus) {
      authStatus.classList.add('hidden');
      authStatus.style.display = 'none';
    }
    if (loginOptions) {
      loginOptions.classList.remove('hidden');
    }
  }
}

// Initially hide auth status until we check
if (authStatus) {
  authStatus.classList.add('hidden');
  authStatus.style.display = 'none';
}

// Initialize Spotify Web Playback SDK (only needed when not using Connect)
window.onSpotifyWebPlaybackSDKReady = () => {
  console.log('Spotify Web Playback SDK ready');

  if (!spotifyAccessToken) {
    console.log('No access token available yet');
    return;
  }

  // Only initialize if not using Connect
  if (!useSpotifyConnect) {
    initializeSpotifyPlayer();
  }
};

function initializeSpotifyPlayer() {
  if (!spotifyAccessToken) {
    console.log('Cannot initialize player without access token');
    return;
  }

  // Skip SDK initialization if using Connect
  if (useSpotifyConnect) {
    console.log('Skipping Web Playback SDK initialization - using Spotify Connect');
    return;
  }

  spotifyPlayer = new Spotify.Player({
    name: 'Blindtest Game',
    getOAuthToken: cb => { cb(spotifyAccessToken); },
    volume: 0.5
  });

  // Error handling
  spotifyPlayer.addListener('initialization_error', ({ message }) => {
    console.error('Initialization Error:', message);
  });

  spotifyPlayer.addListener('authentication_error', ({ message }) => {
    console.error('Authentication Error:', message);
    console.log('Token may have expired, try refreshing');
  });

  spotifyPlayer.addListener('account_error', ({ message }) => {
    console.error('Account Error:', message);
    showErrorModal('Spotify Premium Required', 'Spotify Premium is required for full playback. Falling back to preview mode.');
  });

  spotifyPlayer.addListener('playback_error', ({ message }) => {
    // Suppress errors when using Connect mode
    if (useSpotifyConnect && selectedConnectDevice) {
      console.log('SDK playback error suppressed (using Connect):', message);
      return;
    }
    console.error('Playback Error:', message);
  });

  // Ready
  spotifyPlayer.addListener('ready', ({ device_id }) => {
    console.log('Spotify Player Ready with Device ID:', device_id);
    deviceId = device_id;
  });

  // Not Ready
  spotifyPlayer.addListener('not_ready', ({ device_id }) => {
    console.log('Device ID has gone offline:', device_id);
  });

  // Player State Changed - detect actual playback start
  let hasNotifiedPlaybackStart = false;
  spotifyPlayer.addListener('player_state_changed', (state) => {
    if (state && !state.paused && state.position === 0 && !hasNotifiedPlaybackStart) {
      console.log('Spotify playback actually started');
      hasNotifiedPlaybackStart = true;
      // Notify backend that playback has actually started
      socket.emit('playback_started', { pin: currentPin });
      // Reset flag after a delay for next track
      setTimeout(() => { hasNotifiedPlaybackStart = false; }, 1000);
    }
  });

  // Connect to the player
  spotifyPlayer.connect().then(success => {
    if (success) {
      console.log('Spotify Player connected successfully!');
    } else {
      console.log('Spotify Player connection failed');
    }
  });
}

async function playSpotifyTrack(trackUri) {
  // If using Spotify Connect, delegate to Connect function
  if (useSpotifyConnect && selectedConnectDevice) {
    return await playTrackOnConnectDevice(trackUri, selectedConnectDevice.id);
  }

  // Otherwise use Web Playback SDK
  if (!spotifyPlayer || !deviceId) {
    // Don't show error if we're about to use Connect mode
    if (!useSpotifyConnect) {
      console.error('Spotify player not ready - Player:', !!spotifyPlayer, 'Device ID:', !!deviceId);
      showErrorModal('Playback Error', 'Spotify player is not ready. Please try refreshing the page or use Connect mode.');
    }
    return false;
  }

  console.log('Attempting to play via Spotify SDK:', trackUri);
  console.log('Device ID:', deviceId);
  console.log('Token available:', !!spotifyAccessToken);

  try {
    const response = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
      method: 'PUT',
      body: JSON.stringify({ uris: [trackUri] }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${spotifyAccessToken}`
      },
    });

    if (response.ok) {
      console.log('✓ Spotify API accepted play request:', trackUri);
      // Note: actual playback_started will be emitted by player_state_changed listener
      return true;
    }

    // Handle error responses
    const errorData = await response.json().catch(() => null);
    console.error('Failed to play track:', response.status, response.statusText);

    if (errorData) {
      console.error('Error details:', errorData);
    }

    // Handle specific error cases
    if (response.status === 401) {
      // Token expired or invalid
      const errorMessage = errorData?.error?.message || 'Authentication expired';
      console.error('Authentication error:', errorMessage);


      // Optionally try to refresh the token automatically
      if (isAuthenticated) {
        console.log('Attempting to fetch new token...');
        fetchSpotifyToken();
      }

      return false;
    } else if (response.status === 404) {
      // Device not found
      console.error('Device not found - may need to reconnect player');
      showErrorModal(
        'Playback Device Error',
        'Could not find playback device. Please refresh the page.'
      );
      return false;
    } else if (response.status === 403) {
      // Premium required or other restriction
      const errorMessage = errorData?.error?.message || 'Premium account required';
      console.error('Forbidden:', errorMessage);

      // Show quick notification
      const notification = document.createElement('div');
      notification.className = 'fixed top-4 right-4 bg-orange-500 text-white px-6 py-3 rounded-lg shadow-lg z-50 animate-fade-in';
      notification.innerHTML = `
        <div class="flex items-center gap-2">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
          </svg>
          <span>Premium required - skipping to next song...</span>
        </div>
      `;
      document.body.appendChild(notification);

      // Remove notification after 3 seconds
      setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transition = 'opacity 0.3s';
        setTimeout(() => notification.remove(), 300);
      }, 3000);

      // Skip to next question after 2 seconds
      setTimeout(() => {
        if (currentPin) {
          socket.emit('next_question', { pin: currentPin });
        }
      }, 2000);

      return false;
    } else if (response.status === 429) {
      // Rate limited
      console.error('Rate limited by Spotify API');
      showErrorModal(
        'Too Many Requests',
        'Spotify playback is temporarily rate-limited. Please wait a moment and try again.'
      );
      return false;
    } else {
      // Other errors
      const errorMessage = errorData?.error?.message || `HTTP ${response.status}: ${response.statusText}`;
      console.error('Playback error:', errorMessage);
      showErrorModal(
        'Playback Error',
        `Failed to play track: ${errorMessage}`
      );
      return false;
    }
  } catch (err) {
    console.error('Network error playing track:', err);
    showErrorModal(
      'Network Error',
      'Failed to communicate with Spotify. Please check your internet connection.'
    );
    return false;
  }
}

// ============ Spotify Connect API Functions ============

async function getAvailableDevices() {
  if (!spotifyAccessToken) {
    console.error('No Spotify access token available');
    return [];
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/devices', {
      headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
    });

    if (response.ok) {
      const data = await response.json();
      return data.devices || [];
    }

    console.error('Failed to fetch devices:', response.status);
    return [];
  } catch (err) {
    console.error('Error fetching devices:', err);
    return [];
  }
}

async function playTrackOnConnectDevice(trackUri, deviceId) {
  if (!spotifyAccessToken) {
    console.error('No Spotify access token available');
    return false;
  }

  const headers = {
    'Authorization': `Bearer ${spotifyAccessToken}`,
    'Content-Type': 'application/json'
  };

  try {
    const url = `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ uris: [trackUri] })
    });

    if (response.status === 204 || response.status === 202) {
      console.log('✓ Track playing on Connect device:', trackUri);
      if (currentPin) {
        socket.emit('playback_started', { pin: currentPin });
      }
      return true;
    }

    if (response.status === 404) {
      console.error('Device not found or not active');
      showErrorModal('Device Error', 'The selected device is not available. Please select another device.');
      return false;
    }

    const errorBody = await response.text();
    console.error('Failed to play on Connect device:', response.status, errorBody);
    return false;
  } catch (err) {
    console.error('Error playing on Connect device:', err);
    return false;
  }
}

async function pauseConnectPlayback() {
  if (!spotifyAccessToken) return false;

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/pause', {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
    });
    return response.status === 204;
  } catch (err) {
    console.error('Error pausing playback:', err);
    return false;
  }
}

async function resumeConnectPlayback() {
  if (!spotifyAccessToken) return false;

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
    });
    return response.status === 204;
  } catch (err) {
    console.error('Error resuming playback:', err);
    return false;
  }
}

async function skipToNextTrack() {
  if (!spotifyAccessToken) return false;

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/next', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${spotifyAccessToken}` }
    });
    return response.status === 204;
  } catch (err) {
    console.error('Error skipping track:', err);
    return false;
  }
}

async function transferPlaybackToDevice(deviceId, shouldPlay = true) {
  if (!spotifyAccessToken) return false;

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${spotifyAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        device_ids: [deviceId],
        play: shouldPlay
      })
    });
    return response.status === 204;
  } catch (err) {
    console.error('Error transferring playback:', err);
    return false;
  }
}

// ============ Device Modal Functions ============

function openDeviceModal() {
  const modal = document.getElementById('deviceModal');
  const loadingState = document.getElementById('deviceLoadingState');
  const listContainer = document.getElementById('deviceListContainer');
  const noDevicesState = document.getElementById('noDevicesState');

  modal.classList.remove('hidden');
  loadingState.classList.remove('hidden');
  listContainer.classList.add('hidden');
  noDevicesState.classList.add('hidden');

  loadDeviceList();
}

function closeDeviceModal() {
  const modal = document.getElementById('deviceModal');
  modal.classList.add('hidden');
}

async function loadDeviceList() {
  const loadingState = document.getElementById('deviceLoadingState');
  const listContainer = document.getElementById('deviceListContainer');
  const noDevicesState = document.getElementById('noDevicesState');
  const deviceList = document.getElementById('deviceList');

  availableDevices = await getAvailableDevices();

  loadingState.classList.add('hidden');

  if (availableDevices.length === 0) {
    noDevicesState.classList.remove('hidden');
    return;
  }

  // Debug: Log all device information
  console.log('=== Available Spotify Devices ===');
  availableDevices.forEach((device, index) => {
    console.log(`Device ${index + 1}:`, {
      id: device.id,
      name: device.name,
      type: device.type,
      is_active: device.is_active,
      is_private_session: device.is_private_session,
      is_restricted: device.is_restricted,
      volume_percent: device.volume_percent,
      supports_volume: device.supports_volume
    });
  });
  console.log('================================');

  listContainer.classList.remove('hidden');
  deviceList.innerHTML = '';

  availableDevices.forEach(device => {
    const deviceCard = document.createElement('div');
    deviceCard.className = 'p-4 border rounded-lg hover:bg-gray-50 cursor-pointer transition';

    if (selectedConnectDevice && selectedConnectDevice.id === device.id) {
      deviceCard.classList.add('bg-green-50', 'border-green-500', 'border-2');
    } else {
      deviceCard.classList.add('border-gray-300');
    }

    const deviceIcon = getDeviceIcon(device.type);
    const isActive = device.is_active ? '<span class="text-xs bg-green-100 text-green-700 px-2 py-1 rounded">Active</span>' : '';
    const isRestricted = device.is_restricted ? '<span class="text-xs bg-orange-100 text-orange-700 px-2 py-1 rounded">Not available</span>' : '';

    if (device.is_restricted) {
      deviceCard.classList.add('opacity-50');
      deviceCard.classList.remove('hover:bg-gray-50', 'cursor-pointer');
      deviceCard.classList.add('cursor-not-allowed');
    }

    deviceCard.innerHTML = `
      <div class="flex items-center gap-4">
        <div class="text-3xl">${deviceIcon}</div>
        <div class="flex-1">
          <h4 class="font-semibold text-gray-800 dark:text-gray-200">${device.name}</h4>
          <p class="text-sm text-gray-600 dark:text-gray-400">${device.type} • ${device.volume_percent}% volume</p>
          ${device.is_restricted ? '<p class="text-xs text-orange-600 mt-1">This device doesn\'t allow remote playback</p>' : ''}
        </div>
        ${isActive}
        ${isRestricted}
      </div>
    `;

    if (!device.is_restricted) {
      deviceCard.addEventListener('click', () => {
        selectDevice(device);
      });
    }

    deviceList.appendChild(deviceCard);
  });
}

function getDeviceIcon(deviceType) {
  const icons = {
    'Computer': '💻',
    'Smartphone': '📱',
    'Speaker': '🔊',
    'TV': '📺',
    'AVR': '📻',
    'STB': '📦',
    'AudioDongle': '🎧',
    'GameConsole': '🎮',
    'CastVideo': '📺',
    'CastAudio': '🔊',
    'Automobile': '🚗',
    'Unknown': '🎵'
  };
  return icons[deviceType] || icons['Unknown'];
}

function selectDevice(device) {
  selectedConnectDevice = device;
  useSpotifyConnect = true;

  // Update UI to show selected device
  updateConnectButton();

  // Close modal
  closeDeviceModal();

  // Show success message
  showNotification(`Connected to ${device.name}`, 'success');

  console.log('Selected device:', device);
}

function disconnectFromDevice() {
  selectedConnectDevice = null;
  useSpotifyConnect = false;

  // Update UI
  updateConnectButton();

  // Reinitialize Web SDK player if needed
  if (spotifyAccessToken && window.Spotify && !spotifyPlayer) {
    initializeSpotifyPlayer();
  }

  // Show notification
  showNotification('Disconnected from device', 'info');

  console.log('Disconnected from Connect device, using Web SDK');
}

function updateConnectButton() {
  const connectBtn = document.getElementById('connectDeviceBtn');
  const label = document.getElementById('connectDeviceLabel');

  if (!connectBtn) return;

  if (selectedConnectDevice) {
    label.innerHTML = `
      <span>📺 ${selectedConnectDevice.name}</span>
      <button onclick="event.stopPropagation(); disconnectFromDevice();" 
        class="ml-2 px-2 py-1 text-xs bg-red-100 hover:bg-red-200 text-red-700 rounded transition"
        title="Disconnect from device">
        × Disconnect
      </button>
    `;
    connectBtn.classList.add('bg-green-50', 'border', 'border-green-500');
  } else {
    label.textContent = 'Connect Device';
    connectBtn.classList.remove('bg-green-50', 'border', 'border-green-500');
  }
}

function showNotification(message, type) {
  showToast(message, type);
}

// ============ End Spotify Connect Functions ============

function fetchSpotifyToken() {
  fetch('/spotify_token')
    .then(r => r.json())
    .then(data => {
      if (data.access_token) {
        spotifyAccessToken = data.access_token;
        console.log('Got Spotify access token');

        // If SDK is already loaded, initialize player
        if (window.Spotify) {
          initializeSpotifyPlayer();
        }
        // Otherwise, onSpotifyWebPlaybackSDKReady will be called when ready
      } else {
        console.log('No access token available');
      }
    })
    .catch(err => {
      console.error('Failed to fetch Spotify token:', err);
    });
}

// Check authentication status on page load
window.addEventListener('load', () => {
  const urlParams = new URLSearchParams(window.location.search);

  fetch('/check_auth')
    .then(res => res.json())
    .then(data => {
      isAuthenticated = data.authenticated;
      updateAuthUI(data.authenticated);

      if (data.authenticated) {
        loadUserPlaylists();
        fetchSpotifyToken();

        // Show Connect button when authenticated
        const connectBtn = document.getElementById('connectDeviceBtn');
        if (connectBtn) {
          connectBtn.classList.remove('hidden');
          connectBtn.classList.add('flex');
        }
      }
    })
    .catch(err => {
      console.error('Auth check failed:', err);
      updateAuthUI(false);
    });
});

// Load user's playlists
function loadUserPlaylists() {
  if (!playlistSelector || !playlistGrid) return;

  // Show playlist selector, keep manual input visible too
  playlistSelector.classList.remove('hidden');
  manualInput.classList.remove('hidden');

  fetch('/my_playlists')
    .then(res => res.json())
    .then(data => {
      playlistLoading.classList.add('hidden');

      if (data.error) {
        playlistGrid.innerHTML = '<p class="error">Failed to load playlists. Please try manual input.</p>';
        manualInput.classList.remove('hidden');
        return;
      }

      if (data.playlists.length === 0) {
        playlistGrid.innerHTML = '<p>No playlists found. Create some playlists in Spotify first!</p>';
        manualInput.classList.remove('hidden');
        return;
      }

      // Display playlists as cards
      playlistGrid.innerHTML = '';
      data.playlists.forEach(playlist => {
        const card = document.createElement('div');
        card.className = 'playlist-card';
        card.dataset.playlistId = playlist.id;
        card.dataset.playlistName = playlist.name;
        card.dataset.playlistTracks = playlist.tracks;
        card.dataset.playlistOwner = playlist.owner;
        card.dataset.playlistImage = playlist.image || '';

        card.innerHTML = `
          ${playlist.image ? `<img src="${playlist.image}" alt="${playlist.name}">` : '<div class="no-image">🎵</div>'}
          <div class="playlist-info">
            <h4>${playlist.name}</h4>
            <p>${playlist.tracks} tracks</p>
            <small>by ${playlist.owner}</small>
          </div>
        `;

        card.addEventListener('mousedown', (e) => {
          card.style.transform = 'scale(0.92)';
          card.style.boxShadow = '0 1px 4px rgba(102, 126, 234, 0.6)';
        });

        card.addEventListener('mouseup', (e) => {
          // Don't remove effect here, let the click handler decide
        });

        card.addEventListener('mouseleave', (e) => {
          // Only remove effect if card is not selected
          if (!card.classList.contains('selected')) {
            card.style.transform = '';
            card.style.boxShadow = '';
          }
        });

        card.addEventListener('click', () => {
          openPlaylistModal(playlist);
        });

        playlistGrid.appendChild(card);
      });

      // Setup playlist search filter
      const searchInput = document.getElementById('playlistSearch');
      if (searchInput) {
        searchInput.addEventListener('input', (e) => {
          const query = e.target.value.toLowerCase().trim();
          document.querySelectorAll('.playlist-card').forEach(card => {
            const playlistName = card.dataset.playlistName.toLowerCase();
            const playlistOwner = card.dataset.playlistOwner.toLowerCase();

            // Show card if query matches name or owner, or if query is empty
            if (query === '' || playlistName.includes(query) || playlistOwner.includes(query)) {
              card.style.display = '';
            } else {
              card.style.display = 'none';
            }
          });
        });
      }

    })
    .catch(err => {
      console.error('Error loading playlists:', err);
      playlistLoading.classList.add('hidden');
      playlistGrid.innerHTML = '<p class="error">Failed to load playlists.</p>';
      manualInput.classList.remove('hidden');
    });
}

// Device Modal Event Listeners
const connectDeviceBtn = document.getElementById('connectDeviceBtn');
const closeDeviceModalBtn = document.getElementById('closeDeviceModal');
const refreshDevicesBtn = document.getElementById('refreshDevicesBtn');
const retryDevicesBtn = document.getElementById('retryDevicesBtn');

if (connectDeviceBtn) {
  connectDeviceBtn.addEventListener('click', openDeviceModal);
}

if (closeDeviceModalBtn) {
  closeDeviceModalBtn.addEventListener('click', closeDeviceModal);
}

if (refreshDevicesBtn) {
  refreshDevicesBtn.addEventListener('click', loadDeviceList);
}

if (retryDevicesBtn) {
  retryDevicesBtn.addEventListener('click', loadDeviceList);
}

// Close modal when clicking backdrop
const deviceModal = document.getElementById('deviceModal');
if (deviceModal) {
  deviceModal.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) {
      closeDeviceModal();
    }
  });
}

if (skipLoginBtn) {
  skipLoginBtn.addEventListener('click', () => {
    if (loginScreen) loginScreen.classList.add('hidden');
    if (createScreen) createScreen.classList.remove('hidden');
  });
}

// Create Room
createRoomBtn.addEventListener('click', () => {
  let playlistId;

  // Use selected playlist if available, otherwise use manual input
  if (selectedPlaylistId) {
    playlistId = selectedPlaylistId;
  } else {
    playlistId = playlistIdInput.value.trim();
  }

  if (!playlistId) {
    showErrorModal('Playlist Required', 'Please select a playlist from the list or enter a Spotify playlist ID/URL.');
    return;
  }

  socket.emit('create_room', { playlist_id: playlistId });
});

// Start Game
startGameBtn.addEventListener('click', () => {
  if (!currentPin) return;

  // Get song count and games count from sliders
  const songCount = songCountSlider ? parseInt(songCountSlider.value) : 10;
  const gamesCount = gamesCountSlider ? parseInt(gamesCountSlider.value) : 1;

  // Disable button and show progress
  startGameBtn.disabled = true;
  startGameBtn.textContent = 'Generating questions...';
  startGameBtn.classList.add('hidden');

  // Hide song count and games count selectors, show progress
  const songCountContainer = document.querySelector('.bg-white.rounded-2xl.shadow-lg.p-6.mb-6:has(#songCountSlider)');
  const gamesCountContainer = document.querySelector('.bg-white.rounded-2xl.shadow-lg.p-6.mb-6:has(#gamesCountSlider)');
  const progressContainer = document.getElementById('generatingProgress');

  if (songCountContainer) {
    songCountContainer.classList.add('hidden');
  }
  if (gamesCountContainer) {
    gamesCountContainer.classList.add('hidden');
  }
  if (progressContainer) {
    progressContainer.classList.remove('hidden');
  }

  const vibEnabled = userSettings ? userSettings.vibration_enabled !== false : true;
  socket.emit('start_game', { pin: currentPin, song_count: songCount, games_count: gamesCount, vibration_enabled: vibEnabled });
});

// Next Song (button currently commented out in HTML)
if (nextSongBtn) {
  nextSongBtn.addEventListener('click', () => {
    if (!currentPin) return;

    socket.emit('next_question', { pin: currentPin });
  });
}

// New Game
newGameBtn.addEventListener('click', () => {
  location.reload();
});

// Socket Events
socket.on('connected', (data) => {
  console.log('Connected to server:', data.sid);
});

socket.on('question_progress', (data) => {

  const progressBarFill = document.getElementById('progressBarFill');
  const progressText = document.getElementById('progressText');
  const progressTotalSongs = document.getElementById('progressTotalSongs');

  if (progressBarFill && progressText) {
    const percentage = (typeof data.percent === 'number')
      ? data.percent
      : ((data.current / data.total) * 100);
    progressBarFill.style.width = percentage + '%';
    if (data.label) {
      progressText.textContent = data.label;
    } else {
      progressText.textContent = `Preparing track ${data.current} of ${data.total}`;
    }
    if (progressTotalSongs) {
      progressTotalSongs.textContent = data.total ?? 100;
    }

  }
});

socket.on('room_created', (data) => {
  currentPin = data.pin;
  roomPinDisplay.textContent = data.pin;

  const roomPinText = document.getElementById('roomPinText');
  if (roomPinText) {
    roomPinText.textContent = data.pin;
  }

  // Generate QR code for participants to join
  const qrcodeContainer = document.getElementById('qrcode');
  if (qrcodeContainer) {
    qrcodeContainer.innerHTML = ''; // Clear any existing QR code
    const participantUrl = `${window.location.origin}/participant?pin=${data.pin}`;
    new QRCode(qrcodeContainer, {
      text: participantUrl,
      width: 200,
      height: 200,
      colorDark: '#667eea',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  }

  showScreen(waitingScreen);

  // Pre-acquire mic access so it's ready when the game starts
  if (micVisualizerEnabled && !micStream) {
    setupMicVisualization().then(() => {
      stopVisualization(); // Stop drawing, just keep the stream ready
    });
  }
});

socket.on('participant_joined', (data) => {
  updateParticipantsList(data.participants);
});

socket.on('participant_left', (data) => {
  updateParticipantsList(data.participants);
});

socket.on('token_refreshed', (data) => {
  console.log('Received refreshed Spotify token');
  spotifyAccessToken = data.access_token;

  // No need to reinitialize - the player's getOAuthToken callback
  // will automatically use the updated spotifyAccessToken
  console.log('Token updated - player will use new token automatically');
});

socket.on('game_started', (data) => {
  // Auto-fullscreen if setting is enabled
  if (userSettings && userSettings.auto_fullscreen && !document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  }

  // Hide progress bar and reset button
  const progressContainer = document.getElementById('generatingProgress');
  if (progressContainer) {
    progressContainer.classList.add('hidden');
  }

  // Show song count and games count selectors again
  const songCountContainer = document.querySelector('.bg-white.rounded-2xl.shadow-lg.p-6.mb-6:has(#songCountSlider)');
  const gamesCountContainer = document.querySelector('.bg-white.rounded-2xl.shadow-lg.p-6.mb-6:has(#gamesCountSlider)');
  if (songCountContainer) {
    songCountContainer.classList.remove('hidden');
  }
  if (gamesCountContainer) {
    gamesCountContainer.classList.remove('hidden');
  }

  startGameBtn.disabled = false;
  startGameBtn.textContent = 'Start Game';
  startGameBtn.classList.remove('hidden');

  totalSongs.textContent = data.total_songs;

  // Track series info
  gamesInSeries = data.games_in_series || 1;
  currentGameNumber = data.current_game || 1;

  // Update header if multiple games
  const gameHeaderLeft = document.getElementById('gameHeaderLeft');
  if (gamesInSeries > 1 && gameHeaderLeft) {
    gameHeaderLeft.innerHTML = `<span class="text-sm font-semibold text-purple-600">Game ${currentGameNumber} of ${gamesInSeries}</span>`;
  } else if (gameHeaderLeft) {
    gameHeaderLeft.innerHTML = '';
  }

  // Generate compact QR code for game screen
  const compactQrcodeContainer = document.getElementById('compactQrcode');
  const compactPinDisplay = document.getElementById('compactRoomPin');

  if (compactQrcodeContainer && currentPin) {
    compactQrcodeContainer.innerHTML = ''; // Clear any existing QR code
    const participantUrl = `${window.location.origin}/participant?pin=${currentPin}`;
    new QRCode(compactQrcodeContainer, {
      text: participantUrl,
      width: 80,
      height: 80,
      colorDark: '#4f46e5',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.L
    });
  }

  if (compactPinDisplay) {
    compactPinDisplay.textContent = currentPin;
  }

  showScreen(gameScreen);
});

socket.on('new_question', (data) => {
  // Hide standings modal if showing
  if (standingsModal && !standingsModal.classList.contains('hidden')) {
    standingsModal.classList.add('hidden');

    // Reset and clear countdown timer
    const countdownTimer = standingsModal.querySelector('#countdownTimer');
    if (countdownTimer) {
      const intervalId = countdownTimer.dataset.intervalId;
      if (intervalId) {
        clearInterval(parseInt(intervalId));
      }
      countdownTimer.textContent = '5';
    }
  }

  currentQuestion = data;
  displayQuestion(data);
  // Timer will be started when playback_started event is received
});

socket.on('scores_updated', (data) => {
  updateScoreboard(data.scores);
});

socket.on('show_correct_answer', (data) => {
  displayCorrectAnswer(data.correct_answer, data.correct_artist);
});

socket.on('player_answered', (data) => {
  displayVotedParticipant(data.player_name, data.response_time_ms);
});

socket.on('question_timeout', () => {
  stopQuestionTimer();
  console.log('Question timeout - voting ended');
});

socket.on('start_question_timer', () => {
  console.log('Starting question timer');
  startQuestionTimer();
});

socket.on('show_intermediate_scores', (data) => {
  // Stop the timer immediately
  stopQuestionTimer();

  // Stop music playback
  if (useSpotifyConnect && selectedConnectDevice) {
    pauseConnectPlayback();
  } else if (spotifyPlayer && deviceId && !useSpotifyConnect) {
    try {
      spotifyPlayer.pause();
    } catch (err) {
      console.log('SDK pause skipped:', err.message);
    }
  } else if (audioPlayer) {
    audioPlayer.pause();
  }

  // Ensure correct answer is processed
  if (currentQuestion && currentQuestion.correct_answer !== undefined) {
    displayCorrectAnswer(currentQuestion.correct_answer);
  }

  // Update intermediate scoreboard
  updateIntermediateScoreboard(data.scores);

  // Show modal immediately with correct answer at top
  if (standingsModal) {
    // Display correct answer
    const correctAnswerText = document.getElementById('correctAnswerText');
    if (correctAnswerText && currentQuestion) {
      const correctArtist = currentQuestion.displayedCorrectArtist ||
        (currentQuestion.options && currentQuestion.options[currentQuestion.correct_answer]) ||
        'Unknown';
      correctAnswerText.textContent = correctArtist;
    }

    standingsModal.classList.remove('hidden');

    // Notify server that standings are displayed
    socket.emit('standings_displayed', { pin: currentPin });

    const countdownTimer = standingsModal.querySelector('#countdownTimer');
    if (data.is_last_question) {
      // Last question — no countdown, server will send game_ended/series_ended
      if (countdownTimer) countdownTimer.textContent = '';
    } else {
      // Start countdown timer (3, 2, 1, EJECT!)
      if (countdownTimer) {
        let countdown = 3;
        countdownTimer.textContent = countdown;

        const countdownInterval = setInterval(() => {
          countdown--;
          if (countdown > 0) {
            countdownTimer.textContent = countdown;
          } else {
            clearInterval(countdownInterval);
            countdownTimer.textContent = 'EJECT!';
          }
        }, 1000);

        countdownTimer.dataset.intervalId = countdownInterval;
      }
    }
  }
});

// Server triggers advance when all participants are ready
socket.on('advance_question', () => {
  console.log('Server triggered advance to next question');
  socket.emit('next_question', { pin: currentPin });
});

socket.on('game_ended', (data) => {
  // This is the end of one game in a series (not the final game)
  // Hide standings modal if showing
  if (standingsModal && !standingsModal.classList.contains('hidden')) {
    standingsModal.classList.add('hidden');
  }

  // Stop music/audio playback
  if (useSpotifyConnect && selectedConnectDevice) {
    pauseConnectPlayback();
  } else if (spotifyPlayer && deviceId && !useSpotifyConnect) {
    try {
      spotifyPlayer.pause();
    } catch (err) {
      console.log('SDK pause skipped:', err.message);
    }
  } else if (audioPlayer) {
    audioPlayer.pause();
  }

  // Display intermediate game results with series scores
  displayGameEndScores(data.game_scores, data.series_scores, data.current_game, data.total_games);
});

socket.on('series_ended', (data) => {
  // This is the end of the entire series
  // Hide standings modal if showing
  if (standingsModal && !standingsModal.classList.contains('hidden')) {
    standingsModal.classList.add('hidden');
  }

  // Stop music/audio playback
  if (useSpotifyConnect && selectedConnectDevice) {
    pauseConnectPlayback();
  } else if (spotifyPlayer && deviceId && !useSpotifyConnect) {
    try {
      spotifyPlayer.pause();
    } catch (err) {
      console.log('SDK pause skipped:', err.message);
    }
  } else if (audioPlayer) {
    audioPlayer.pause();
  }

  displayFinalScores(data.final_scores, data.games_played);
  showScreen(endScreen);
});

socket.on('error', (data) => {
  showErrorModal('Error', data.message);
});

socket.on('room_closed', (data) => {
  showErrorModal('Room Closed', data.message);
  setTimeout(() => {
    location.href = '/';
  }, 3000);
});

// Helper Functions
function showScreen(screen) {
  [createScreen, waitingScreen, gameScreen, endScreen].forEach(s => {
    s.classList.add('hidden');
  });
  screen.classList.remove('hidden');
}

function updateParticipantsList(participants) {
  participantCount.textContent = participants.length;
  participantsList.innerHTML = '';

  participants.forEach((p, index) => {
    const li = document.createElement('li');
    li.className = 'flex items-center gap-3 p-2 bg-gray-50 rounded-lg';

    const avatarUrl = getAvatarUrl(p.name, index);

    li.innerHTML = `
      <img src="${avatarUrl}" alt="${p.name}" class="w-8 h-8 rounded-full">
      <span class="font-medium text-gray-800">${p.name}</span>
    `;
    participantsList.appendChild(li);
  });
}

function displayQuestion(data) {
  // Debug logging
  // console.log('=== Question Data ===');
  // console.log('Track Name:', data.track_name);
  // console.log('Artist:', data.options ? data.options[data.correct_answer] : 'N/A');
  // console.log('All Options:', data.options);
  // console.log('Correct Answer Index:', data.correct_answer);
  // console.log('Track URI:', data.track_uri);
  // console.log('Preview URL:', data.preview_url);
  // console.log('Question Number:', data.question_number, '/', data.total_questions);
  // console.log('====================');

  // Reset voted participants display
  const votedParticipants = document.getElementById('votedParticipants');
  if (votedParticipants) {
    votedParticipants.innerHTML = '';
  }

  songNumber.textContent = data.question_number;
  totalSongs.textContent = data.total_questions;

  // Update multiplier display
  if (multiplierValue && data.multiplier) {
    multiplierValue.textContent = data.multiplier + 'x';
    // Add visual emphasis for higher multipliers
    multiplierValue.className = 'multiplier-value';
    if (data.multiplier >= 4) {
      multiplierValue.classList.add('multiplier-4x');
    } else if (data.multiplier >= 2) {
      multiplierValue.classList.add('multiplier-2x');
    }
  }

  // Try Web Playback SDK first if available and we have a track URI
  let audioAvailable = false;

  if (data.track_uri && spotifyPlayer && deviceId) {
    console.log('Using Spotify Web Playback SDK for track:', data.track_uri);

    // Await playback result and handle failures with retry
    let retryCount = 0;
    const maxRetries = 2;

    const attemptPlayback = () => {
      // Use Spotify Connect if a device is selected, otherwise use Web Playback SDK
      const playbackPromise = (useSpotifyConnect && selectedConnectDevice)
        ? playTrackOnConnectDevice(data.track_uri, selectedConnectDevice.id)
        : playSpotifyTrack(data.track_uri);

      playbackPromise.then(success => {
        if (!success) {
          retryCount++;
          console.log(`Playback failed (attempt ${retryCount}/${maxRetries + 1})`);

          if (retryCount <= maxRetries) {
            // Show retry notification
            const notification = document.createElement('div');
            notification.className = 'fixed top-4 right-4 bg-orange-500 text-white px-6 py-3 rounded-lg shadow-lg z-50 animate-fade-in';
            notification.innerHTML = `
              <div class="flex items-center gap-2">
                <svg class="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                </svg>
                <span>Playback failed, retrying... (${retryCount}/${maxRetries})</span>
              </div>
            `;
            document.body.appendChild(notification);

            // Remove notification after 2 seconds
            setTimeout(() => {
              notification.style.opacity = '0';
              notification.style.transition = 'opacity 0.3s';
              setTimeout(() => notification.remove(), 300);
            }, 2000);

            // Retry after 2 seconds
            setTimeout(attemptPlayback, 2000);
          } else {
            // Max retries reached - show final error and skip to next
            const notification = document.createElement('div');
            notification.className = 'fixed top-4 right-4 bg-red-500 text-white px-6 py-3 rounded-lg shadow-lg z-50 animate-fade-in';
            notification.innerHTML = `
              <div class="flex items-center gap-2">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
                <span>Playback failed after ${maxRetries + 1} attempts, skipping...</span>
              </div>
            `;
            document.body.appendChild(notification);

            // Remove notification after 4 seconds
            setTimeout(() => {
              notification.style.opacity = '0';
              notification.style.transition = 'opacity 0.3s';
              setTimeout(() => notification.remove(), 300);
            }, 4000);

            // Skip to next question after 2 seconds
            setTimeout(() => {
              if (currentPin) {
                socket.emit('next_question', { pin: currentPin });
              }
            }, 2000);
          }
        }
      });
    };

    // Start first attempt
    attemptPlayback();

    audioAvailable = true;
    // Use mic visualization if enabled, otherwise simulated
    if (micVisualizerEnabled) {
      setupMicVisualization().then(ok => {
        if (!ok) startVisualizerAnimation();
      });
    } else {
      startVisualizerAnimation();
    }
  } else if (data.preview_url) {
    // Fall back to preview URL
    console.log('Using preview URL');
    audioPlayer.src = data.preview_url;
    audioPlayer.load();

    // Listen for actual playback start (after buffering)
    const onPlaying = () => {
      console.log('HTML5 audio actually started playing');
      // Notify backend that playback has started
      socket.emit('playback_started', { pin: currentPin });
      // Remove listener to avoid multiple triggers
      audioPlayer.removeEventListener('playing', onPlaying);
    };
    audioPlayer.addEventListener('playing', onPlaying);

    // Start playback
    audioPlayer.play().catch(err => {
      console.error('Error starting audio playback:', err);
    });

    audioAvailable = true;
    // Start audio visualization
    setupAudioVisualization();
  }

  // Handle no audio case
  if (!audioAvailable) {
    audioPlayer.removeAttribute('src');
    stopVisualization();

    // Show a visual indicator instead
    const audioContainer = audioPlayer.parentElement;
    let noAudioMsg = document.getElementById('noAudioMessage');
    if (!noAudioMsg) {
      noAudioMsg = document.createElement('div');
      noAudioMsg.id = 'noAudioMessage';
      noAudioMsg.className = 'no-audio-message';
      audioContainer.appendChild(noAudioMsg);
    }
    noAudioMsg.innerHTML = `
      <p>⚠️ No audio preview available for this track</p>
      <p class="track-hint">Track: "${data.track_name}"</p>
      <small>Some tracks don't have preview URLs. Try using your own playlists or login with Spotify for better availability.</small>
    `;
    noAudioMsg.style.display = 'block';
  } else {
    audioPlayer.style.display = 'block';
    const noAudioMsg = document.getElementById('noAudioMessage');
    if (noAudioMsg) {
      noAudioMsg.style.display = 'none';
    }
  }

  // Display options
  data.options.forEach((artist, index) => {
    const optionElement = document.getElementById(`option${index}`);
    if (optionElement) {
      optionElement.textContent = artist;
    }
  });

  // Reset answer highlights
  document.querySelectorAll('.answer-option').forEach(opt => {
    opt.classList.remove('correct', 'incorrect');
  });
}

function displayVotedParticipant(playerName, responseTimeMs) {
  const votedParticipants = document.getElementById('votedParticipants');
  if (!votedParticipants) return;

  // Check if already displayed to avoid duplicates
  if (votedParticipants.querySelector(`[data-player="${playerName}"]`)) {
    return;
  }

  const avatarUrl = getAvatarUrlByName(playerName);

  // Format response time
  let timeDisplay = '';
  if (responseTimeMs !== null && responseTimeMs !== undefined) {
    timeDisplay = `<span class="text-xs text-gray-500">${responseTimeMs}ms</span>`;
  }

  const timeValue = (responseTimeMs !== null && responseTimeMs !== undefined) ? responseTimeMs : 999999;

  const avatarDiv = document.createElement('div');
  avatarDiv.className = 'flex flex-col items-center gap-1';
  avatarDiv.setAttribute('data-player', playerName);
  avatarDiv.setAttribute('data-response-time', timeValue);
  avatarDiv.innerHTML = `
    <img src="${avatarUrl}" alt="${playerName}" class="w-12 h-12 rounded-full shadow-md">
    <span class="text-sm text-gray-600 font-medium max-w-[70px] truncate">${playerName}</span>
    ${timeDisplay}
  `;

  // Insert sorted by response time (fastest first)
  const insertBefore = Array.from(votedParticipants.children).find(el =>
    parseFloat(el.getAttribute('data-response-time')) > timeValue
  );
  if (insertBefore) {
    votedParticipants.insertBefore(avatarDiv, insertBefore);
  } else {
    votedParticipants.appendChild(avatarDiv);
  }
}

function displayCorrectAnswer(correctIndex, correctArtist) {
  // Stop the timer
  stopQuestionTimer();

  // Pause audio and stop visualization
  if (spotifyPlayer && deviceId) {
    spotifyPlayer.pause();
  } else {
    audioPlayer.pause();
  }
  stopVisualization();

  // Store correct answer data for display in modal
  if (currentQuestion) {
    currentQuestion.displayedCorrectArtist = correctArtist || (currentQuestion.options && currentQuestion.options[correctIndex]);
  }
}

function updateScoreboard(scores) {
  // Safety check - scoreboard element was removed from game screen
  if (!scoresList) {
    return;
  }

  scoresList.innerHTML = '';

  scores.forEach((player, index) => {
    const div = document.createElement('div');
    div.className = 'score-item';

    if (index === 0) div.classList.add('first');
    else if (index === 1) div.classList.add('second');
    else if (index === 2) div.classList.add('third');

    div.innerHTML = `
            <span>${index + 1}. ${player.name}</span>
            <span>${player.score} pts</span>
        `;

    scoresList.appendChild(div);
  });
}

function updateIntermediateScoreboard(scores) {
  intermediateScoresList.innerHTML = '';

  scores.forEach((player, index) => {
    const div = document.createElement('div');
    div.className = 'flex items-center justify-between p-4 bg-gray-50 rounded-lg';

    const avatarUrl = getAvatarUrl(player.name, index);

    // Format points gained display
    const pointsGainedHtml = player.points_gained > 0
      ? `<span class="text-lg font-semibold text-green-600">+${player.points_gained}</span>`
      : `<span class="text-2xl">💀</span>`;

    div.innerHTML = `
      <div class="flex items-center gap-4">
        <span class="text-2xl font-bold text-gray-600 w-8">${index + 1}</span>
        <img src="${avatarUrl}" alt="${player.name}" class="w-12 h-12 rounded-full">
        <span class="text-lg font-semibold text-gray-800">${player.name}</span>
      </div>
      <div class="flex items-center gap-1">
        <span class="text-xl font-bold text-primary">${player.score} pts</span>
        ${pointsGainedHtml}
      </div>
    `;

    intermediateScoresList.appendChild(div);
  });
}

function displayGameEndScores(gameScores, seriesScores, currentGame, totalGames) {
  // Create a modal for intermediate game results
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content max-w-3xl">
      <div class="text-center mb-6">
        <h2 class="text-3xl font-bold text-gray-800 mb-2">Game ${currentGame} Complete! 🎉</h2>
        <p class="text-gray-600">Game ${currentGame} of ${totalGames}</p>
      </div>
      
      <div class="mb-6">
        <h3 class="text-xl font-bold text-gray-800 mb-4">This Game Results</h3>
        <div id="gameScoresList" class="space-y-2 mb-6"></div>
      </div>
      
      <div class="mb-6 pt-6 border-t-2 border-gray-200">
        <h3 class="text-xl font-bold text-gray-800 mb-4">Overall Series Standings</h3>
        <div id="seriesScoresList" class="space-y-2"></div>
      </div>
      
      <div class="text-center mb-4">
        <p class="text-gray-600 mb-2">Next game starts in</p>
        <div class="text-5xl font-bold text-primary" id="nextGameCountdown">10</div>
      </div>
      
      <button onclick="startNextGameNow(this)" 
        class="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white font-bold py-4 rounded-lg shadow-lg transition-all text-lg">
        Start Game ${currentGame + 1} Now
      </button>
    </div>
  `;

  document.body.appendChild(modal);

  // Start countdown timer
  let countdown = 10;
  const countdownElement = modal.querySelector('#nextGameCountdown');
  const countdownInterval = setInterval(() => {
    countdown--;
    if (countdownElement) {
      countdownElement.textContent = countdown;

      // Add visual emphasis when countdown is low
      if (countdown <= 3) {
        countdownElement.classList.add('text-red-500');
        countdownElement.classList.remove('text-primary');
      }
    }

    if (countdown <= 0) {
      clearInterval(countdownInterval);
      modal.remove();
      socket.emit('start_next_game', { pin: currentPin });
    }
  }, 1000);

  // Display game scores
  const gameScoresList = modal.querySelector('#gameScoresList');
  gameScores.forEach((player, index) => {
    const div = document.createElement('div');
    div.className = 'flex items-center justify-between p-3 bg-gray-50 rounded-lg';
    const avatarUrl = getAvatarUrl(player.name, index);

    div.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="text-xl font-bold text-gray-600 w-6">${index + 1}</span>
        <img src="${avatarUrl}" alt="${player.name}" class="w-10 h-10 rounded-full">
        <span class="text-base font-semibold text-gray-800">${player.name}</span>
      </div>
      <span class="text-lg font-bold text-primary">${player.score} pts</span>
    `;
    gameScoresList.appendChild(div);
  });

  // Display series scores
  const seriesScoresList = modal.querySelector('#seriesScoresList');
  seriesScores.forEach((player, index) => {
    const div = document.createElement('div');
    div.className = 'flex items-center justify-between p-4 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-lg border-2 border-primary';
    const avatarUrl = getAvatarUrl(player.name, index);

    let medal = '';
    if (index === 0) medal = '🥇';
    else if (index === 1) medal = '🥈';
    else if (index === 2) medal = '🥉';

    div.innerHTML = `
      <div class="flex items-center gap-4">
        ${medal ? `<span class="text-2xl">${medal}</span>` : `<span class="text-xl font-bold text-gray-600 w-6">${index + 1}</span>`}
        <img src="${avatarUrl}" alt="${player.name}" class="w-12 h-12 rounded-full">
        <span class="text-lg font-semibold text-gray-800">${player.name}</span>
      </div>
      <span class="text-2xl font-bold text-purple-600">${player.series_score} pts</span>
    `;
    seriesScoresList.appendChild(div);
  });
}

function startNextGameNow(button) {
  // Remove the modal
  const modal = button.closest('.modal');
  if (modal) {
    modal.remove();
  }
  // Start next game immediately
  socket.emit('start_next_game', { pin: currentPin });
}

function displayFinalScores(scores, gamesPlayed) {
  finalScores.innerHTML = '';

  // Update title if multiple games
  const endTitle = document.querySelector('#endScreen h1');
  if (endTitle && gamesPlayed > 1) {
    endTitle.textContent = `Series Complete! (${gamesPlayed} Games)`;
  }

  scores.forEach((player, index) => {
    const div = document.createElement('div');
    div.className = 'flex items-center justify-between p-4 bg-gray-50 rounded-lg';

    let medal = '';
    if (index === 0) medal = '🥇';
    else if (index === 1) medal = '🥈';
    else if (index === 2) medal = '🥉';

    const avatarUrl = getAvatarUrl(player.name, index);

    // Use series_score for multi-game, score for single game
    const finalScore = player.series_score !== undefined ? player.series_score : player.score;

    div.innerHTML = `
      <div class="flex items-center gap-4">
        ${medal ? `<span class="text-3xl">${medal}</span>` : `<span class="text-2xl font-bold text-gray-600 w-8">${index + 1}</span>`}
        <img src="${avatarUrl}" alt="${player.name}" class="w-12 h-12 rounded-full">
        <span class="text-lg font-semibold text-gray-800">${player.name}</span>
      </div>
      <span class="text-xl font-bold text-primary">${finalScore} pts</span>
    `;

    finalScores.appendChild(div);
  });
}

// Audio Visualization
let audioContext;
let analyser;
let dataArray;
let bufferLength;
let animationId;
let animationRunning = false;
let visualizerStyle = 'bars-light';
const VISUALIZER_STYLES = [
  'vintage-dark', 'vintage-light',
  'flat-dark', 'flat-light',
  'rainbow-dark', 'rainbow-light',
  'neon-dark', 'neon-light',
  'spectrum3d-dark', 'spectrum3d-light',
  'bars-dark', 'bars-light',
  'mirror-dark', 'mirror-light',
  'led-dark', 'led-light',
];

// Neon Waves state
const waveColors = [
  { r: 0, g: 200, b: 255 },
  { r: 150, g: 50, b: 255 },
  { r: 255, g: 50, b: 150 },
  { r: 50, g: 255, b: 200 },
];
const WAVE_LAYERS = 4;
let waveTime = 0;

// 3D Spectrum state
const spectrumHistory = [];
const HISTORY_DEPTH = 20;
let spectrumFrame = 0;

// Microphone visualization
let micStream = null;
let micSource = null;
let micGainNode = null;
let micAnalyser = null;
let micVisualizerEnabled = false;
let micGainValue = 4;

function setupAudioVisualization() {
  const canvas = document.getElementById('audioVisualizer');
  if (!canvas) return;

  const canvasCtx = canvas.getContext('2d');

  // Create audio context if not exists
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;

    const source = audioContext.createMediaElementSource(audioPlayer);
    source.connect(analyser);
    analyser.connect(audioContext.destination);
  }

  bufferLength = analyser.frequencyBinCount;
  dataArray = new Uint8Array(bufferLength);

  // Start visualization
  visualize(canvas, canvasCtx);
}

function startVisualizerAnimation() {
  // For Spotify SDK playback, create an enhanced simulated animation
  const canvas = document.getElementById('audioVisualizer');
  if (!canvas) return;

  const canvasCtx = canvas.getContext('2d');
  animationRunning = true;
  simulatedVisualize(canvas, canvasCtx);
}

function resizeCanvas(canvas) {
  const displayWidth = canvas.clientWidth;
  const displayHeight = canvas.clientHeight;
  if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
    canvas.width = displayWidth;
    canvas.height = displayHeight;
  }
}

// Cycle visualizer on canvas click
(function() {
  const c = document.getElementById('audioVisualizer');
  if (c) {
    c.style.cursor = 'pointer';
    c.addEventListener('click', () => {
      const idx = VISUALIZER_STYLES.indexOf(visualizerStyle);
      visualizerStyle = VISUALIZER_STYLES[(idx + 1) % VISUALIZER_STYLES.length];
      const sel = document.getElementById('settingVisualizerStyle');
      if (sel) sel.value = visualizerStyle;
      if (userSettings) userSettings.visualizer_style = visualizerStyle;
    });
  }
})();

function visualize(canvas, canvasCtx) {
  if (!analyser) return;

  animationRunning = true;

  function draw() {
    if (!animationRunning) return;

    animationId = requestAnimationFrame(draw);
    resizeCanvas(canvas);
    analyser.getByteFrequencyData(dataArray);

    const isDark = visualizerStyle.endsWith('-dark');
    dispatchDraw(canvas, canvasCtx, isDark);
  }

  draw();
}

function dispatchDraw(canvas, ctx, isDark) {
  const base = visualizerStyle.replace(/-dark$|-light$/, '');
  switch (base) {
    case 'vintage': drawVintageVU(canvas, ctx, isDark); break;
    case 'flat': drawFlatBars(canvas, ctx, isDark); break;
    case 'rainbow': drawRainbowEq(canvas, ctx, isDark); break;
    case 'neon': drawNeonWaves(canvas, ctx, isDark); break;
    case 'spectrum3d': drawSpectrum3D(canvas, ctx, isDark); break;
    case 'bars': drawBars(canvas, ctx, isDark); break;
    case 'mirror': drawMirror(canvas, ctx, isDark); break;
    case 'led': drawLedBars(canvas, ctx, isDark); break;
    default: drawVintageVU(canvas, ctx, true);
  }
}

// ===== Helper: compute L/R levels from dataArray =====
// Uses RMS of the most energetic frequency bins (lower half)
// rather than averaging all bins — much more sensitive and realistic.
function getLevelsFromData() {
  // Only use lower half of spectrum where most audio energy lives
  const useBins = Math.max(8, Math.floor(bufferLength * 0.5));
  let sumSq = 0;
  for (let i = 0; i < useBins; i++) {
    const v = dataArray[i] / 255;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / useBins);
  // RMS of 0..1 range tends to be low, scale up for better needle movement
  const level = Math.min(1, rms * 1.2);
  return {
    l: Math.min(1, level * (0.97 + Math.random() * 0.06)),
    r: Math.min(1, level * (0.97 + Math.random() * 0.06)),
  };
}

// ===== A: Vintage VU Meter =====
function dbToArcPosition(db) {
  const map = [
    [-20, 0.00], [-10, 0.20], [-7, 0.30], [-5, 0.40],
    [-3, 0.50], [-2, 0.57], [-1, 0.64], [0, 0.72],
    [1, 0.81], [2, 0.90], [3, 1.00]
  ];
  if (db <= map[0][0]) return map[0][1];
  if (db >= map[map.length - 1][0]) return map[map.length - 1][1];
  for (let i = 0; i < map.length - 1; i++) {
    if (db >= map[i][0] && db <= map[i + 1][0]) {
      const frac = (db - map[i][0]) / (map[i + 1][0] - map[i][0]);
      return map[i][1] + frac * (map[i + 1][1] - map[i][1]);
    }
  }
  return 0;
}

function drawVintageVU(canvas, ctx, isDark) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = isDark ? '#1a1a1a' : '#888';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = isDark ? '#2a2a2a' : '#999';
  ctx.fillRect(4, 4, w - 8, h - 8);

  const { l, r } = getLevelsFromData();
  const meterW = (w - 30) / 2;
  const meterH = h - 20;
  drawVintageGauge(ctx, 10, 10, meterW, meterH, l, 'L');
  drawVintageGauge(ctx, meterW + 20, 10, meterW, meterH, r, 'R');
}

function drawVintageGauge(ctx, ox, oy, w, h, level, label) {
  const grad = ctx.createLinearGradient(ox, oy, ox, oy + h);
  grad.addColorStop(0, '#f5ecd0');
  grad.addColorStop(0.5, '#f8f1dc');
  grad.addColorStop(1, '#ece3c8');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(ox, oy, w, h, 4);
  ctx.fill();
  ctx.strokeStyle = '#8a7e6a';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const cx = ox + w / 2;
  const cy = oy + h + h * 0.55;
  const radius = h * 1.3;
  const startAngle = Math.PI * 1.28;
  const endAngle = Math.PI * 1.72;
  const arcRange = endAngle - startAngle;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(ox + 1, oy + 1, w - 2, h - 2, 4);
  ctx.clip();

  // VU label
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.max(12, h * 0.13)}px serif`;
  ctx.fillStyle = '#333';
  ctx.fillText('VU', cx, oy + h * 0.82);

  // dB scale
  const dbTicks = [
    { db: -20, label: '20' }, { db: -10, label: '10' },
    { db: -7, label: '7' }, { db: -5, label: '5' },
    { db: -3, label: '3' }, { db: -2, label: '2' },
    { db: -1, label: '1' }, { db: 0, label: '0' },
    { db: 1, label: '1' }, { db: 2, label: '2' }, { db: 3, label: '3' }
  ];
  ctx.font = `bold ${Math.max(10, Math.min(15, w * 0.045))}px sans-serif`;

  for (const tick of dbTicks) {
    const t = dbToArcPosition(tick.db);
    const angle = startAngle + t * arcRange;
    const isRed = tick.db >= 0;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * radius * 0.90, cy + Math.sin(angle) * radius * 0.90);
    ctx.lineTo(cx + Math.cos(angle) * radius * 0.96, cy + Math.sin(angle) * radius * 0.96);
    ctx.strokeStyle = isRed ? '#c02316' : '#333';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = isRed ? '#c02316' : '#333';
    ctx.fillText(tick.label, cx + Math.cos(angle) * radius * 0.83, cy + Math.sin(angle) * radius * 0.83);
  }

  // Minor ticks
  for (let i = 0; i < dbTicks.length - 1; i++) {
    const tMid = (dbToArcPosition(dbTicks[i].db) + dbToArcPosition(dbTicks[i + 1].db)) / 2;
    const angle = startAngle + tMid * arcRange;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * radius * 0.93, cy + Math.sin(angle) * radius * 0.93);
    ctx.lineTo(cx + Math.cos(angle) * radius * 0.96, cy + Math.sin(angle) * radius * 0.96);
    ctx.strokeStyle = '#aaa';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  // Arcs
  const zeroAngle = startAngle + dbToArcPosition(0) * arcRange;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, startAngle, zeroAngle, false);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, zeroAngle, endAngle, false);
  ctx.strokeStyle = '#c02316';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Percentage scale
  const pctTicks = [
    { pct: 0, label: '0' }, { pct: 20, label: '20' }, { pct: 40, label: '40' },
    { pct: 60, label: '60' }, { pct: 80, label: '80' }, { pct: 100, label: '100' }
  ];
  ctx.font = `${Math.max(7, Math.min(9, w * 0.025))}px sans-serif`;
  ctx.fillStyle = '#999';
  for (const tick of pctTicks) {
    const db = -20 + (tick.pct / 100) * 20;
    const t = dbToArcPosition(db);
    const angle = startAngle + t * arcRange;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * radius * 1.01, cy + Math.sin(angle) * radius * 1.01);
    ctx.lineTo(cx + Math.cos(angle) * radius * 1.03, cy + Math.sin(angle) * radius * 1.03);
    ctx.strokeStyle = '#bbb';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    ctx.fillText(tick.label, cx + Math.cos(angle) * radius * 1.06, cy + Math.sin(angle) * radius * 1.06);
  }

  // Needle
  const db = -20 + level * 23;
  const needleAngle = startAngle + dbToArcPosition(db) * arcRange;
  ctx.beginPath();
  ctx.moveTo(cx + 1, cy + 1);
  ctx.lineTo(cx + Math.cos(needleAngle) * radius * 0.97 + 1, cy + Math.sin(needleAngle) * radius * 0.97 + 1);
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(needleAngle) * radius * 0.97, cy + Math.sin(needleAngle) * radius * 0.97);
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.restore();

  // Screw
  ctx.beginPath();
  ctx.arc(ox + w - 14, oy + 14, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#c0b8a0';
  ctx.fill();
  ctx.strokeStyle = '#a09880';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ox + w - 17, oy + 14);
  ctx.lineTo(ox + w - 11, oy + 14);
  ctx.strokeStyle = '#998e78';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ===== C: Flat Bars =====
function drawFlatBars(canvas, ctx, isDark) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = isDark ? '#111827' : '#f0f0f0';
  ctx.fillRect(0, 0, w, h);

  const { l, r } = getLevelsFromData();
  const padL = 30;
  const padR = 65;
  const barW = w - padL - padR;
  const barH = Math.min(30, h * 0.22);
  const barY1 = h * 0.18;
  const barY2 = h * 0.52;

  drawFlatBarSingle(ctx, padL, barY1, barW, barH, l, 'L', isDark);
  drawFlatBarSingle(ctx, padL, barY2, barW, barH, r, 'R', isDark);

  // dB scale
  ctx.textAlign = 'center';
  ctx.font = `${Math.max(8, h * 0.07)}px monospace`;
  ctx.fillStyle = '#666';
  const dbMarks = [-20, -15, -10, -7, -5, -3, -1, 0, 1, 2, 3];
  for (const db of dbMarks) {
    const t = (db + 20) / 23;
    const x = padL + t * barW;
    ctx.fillText(db.toString(), x, h * 0.88);
    ctx.beginPath();
    ctx.moveTo(x, h * 0.80);
    ctx.lineTo(x, h * 0.84);
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawFlatBarSingle(ctx, x, y, w, h, level, label, isDark) {
  ctx.fillStyle = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 4);
  ctx.fill();

  const segments = 46;
  const segW = (w - (segments - 1) * 2) / segments;
  const litSegments = Math.round(level * segments);

  for (let i = 0; i < segments; i++) {
    const sx = x + i * (segW + 2);
    const isLit = i < litSegments;
    const t = i / segments;
    let color;
    if (t < 0.6) color = isLit ? '#22c55e' : 'rgba(34,197,94,0.12)';
    else if (t < 0.87) color = isLit ? '#eab308' : 'rgba(234,179,8,0.12)';
    else color = isLit ? '#ef4444' : 'rgba(239,68,68,0.12)';

    ctx.fillStyle = color;
    if (isLit) { ctx.shadowColor = color; ctx.shadowBlur = 4; }
    else { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; }
    ctx.fillRect(sx, y, segW, h);
  }
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  ctx.textAlign = 'right';
  ctx.font = 'bold 14px monospace';
  ctx.fillStyle = '#888';
  ctx.fillText(label, x - 8, y + h / 2 + 5);

  const db = Math.round(-20 + level * 23);
  ctx.textAlign = 'left';
  ctx.font = '12px monospace';
  ctx.fillStyle = level > 0.87 ? '#ef4444' : '#888';
  ctx.fillText(`${db}dB`, x + w + 8, y + h / 2 + 4);
}

// ===== D: Rainbow Equalizer =====
function drawRainbowEq(canvas, ctx, isDark) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = isDark ? '#000' : '#f8f8f8';
  ctx.fillRect(0, 0, w, h);

  const bars = Math.min(bufferLength, 32);
  const midY = h * 0.6;
  const blockGap = 2;
  const barGap = 3;
  const barWidth = (w - barGap * (bars + 1)) / bars;
  const maxBlocks = 14;
  const blockH = (midY - maxBlocks * blockGap) / maxBlocks;

  for (let i = 0; i < bars; i++) {
    const value = dataArray[i] / 255;
    const litBlocks = Math.round(value * maxBlocks);
    const x = barGap + i * (barWidth + barGap);
    const hue = (i / bars) * 300;

    for (let j = 0; j < maxBlocks; j++) {
      const isLit = j < litBlocks;
      const y = midY - (j + 1) * (blockH + blockGap);

      if (isLit) {
        ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
        ctx.shadowBlur = 8;
        ctx.fillStyle = `hsl(${hue}, 90%, ${55 + j * 2}%)`;
      } else {
        ctx.shadowBlur = 0;
        ctx.fillStyle = isDark ? `hsla(${hue}, 40%, 15%, 0.4)` : `hsla(${hue}, 30%, 85%, 0.5)`;
      }
      ctx.fillRect(x, y, barWidth, blockH);

      if (isLit) {
        const ry = midY + j * (blockH + blockGap) + blockGap;
        const fade = 0.35 - (j / maxBlocks) * 0.3;
        ctx.shadowBlur = 0;
        ctx.fillStyle = `hsla(${hue}, 80%, 50%, ${fade})`;
        ctx.fillRect(x, ry, barWidth, blockH);
      }
    }
  }
  ctx.shadowBlur = 0;

  const reflBg = isDark ? '0,0,0' : '248,248,248';
  const reflGrad = ctx.createLinearGradient(0, midY, 0, h);
  reflGrad.addColorStop(0, `rgba(${reflBg},0)`);
  reflGrad.addColorStop(1, `rgba(${reflBg},0.85)`);
  ctx.fillStyle = reflGrad;
  ctx.fillRect(0, midY, w, h - midY);
}

// ===== E: Neon Waves =====
function drawNeonWaves(canvas, ctx, isDark) {
  const w = canvas.width;
  const h = canvas.height;
  const midY = h * 0.45;
  ctx.fillStyle = isDark ? '#050515' : '#f5f5ff';
  ctx.fillRect(0, 0, w, h);

  waveTime += 0.02;

  for (let layer = 0; layer < WAVE_LAYERS; layer++) {
    const c = waveColors[layer];
    const baseAlpha = 0.6 + layer * 0.1;
    const phaseOffset = layer * 1.3;
    const freqMult = 1 + layer * 0.3;
    const ampScale = 0.7 + layer * 0.1;

    const points = [];
    const segments = 100;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const x = t * w;
      const dataIdx = Math.floor(t * Math.min(bufferLength, 64));
      const freqValue = (dataArray[dataIdx] || 0) / 255;
      const wave = Math.sin(t * Math.PI * 3 * freqMult + waveTime + phaseOffset) * freqValue * ampScale;
      const wave2 = Math.sin(t * Math.PI * 5 + waveTime * 1.3 + phaseOffset) * freqValue * 0.3;
      points.push({ x, y: midY + (wave + wave2) * midY * 0.7 });
    }

    for (let glow = 3; glow >= 0; glow--) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length - 1; i++) {
        const cpx = (points[i].x + points[i + 1].x) / 2;
        const cpy = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, cpx, cpy);
      }
      const alpha = glow === 0 ? baseAlpha : baseAlpha * 0.15 / (glow * 0.5);
      ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${alpha})`;
      ctx.lineWidth = glow === 0 ? 2 : glow * 6 + 2;
      ctx.shadowColor = glow === 0 ? `rgba(${c.r},${c.g},${c.b},0.5)` : 'transparent';
      ctx.shadowBlur = glow === 0 ? 10 : 0;
      ctx.stroke();
    }

    // Reflection
    ctx.beginPath();
    ctx.moveTo(points[0].x, midY + (midY - points[0].y));
    for (let i = 1; i < points.length - 1; i++) {
      const ry = midY + (midY - points[i].y);
      const rny = midY + (midY - points[i + 1].y);
      ctx.quadraticCurveTo(points[i].x, ry, (points[i].x + points[i + 1].x) / 2, (ry + rny) / 2);
    }
    ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${baseAlpha * 0.15})`;
    ctx.lineWidth = 1.5;
    ctx.shadowBlur = 0;
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  const neonBg = isDark ? '5,5,21' : '245,245,255';
  const neonGrad = ctx.createLinearGradient(0, midY, 0, h);
  neonGrad.addColorStop(0, `rgba(${neonBg},0)`);
  neonGrad.addColorStop(0.6, `rgba(${neonBg},0.7)`);
  neonGrad.addColorStop(1, `rgba(${neonBg},0.95)`);
  ctx.fillStyle = neonGrad;
  ctx.fillRect(0, midY, w, h - midY);
}

// ===== F: 3D Spectrum =====
function drawSpectrum3D(canvas, ctx, isDark) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = isDark ? '#000' : '#f0f0f0';
  ctx.fillRect(0, 0, w, h);

  const bars = Math.min(bufferLength, 32);
  spectrumFrame++;
  if (spectrumFrame % 3 === 0) {
    const frame = new Uint8Array(bars);
    for (let i = 0; i < bars; i++) frame[i] = dataArray[i];
    spectrumHistory.unshift(frame);
    if (spectrumHistory.length > HISTORY_DEPTH) spectrumHistory.pop();
  }

  const baseX = w * 0.08;
  const baseY = h * 0.88;
  const barW = (w * 0.65) / bars;
  const barGap = 1;
  const zStepX = 8;
  const zStepY = -8;
  const maxBarH = h * 0.5;

  for (let z = spectrumHistory.length - 1; z >= 0; z--) {
    const frame = spectrumHistory[z];
    const fade = 0.25 + ((spectrumHistory.length - 1 - z) / HISTORY_DEPTH) * 0.75;
    const rowX = baseX + z * zStepX;
    const rowY = baseY + z * zStepY;

    for (let i = 0; i < bars; i++) {
      const value = frame[i] / 255;
      const barH = value * maxBarH;
      if (barH < 1) continue;

      const x = rowX + i * (barW + barGap);
      const topY = rowY - barH;
      const hue = (i / bars) * 300;
      const sat = 80;
      const lit = 40 + value * 25;

      ctx.fillStyle = `hsla(${hue}, ${sat}%, ${lit}%, ${fade})`;
      ctx.fillRect(x, topY, barW, barH);

      ctx.fillStyle = `hsla(${hue}, ${sat}%, ${lit + 15}%, ${fade * 0.7})`;
      ctx.beginPath();
      ctx.moveTo(x, topY);
      ctx.lineTo(x + zStepX, topY + zStepY);
      ctx.lineTo(x + barW + zStepX, topY + zStepY);
      ctx.lineTo(x + barW, topY);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = `hsla(${hue}, ${sat}%, ${lit - 12}%, ${fade * 0.5})`;
      ctx.beginPath();
      ctx.moveTo(x + barW, topY);
      ctx.lineTo(x + barW + zStepX, topY + zStepY);
      ctx.lineTo(x + barW + zStepX, rowY + zStepY);
      ctx.lineTo(x + barW, rowY);
      ctx.closePath();
      ctx.fill();
    }
  }

  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= bars; i += 4) {
    const x = baseX + i * (barW + barGap);
    ctx.beginPath();
    ctx.moveTo(x, baseY);
    ctx.lineTo(x + HISTORY_DEPTH * zStepX, baseY + HISTORY_DEPTH * zStepY);
    ctx.stroke();
  }
  for (let z = 0; z <= HISTORY_DEPTH; z += 4) {
    ctx.beginPath();
    ctx.moveTo(baseX + z * zStepX, baseY + z * zStepY);
    ctx.lineTo(baseX + bars * (barW + barGap) + z * zStepX, baseY + z * zStepY);
    ctx.stroke();
  }
}

// ===== Classic: Simple Bars =====
function drawBars(canvas, ctx, isDark) {
  ctx.fillStyle = isDark ? '#1f2937' : '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const barWidth = (canvas.width / bufferLength) * 2.5;
  let x = 0;
  for (let i = 0; i < bufferLength; i++) {
    const barHeight = (dataArray[i] / 255) * canvas.height;
    ctx.fillStyle = '#667eea';
    ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
    x += barWidth + 1;
  }
}

// ===== Classic: Mirror =====
function drawMirror(canvas, ctx, isDark) {
  ctx.fillStyle = isDark ? '#1f2937' : '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const w = canvas.width;
  const h = canvas.height;
  const centerY = h / 2;
  const bars = Math.min(bufferLength, 64);
  const barWidth = Math.max(2, (w / bars) - 1);

  for (let i = 0; i < bars; i++) {
    const value = dataArray[i] / 255;
    const barHeight = value * centerY * 0.9;
    const x = (i / bars) * w;
    const hue = 240 + (i / bars) * 60;
    const lightness = 55 + value * 20;
    ctx.fillStyle = `hsl(${hue}, 70%, ${lightness}%)`;
    ctx.fillRect(x, centerY - barHeight, barWidth, barHeight);
    ctx.fillRect(x, centerY, barWidth, barHeight);
  }

  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(w, centerY);
  ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ===== Classic: LED Bars =====
function drawLedBars(canvas, ctx, isDark) {
  ctx.fillStyle = isDark ? 'rgb(24,24,24)' : 'rgb(240,240,240)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const w = canvas.width;
  const h = canvas.height;
  const bars = Math.min(bufferLength, 32);
  const boxCount = 12;
  const gapFraction = 0.3;
  const barGap = w * 0.008;
  const barWidth = (w - barGap * (bars + 1)) / bars;
  const totalBoxGaps = (boxCount + 1) * gapFraction;
  const boxHeight = h / (boxCount + totalBoxGaps);
  const boxGap = boxHeight * gapFraction;
  const greenMax = Math.floor(boxCount * 0.6);
  const yellowMax = Math.floor(boxCount * 0.8);

  for (let i = 0; i < bars; i++) {
    const value = dataArray[i] / 255;
    const litBoxes = Math.round(value * boxCount);
    const x = barGap + i * (barWidth + barGap);

    for (let j = 0; j < boxCount; j++) {
      const boxIndex = boxCount - 1 - j;
      const y = boxGap + j * (boxHeight + boxGap);
      const isLit = boxIndex < litBoxes;

      let onColor, offColor;
      if (boxIndex >= yellowMax) {
        onColor = 'rgba(255,47,30,0.9)';
        offColor = isDark ? 'rgba(80,15,10,0.3)' : 'rgba(80,15,10,0.15)';
      } else if (boxIndex >= greenMax) {
        onColor = 'rgba(255,215,5,0.9)';
        offColor = isDark ? 'rgba(80,68,2,0.3)' : 'rgba(80,68,2,0.15)';
      } else {
        onColor = 'rgba(53,255,30,0.9)';
        offColor = isDark ? 'rgba(17,80,10,0.3)' : 'rgba(17,80,10,0.15)';
      }

      if (isLit) { ctx.shadowColor = onColor; ctx.shadowBlur = 6; }
      else { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; }
      ctx.fillStyle = isLit ? onColor : offColor;
      ctx.fillRect(x, y, barWidth, boxHeight);
    }
  }
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
}

function simulatedVisualize(canvas, canvasCtx) {
  // Enhanced simulated visualization for Spotify SDK playback
  const bars = 128;
  const barValues = new Array(bars).fill(0);
  const targetValues = new Array(bars).fill(0);
  // Ensure dataArray exists for draw functions
  bufferLength = bars;
  dataArray = new Uint8Array(bars);


  const baseBPM = 120 + Math.random() * 40;
  const beatInterval = (60 / baseBPM) * 1000;

  let startTime = Date.now();
  let lastBeatTime = startTime;
  let beatPhase = 0;
  let energy = 0.5;
  let targetEnergy = 0.5;

  async function getPlaybackState() {
    if (!spotifyPlayer) return null;
    try {
      return await spotifyPlayer.getCurrentState();
    } catch (e) {
      return null;
    }
  }

  function draw() {
    if (!animationRunning) return;

    animationId = requestAnimationFrame(draw);
    resizeCanvas(canvas);

    const now = Date.now();
    const elapsed = now - startTime;

    if (now - lastBeatTime >= beatInterval) {
      lastBeatTime = now;
      beatPhase = 1.0;
      if (Math.random() > 0.7) {
        targetEnergy = 0.3 + Math.random() * 0.6;
      }
    }

    beatPhase *= 0.85;
    energy += (targetEnergy - energy) * 0.05;

    if (Math.random() < 0.02) {
      getPlaybackState().then(state => {
        if (state && state.position && state.duration) {
          const progress = state.position / state.duration;
          targetEnergy = 0.3 + progress * 0.4 + Math.random() * 0.3;
        }
      });
    }

    // Generate simulated frequency data into dataArray
    for (let i = 0; i < bars; i++) {
      const freqFactor = 1 - (i / bars) * 0.5;
      const wave1 = Math.sin(elapsed / 300 + i * 0.15) * 0.15;
      const wave2 = Math.sin(elapsed / 150 + i * 0.08) * 0.1;
      const wave3 = Math.sin(elapsed / 500 + i * 0.25) * 0.08;
      const beatPulse = beatPhase * freqFactor * 0.4;
      const randomVariation = Math.random() * 0.1;

      targetValues[i] = (wave1 + wave2 + wave3 + beatPulse + randomVariation + 0.2) * energy * freqFactor;
      targetValues[i] = Math.max(0.05, Math.min(1, targetValues[i]));
      barValues[i] += (targetValues[i] - barValues[i]) * 0.15;

      dataArray[i] = Math.round(barValues[i] * 255);
    }

    const isDark = visualizerStyle.endsWith('-dark');
    dispatchDraw(canvas, canvasCtx, isDark);
  }

  draw();
}

function stopVisualization() {
  animationRunning = false;
  if (animationId) {
    cancelAnimationFrame(animationId);
  }

  // Clear canvas with background matching theme
  const canvas = document.getElementById('audioVisualizer');
  if (canvas) {
    const canvasCtx = canvas.getContext('2d');
    const isDarkMode = document.documentElement.classList.contains('dark');
    canvasCtx.fillStyle = isDarkMode ? '#1f2937' : '#ffffff';
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

async function setupMicVisualization() {
  const canvas = document.getElementById('audioVisualizer');
  if (!canvas) return false;

  // Reuse existing mic stream if already active
  if (micStream && micAnalyser) {
    const canvasCtx = canvas.getContext('2d');
    analyser = micAnalyser;
    bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    visualize(canvas, canvasCtx);
    return true;
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    micSource = audioContext.createMediaStreamSource(micStream);

    // Boost mic signal so the visualizer reacts to ambient audio
    micGainNode = audioContext.createGain();
    micGainNode.gain.value = micGainValue;

    micAnalyser = audioContext.createAnalyser();
    micAnalyser.fftSize = 256;
    micAnalyser.minDecibels = -80;
    micAnalyser.maxDecibels = -20;
    micAnalyser.smoothingTimeConstant = 0.8;

    micSource.connect(micGainNode);
    micGainNode.connect(micAnalyser);
    // Do NOT connect to destination — that would cause feedback

    analyser = micAnalyser;
    bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);

    const canvasCtx = canvas.getContext('2d');
    visualize(canvas, canvasCtx);
    return true;
  } catch (err) {
    console.error('Mic access denied or failed:', err);
    showNotification('Microphone access denied — using simulated visualizer', 'error');
    micVisualizerEnabled = false;
    return false;
  }
}

function stopMicVisualization() {
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }
  if (micSource) {
    micSource.disconnect();
    micSource = null;
  }
  if (micGainNode) {
    micGainNode.disconnect();
    micGainNode = null;
  }
  micAnalyser = null;
}

// Mic level monitor for settings modal
let micLevelAnimId = null;

function startMicLevelMonitor() {
  stopMicLevelMonitor();
  const bar = document.getElementById('micLevelBar');
  const status = document.getElementById('micLevelStatus');
  if (!bar || !status) return;

  function update() {
    micLevelAnimId = requestAnimationFrame(update);

    if (!micAnalyser) {
      bar.style.width = '0%';
      status.textContent = 'Off';
      status.className = 'text-xs text-gray-400';
      return;
    }

    const tempData = new Uint8Array(micAnalyser.frequencyBinCount);
    micAnalyser.getByteFrequencyData(tempData);

    const useBins = Math.max(8, Math.floor(tempData.length * 0.5));
    let sumSq = 0;
    for (let i = 0; i < useBins; i++) {
      const v = tempData[i] / 255;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / useBins);
    const pct = Math.min(100, Math.round(rms * 120));

    bar.style.width = pct + '%';
    if (pct > 60) {
      bar.className = 'h-full bg-red-500 rounded-full transition-all duration-75';
      status.textContent = 'High';
      status.className = 'text-xs text-red-500';
    } else if (pct > 20) {
      bar.className = 'h-full bg-green-500 rounded-full transition-all duration-75';
      status.textContent = 'OK';
      status.className = 'text-xs text-green-500';
    } else if (pct > 2) {
      bar.className = 'h-full bg-yellow-500 rounded-full transition-all duration-75';
      status.textContent = 'Low';
      status.className = 'text-xs text-yellow-500';
    } else {
      bar.className = 'h-full bg-gray-400 rounded-full transition-all duration-75';
      status.textContent = 'No signal';
      status.className = 'text-xs text-gray-400';
    }
  }

  update();
}

function stopMicLevelMonitor() {
  if (micLevelAnimId) {
    cancelAnimationFrame(micLevelAnimId);
    micLevelAnimId = null;
  }
}

// Question Timer Functions
function startQuestionTimer() {
  stopQuestionTimer(); // Clear any existing timer

  const timerProgress = document.getElementById('timerProgress');
  const timeRemaining = document.getElementById('timeRemaining');

  if (!timerProgress || !timeRemaining) return;

  questionStartTime = Date.now();
  timerProgress.style.width = '100%';
  timerProgress.classList.remove('bg-red-500');
  timerProgress.classList.add('bg-gradient-to-r', 'from-green-500', 'to-emerald-600');

  questionTimer = setInterval(() => {
    const elapsed = (Date.now() - questionStartTime) / 1000;
    const remaining = Math.max(0, QUESTION_TIME_LIMIT - elapsed);
    const percentage = (remaining / QUESTION_TIME_LIMIT) * 100;

    timeRemaining.textContent = `${Math.ceil(remaining)}s`;
    timerProgress.style.width = `${percentage}%`;

    // Change color when time is running out
    if (remaining <= 3 && remaining > 0) {
      timerProgress.classList.remove('bg-gradient-to-r', 'from-green-500', 'to-emerald-600');
      timerProgress.classList.add('bg-red-500');
    }

    if (remaining <= 0) {
      stopQuestionTimer();
      // Notify server that host timer expired
      if (currentPin) {
        socket.emit('host_timer_expired', { pin: currentPin });
      }
    }
  }, 100);
}

function stopQuestionTimer() {
  if (questionTimer) {
    clearInterval(questionTimer);
    questionTimer = null;
  }

  // Clear the timer bar to show it empty
  const timerProgress = document.getElementById('timerProgress');
  const timeRemaining = document.getElementById('timeRemaining');

  if (timerProgress) {
    timerProgress.style.width = '0%';
  }

  if (timeRemaining) {
    timeRemaining.textContent = '0s';
  }
}

// Error Modal Functions
function showErrorModal(title, message) {
  const modal = document.getElementById('errorModal');
  const modalTitle = document.getElementById('errorModalTitle');
  const modalMessage = document.getElementById('errorModalMessage');

  if (modal && modalTitle && modalMessage) {
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modal.classList.remove('hidden');

    // Prevent body scroll when modal is open
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    document.body.style.paddingRight = scrollbarWidth + 'px';
  }
}

function closeErrorModal() {
  const modal = document.getElementById('errorModal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  }
}

// Playlist selection modal
function openPlaylistModal(playlist) {
  const modal = document.getElementById('playlistModal');
  const modalImage = document.getElementById('playlistModalImage');
  const modalName = document.getElementById('playlistModalName');
  const modalInfo = document.getElementById('playlistModalInfo');
  const modalOwner = document.getElementById('playlistModalOwner');

  if (playlist.image) {
    modalImage.src = playlist.image;
    modalImage.style.display = 'block';
  } else {
    modalImage.style.display = 'none';
  }
  modalName.textContent = playlist.name;
  modalInfo.textContent = `${playlist.tracks} tracks`;
  modalOwner.textContent = `by ${playlist.owner}`;

  selectedPlaylistId = playlist.id;

  modal.classList.remove('hidden');
  const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
  document.body.style.overflow = 'hidden';
  document.body.style.paddingRight = scrollbarWidth + 'px';
}

function closePlaylistModal() {
  const modal = document.getElementById('playlistModal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  }
}

// Playlist modal event listeners
document.getElementById('closePlaylistModal')?.addEventListener('click', closePlaylistModal);

document.getElementById('playlistModal')?.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-backdrop')) {
    closePlaylistModal();
  }
});

document.getElementById('playlistModalCreateBtn')?.addEventListener('click', () => {
  if (!selectedPlaylistId) return;
  closePlaylistModal();
  socket.emit('create_room', { playlist_id: selectedPlaylistId });
});

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeErrorModal();
    closeSettingsModal();
    closePlaylistModal();
  }
});


// ===== Leaderboard Management =====

async function clearLeaderboard() {
  if (!confirm('Are you sure you want to clear the entire leaderboard? This cannot be undone.')) return;

  try {
    const res = await fetch('/api/leaderboard', { method: 'DELETE' });
    if (res.ok) {
      showNotification('Leaderboard cleared', 'success');
      closeSettingsModal();
    } else {
      showNotification('Failed to clear leaderboard', 'error');
    }
  } catch (err) {
    showNotification('Failed to clear leaderboard', 'error');
  }
}

// ===== Profile and Settings Management =====
let userProfile = null;
let userSettings = null;

// Load user profile on page load
document.addEventListener('DOMContentLoaded', () => {
  loadUserProfile();
  loadUserSettings();
});

async function loadUserProfile() {
  // Use cached profile immediately if available
  const cached = localStorage.getItem('cachedUserProfile');
  if (cached) {
    try {
      userProfile = JSON.parse(cached);
      await updateProfileUI(userProfile);
    } catch (e) {}
  }

  // Fetch fresh profile in background
  try {
    const response = await fetch('/api/user/profile');
    if (response.ok) {
      userProfile = await response.json();
      localStorage.setItem('cachedUserProfile', JSON.stringify(userProfile));
      await updateProfileUI(userProfile);
    } else {
      console.log('User not authenticated');
    }
  } catch (error) {
    console.error('Failed to load profile:', error);
  }
}

async function updateProfileUI(profile) {
  // Update avatar images
  const displayName = profile.display_name || 'User';
  const userAvatar = document.getElementById('userAvatar');
  const menuAvatar = document.getElementById('menuAvatar');

  const avatarUrl = profile.profile_image || getAvatarUrlByName(displayName);
  localStorage.setItem('cachedAvatarUrl', avatarUrl);

  if (userAvatar) userAvatar.src = avatarUrl;
  if (menuAvatar) menuAvatar.src = avatarUrl;

  // Show profile button
  const userProfileEl = document.getElementById('userProfile');
  if (userProfileEl) { userProfileEl.classList.remove('hidden'); userProfileEl.classList.add('block'); }

  // Update display name
  const menuUserName = document.getElementById('menuUserName');
  if (menuUserName) menuUserName.textContent = displayName;

  // Update email
  if (profile.email) {
    const menuUserEmail = document.getElementById('menuUserEmail');
    if (menuUserEmail) menuUserEmail.textContent = profile.email;
  }

  // Update plan badge
  const planBadge = document.getElementById('userPlan');
  if (planBadge && profile.product) {
    if (profile.product === 'premium') {
      planBadge.textContent = '⭐ Premium';
      planBadge.className = 'px-2 py-1 bg-yellow-100 text-yellow-700 rounded';
    } else {
      planBadge.textContent = 'Free';
      planBadge.className = 'px-2 py-1 bg-gray-100 text-gray-700 rounded';
    }
  }
}

// Toggle profile menu
document.addEventListener('click', (e) => {
  const userMenuButton = document.getElementById('userMenuButton');
  const userMenu = document.getElementById('userMenu');

  if (!userMenuButton || !userMenu) return;

  // Check if click is on the button
  if (userMenuButton.contains(e.target)) {
    userMenu.classList.toggle('hidden');
  } else if (!userMenu.contains(e.target)) {
    // Click outside - close menu
    userMenu.classList.add('hidden');
  }
});

// Settings modal functions
function openSettingsModal() {
  const modal = document.getElementById('settingsModal');
  if (modal) {
    modal.classList.remove('hidden');
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    document.body.style.paddingRight = scrollbarWidth + 'px';

    // Close profile menu
    const userMenu = document.getElementById('userMenu');
    if (userMenu) userMenu.classList.add('hidden');

    // Load current settings into form
    const gameLength = document.getElementById('settingGameLength');
    const soundEffects = document.getElementById('settingSoundEffects');
    const notifications = document.getElementById('settingNotifications');
    const theme = document.getElementById('settingTheme');

    const autoFullscreen = document.getElementById('settingAutoFullscreen');
    const vibration = document.getElementById('settingVibration');
    const vizStyle = document.getElementById('settingVisualizerStyle');
    const micVisualizer = document.getElementById('settingMicVisualizer');
    const micSensitivity = document.getElementById('settingMicSensitivity');
    const micSensitivityValue = document.getElementById('micSensitivityValue');
    const micSensitivitySetting = document.getElementById('micSensitivitySetting');

    // Hide mic visualizer option if getUserMedia is not available
    const micSetting = document.getElementById('micVisualizerSetting');
    if (micSetting && !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      micSetting.classList.add('hidden');
    }

    // Show/hide sensitivity slider based on toggle
    if (micVisualizer) {
      micVisualizer.addEventListener('change', () => {
        if (micSensitivitySetting) {
          micSensitivitySetting.classList.toggle('hidden', !micVisualizer.checked);
        }
      });
    }
    if (micSensitivity && micSensitivityValue) {
      micSensitivity.addEventListener('input', () => {
        micSensitivityValue.textContent = micSensitivity.value;
        // Update gain in real-time as you drag
        micGainValue = parseFloat(micSensitivity.value);
        if (micGainNode) {
          micGainNode.gain.value = micGainValue;
        }
      });
    }

    if (userSettings) {
      if (gameLength) gameLength.value = userSettings.default_game_length || 10;
      if (soundEffects) soundEffects.checked = userSettings.sound_effects !== false;
      if (notifications) notifications.checked = userSettings.notifications !== false;
      if (theme) theme.value = userSettings.theme || localStorage.getItem('theme') || 'light';
      if (vibration) vibration.checked = userSettings.vibration_enabled !== false;
      if (autoFullscreen) autoFullscreen.checked = userSettings.auto_fullscreen === true;
      if (vizStyle) vizStyle.value = userSettings.visualizer_style || 'bars-light';
      if (micVisualizer) micVisualizer.checked = userSettings.mic_visualizer === true;
      if (micSensitivity) micSensitivity.value = userSettings.mic_sensitivity || 4;
      if (micSensitivityValue) micSensitivityValue.textContent = userSettings.mic_sensitivity || 4;
    } else {
      // Load from localStorage if no server settings
      if (theme) theme.value = localStorage.getItem('theme') || 'light';
      if (vibration) vibration.checked = true;
      if (autoFullscreen) autoFullscreen.checked = false;
      if (vizStyle) vizStyle.value = 'bars-light';
      if (micVisualizer) micVisualizer.checked = false;
      if (micSensitivity) micSensitivity.value = 4;
    }

    // Sync sensitivity slider visibility
    if (micSensitivitySetting && micVisualizer) {
      micSensitivitySetting.classList.toggle('hidden', !micVisualizer.checked);
    }

    // Start mic level monitor if mic is active
    if (micAnalyser) {
      startMicLevelMonitor();
    }
  }
}

function closeSettingsModal() {
  stopMicLevelMonitor();
  const modal = document.getElementById('settingsModal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  }
}

async function loadUserSettings() {
  try {
    const response = await fetch('/api/user/settings');
    if (response.ok) {
      userSettings = await response.json();
      applySettings(userSettings);
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

async function saveSettings() {
  const gameLength = document.getElementById('settingGameLength');
  const soundEffects = document.getElementById('settingSoundEffects');
  const notifications = document.getElementById('settingNotifications');
  const theme = document.getElementById('settingTheme');

  const autoFullscreen = document.getElementById('settingAutoFullscreen');
  const vibration = document.getElementById('settingVibration');
  const vizStyle = document.getElementById('settingVisualizerStyle');
  const micVisualizer = document.getElementById('settingMicVisualizer');
  const micSensitivity = document.getElementById('settingMicSensitivity');

  const settings = {
    default_game_length: gameLength ? parseInt(gameLength.value) : 10,
    sound_effects: soundEffects ? soundEffects.checked : true,
    notifications: notifications ? notifications.checked : true,
    theme: theme ? theme.value : 'light',
    vibration_enabled: vibration ? vibration.checked : true,
    auto_fullscreen: autoFullscreen ? autoFullscreen.checked : false,
    visualizer_style: vizStyle ? vizStyle.value : 'vintage-dark',
    mic_visualizer: micVisualizer ? micVisualizer.checked : false,
    mic_sensitivity: micSensitivity ? parseFloat(micSensitivity.value) : 4,
  };

  // Always apply settings immediately (don't wait for server)
  applySettings(settings);
  userSettings = settings;

  try {
    const response = await fetch('/api/user/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });

    if (response.ok) {
      closeSettingsModal();
      showNotification('Settings saved successfully!', 'success');
    } else {
      // Settings still applied locally even if server save fails
      closeSettingsModal();
      showNotification('Settings saved locally', 'info');
    }
  } catch (error) {
    console.error('Failed to save settings to server:', error);
    // Settings still applied locally
    closeSettingsModal();
    showNotification('Settings saved locally', 'info');
  }
}

function applySettings(settings) {
  // Apply theme
  const theme = settings.theme || 'light';

  if (theme === 'dark') {
    document.documentElement.classList.add('dark');
    localStorage.setItem('theme', 'dark');
  } else if (theme === 'light') {
    document.documentElement.classList.remove('dark');
    localStorage.setItem('theme', 'light');
  } else if (theme === 'auto') {
    // Auto mode: follow system preference
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', 'auto');
  }

  // Visualizer style
  visualizerStyle = settings.visualizer_style || 'bars-light';

  // Mic visualizer
  const wasMicEnabled = micVisualizerEnabled;
  micVisualizerEnabled = settings.mic_visualizer === true;
  micGainValue = settings.mic_sensitivity || 4;
  if (micGainNode) {
    micGainNode.gain.value = micGainValue;
  }
  if (wasMicEnabled && !micVisualizerEnabled) {
    stopMicVisualization();
  }
}

// Connection resilience handlers
socket.on('disconnect', (reason) => {
  console.log('Disconnected:', reason);
  isReconnecting = true;
  reconnectAttempts = 0; // Reset on disconnect

  if (reason === 'io server disconnect') {
    // Server forcibly disconnected, try to reconnect
    socket.connect();
  }

  // Show reconnection UI
  showReconnectingOverlay(reconnectAttempts, MAX_RECONNECT_ATTEMPTS);
});

socket.on('connect', () => {
  console.log('WebSocket connected');

  if (isReconnecting && currentPin) {
    console.log('Attempting to rejoin room as host:', currentPin);

    // Attempt to rejoin room as host
    socket.emit('rejoin_room', {
      pin: currentPin,
      was_host: true
    });
  } else if (!isReconnecting) {
    // Initial connection, not a reconnect
    reconnectAttempts = 0;
  }

  isReconnecting = false;
});

socket.on('connect_error', (error) => {
  console.error('Connection error:', error);
  reconnectAttempts++;

  // Update the overlay with current attempt count
  updateReconnectingOverlay(reconnectAttempts, MAX_RECONNECT_ATTEMPTS);

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    hideReconnectingOverlay();
    showConnectionFailedError();
  }
});

socket.on('rejoin_success', (data) => {
  console.log('Successfully rejoined room as host', data);
  hideReconnectingOverlay();

  // Close standings modal if it was open
  if (standingsModal && !standingsModal.classList.contains('hidden')) {
    standingsModal.classList.add('hidden');
    console.log('Closed standings modal after reconnection');
  }

  // Sync state if game is in progress
  if (data.state === 'playing' && data.current_question) {
    // Update UI with current game state
    currentQuestion = data.current_question;
    songNumber.textContent = data.question_number;
    totalSongs.textContent = data.total_questions;

    // Show game screen if not already visible
    if (gameScreen.classList.contains('hidden')) {
      waitingScreen.classList.add('hidden');
      gameScreen.classList.remove('hidden');
    }

    // If backend indicates we should advance (everyone ready), do it automatically
    if (data.should_advance) {
      console.log('Auto-advancing to next question after reconnection');
      setTimeout(() => {
        socket.emit('next_question', { pin: currentPin });
      }, 1000);
    }
    // If voting is closed but we haven't advanced yet, show a prompt
    else if (data.voting_closed) {
      console.log('Voting closed, host can advance when ready');
      showNotification('Question finished. Ready to continue?', 'info');

      // Stop any audio/visualization
      if (spotifyPlayer && deviceId) {
        spotifyPlayer.pause();
      } else if (audioPlayer) {
        audioPlayer.pause();
      }
      stopVisualization();
      stopQuestionTimer();
    }
  }

  // Update participants list if provided
  if (data.participants) {
    updateParticipantsList(data.participants);
  }

  // Show brief success message
  showNotification('Reconnected successfully!', 'success');
});

socket.on('rejoin_failed', (data) => {
  console.error('Failed to rejoin room:', data.message);
  hideReconnectingOverlay();
  showConnectionFailedError(data.message);
});

