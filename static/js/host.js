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

// Initialize Spotify Web Playback SDK
window.onSpotifyWebPlaybackSDKReady = () => {
  console.log('Spotify Web Playback SDK ready');

  if (!spotifyAccessToken) {
    console.log('No access token available yet');
    return;
  }

  initializeSpotifyPlayer();
};

function initializeSpotifyPlayer() {
  if (!spotifyAccessToken) {
    console.log('Cannot initialize player without access token');
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
  if (!spotifyPlayer || !deviceId) {
    console.error('Spotify player not ready - Player:', !!spotifyPlayer, 'Device ID:', !!deviceId);
    showErrorModal('Playback Error', 'Spotify player is not ready. Please try refreshing the page.');
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
      showErrorModal(
        'Spotify Premium Required',
        'Full playback requires a Spotify Premium account. You may see limited functionality.'
      );
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

          // Remove pressed effect and selection from all cards
          document.querySelectorAll('.playlist-card').forEach(c => {
            c.classList.remove('selected');
            c.style.transform = '';
            c.style.boxShadow = '';
          });

          // Select this one and keep pressed effect
          card.classList.add('selected');
          card.style.transform = 'scale(0.92)';
          card.style.boxShadow = '0 1px 4px rgba(102, 126, 234, 0.6)';
          selectedPlaylistId = playlist.id;

          // Show selected playlist display
          const selectedDisplay = document.getElementById('selectedPlaylistDisplay');
          const selectedImage = document.getElementById('selectedPlaylistImage');
          const selectedName = document.getElementById('selectedPlaylistName');
          const selectedInfo = document.getElementById('selectedPlaylistInfo');

          selectedDisplay.classList.remove('hidden');
          selectedImage.src = playlist.image || '';
          selectedImage.style.display = playlist.image ? 'block' : 'none';
          selectedName.textContent = playlist.name;
          selectedInfo.textContent = `${playlist.tracks} tracks • by ${playlist.owner}`;

          // Scroll to top to show selection
          selectedDisplay.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

      // Clear selection button
      const clearBtn = document.getElementById('clearPlaylistBtn');
      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          document.querySelectorAll('.playlist-card').forEach(c => {
            c.classList.remove('selected');
            c.style.transform = '';
            c.style.boxShadow = '';
          });
          document.getElementById('selectedPlaylistDisplay').classList.add('hidden');
          selectedPlaylistId = null;
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

  socket.emit('start_game', { pin: currentPin, song_count: songCount, games_count: gamesCount });
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
    const percentage = (data.current / data.total) * 100;
    progressBarFill.style.width = percentage + '%';
    progressText.textContent = `Preparing track ${data.current} of ${data.total}`;
    if (progressTotalSongs) {
      progressTotalSongs.textContent = data.total;
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

  totalSongs.textContent = data.total_songs;

  // Track series info
  gamesInSeries = data.games_in_series || 1;
  currentGameNumber = data.current_game || 1;

  // Update header if multiple games
  if (gamesInSeries > 1) {
    const gameHeader = document.querySelector('#gameScreen .bg-white.rounded-2xl.shadow-lg.p-6.mb-6');
    if (gameHeader && !document.getElementById('seriesInfo')) {
      const seriesInfo = document.createElement('div');
      seriesInfo.id = 'seriesInfo';
      seriesInfo.className = 'text-center mb-2';
      seriesInfo.innerHTML = `<span class="text-sm font-semibold text-purple-600">Game ${currentGameNumber} of ${gamesInSeries}</span>`;
      gameHeader.insertBefore(seriesInfo, gameHeader.firstChild);
    } else if (document.getElementById('seriesInfo')) {
      document.getElementById('seriesInfo').innerHTML = `<span class="text-sm font-semibold text-purple-600">Game ${currentGameNumber} of ${gamesInSeries}</span>`;
    }
  }

  showScreen(gameScreen);
});

socket.on('new_question', (data) => {
  // Hide standings modal if showing
  if (standingsModal && !standingsModal.classList.contains('hidden')) {
    standingsModal.classList.add('hidden');

    // Reset countdown dots
    const dots = standingsModal.querySelectorAll('.countdown-dots .dot');
    dots.forEach(dot => dot.classList.remove('active'));
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
  displayVotedParticipant(data.player_name);
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

    // Animate countdown dots (visual feedback only, not timing)
    const dots = standingsModal.querySelectorAll('.countdown-dots .dot');
    dots.forEach((dot, index) => {
      setTimeout(() => {
        dot.classList.add('active');
      }, index * 1000); // Show one dot per second
    });
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
  if (spotifyPlayer && deviceId) {
    spotifyPlayer.pause();
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
  if (spotifyPlayer && deviceId) {
    spotifyPlayer.pause();
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

  // Random color palette for avatars
  const colors = ['667eea', '764ba2', 'f093fb', '4facfe', '43e97b', 'fa709a', 'fee140', 'ff6b6b', '4ecdc4', '45b7d1'];

  participants.forEach((p, index) => {
    const li = document.createElement('li');
    li.className = 'flex items-center gap-3 p-2 bg-gray-50 rounded-lg';

    // Use random color based on player index
    const color = colors[index % colors.length];
    const avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(p.name)}&backgroundColor=${color}&fontSize=40`;

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
      playSpotifyTrack(data.track_uri).then(success => {
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
    // Start enhanced simulated visualization with track data
    startVisualizerAnimation(data.track_name);
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

function displayVotedParticipant(playerName) {
  const votedParticipants = document.getElementById('votedParticipants');
  if (!votedParticipants) return;

  // Check if already displayed to avoid duplicates
  if (votedParticipants.querySelector(`[data-player="${playerName}"]`)) {
    return;
  }

  // Color palette matching the app's design theme (indigo/purple/pink spectrum)
  const colors = ['667eea', '764ba2', '8b5cf6', '9333ea', 'a855f7', 'c084fc', 'd8b4fe', 'e879f9', 'f0abfc', 'f9a8d4'];

  // Use a hash of the name to consistently assign the same color to the same player
  let hash = 0;
  for (let i = 0; i < playerName.length; i++) {
    hash = playerName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colorIndex = Math.abs(hash) % colors.length;
  const color = colors[colorIndex];
  const avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(playerName)}&backgroundColor=${color}&fontSize=40`;

  const avatarDiv = document.createElement('div');
  avatarDiv.className = 'flex flex-col items-center gap-1';
  avatarDiv.setAttribute('data-player', playerName);
  avatarDiv.innerHTML = `
    <img src="${avatarUrl}" alt="${playerName}" class="w-12 h-12 rounded-full shadow-md">
    <span class="text-sm text-gray-600 font-medium max-w-[70px] truncate">${playerName}</span>
  `;

  votedParticipants.appendChild(avatarDiv);
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

  // Random color palette for avatars
  const colors = ['667eea', '764ba2', 'f093fb', '4facfe', '43e97b', 'fa709a', 'fee140', 'ff6b6b', '4ecdc4', '45b7d1'];

  scores.forEach((player, index) => {
    const div = document.createElement('div');
    div.className = 'flex items-center justify-between p-4 bg-gray-50 rounded-lg';

    // Use random color based on player index
    const color = colors[index % colors.length];
    const avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(player.name)}&backgroundColor=${color}&fontSize=40`;

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

  const colors = ['667eea', '764ba2', 'f093fb', '4facfe', '43e97b', 'fa709a', 'fee140', 'ff6b6b', '4ecdc4', '45b7d1'];

  // Display game scores
  const gameScoresList = modal.querySelector('#gameScoresList');
  gameScores.forEach((player, index) => {
    const div = document.createElement('div');
    div.className = 'flex items-center justify-between p-3 bg-gray-50 rounded-lg';
    const color = colors[index % colors.length];
    const avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(player.name)}&backgroundColor=${color}&fontSize=40`;

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
    const color = colors[index % colors.length];
    const avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(player.name)}&backgroundColor=${color}&fontSize=40`;

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

  // Random color palette for avatars
  const colors = ['667eea', '764ba2', 'f093fb', '4facfe', '43e97b', 'fa709a', 'fee140', 'ff6b6b', '4ecdc4', '45b7d1'];

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

    // Use random color based on player index
    const color = colors[index % colors.length];
    const avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(player.name)}&backgroundColor=${color}&fontSize=40`;

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

function startVisualizerAnimation(trackName) {
  // For Spotify SDK playback, create an enhanced simulated animation
  const canvas = document.getElementById('audioVisualizer');
  if (!canvas) return;

  const canvasCtx = canvas.getContext('2d');
  animationRunning = true;
  simulatedVisualize(canvas, canvasCtx, trackName);
}

function visualize(canvas, canvasCtx) {
  if (!analyser) return;

  animationRunning = true;

  function draw() {
    if (!animationRunning) return;

    animationId = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);

    // Clear canvas with solid background matching the card
    canvasCtx.fillStyle = '#ffffff';
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

    const barWidth = (canvas.width / bufferLength) * 2.5;
    let barHeight;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      barHeight = (dataArray[i] / 255) * canvas.height;

      // Solid primary color bars
      canvasCtx.fillStyle = '#667eea';
      canvasCtx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);

      x += barWidth + 1;
    }
  }

  draw();
}

function simulatedVisualize(canvas, canvasCtx, trackName) {
  // Enhanced simulated visualization for Spotify SDK playback
  const bars = 64;
  const barValues = new Array(bars).fill(0);
  const targetValues = new Array(bars).fill(0);

  // Estimate BPM range (most music is 60-180 BPM)
  const baseBPM = 120 + Math.random() * 40; // Random between 120-160 BPM
  const beatInterval = (60 / baseBPM) * 1000; // Beat duration in ms

  let startTime = Date.now();
  let lastBeatTime = startTime;
  let beatPhase = 0;
  let energy = 0.5; // Energy level 0-1
  let targetEnergy = 0.5;

  // Get playback position for progress-based patterns
  async function getPlaybackState() {
    if (!spotifyPlayer) return null;
    try {
      const state = await spotifyPlayer.getCurrentState();
      return state;
    } catch (e) {
      return null;
    }
  }

  function draw() {
    if (!animationRunning) return;

    animationId = requestAnimationFrame(draw);

    const now = Date.now();
    const elapsed = now - startTime;

    // Simulate beat detection with rhythm
    if (now - lastBeatTime >= beatInterval) {
      lastBeatTime = now;
      beatPhase = 1.0;
      // Vary energy every few beats
      if (Math.random() > 0.7) {
        targetEnergy = 0.3 + Math.random() * 0.6;
      }
    }

    // Beat decay
    beatPhase *= 0.85;
    energy += (targetEnergy - energy) * 0.05;

    // Clear canvas with solid background matching the card
    canvasCtx.fillStyle = '#ffffff';
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

    const barWidth = canvas.width / bars - 2;

    // Get playback state for progress-based effects
    if (Math.random() < 0.02) { // Check occasionally to avoid performance hit
      getPlaybackState().then(state => {
        if (state && state.position && state.duration) {
          const progress = state.position / state.duration;
          // Use progress to influence visualization intensity
          targetEnergy = 0.3 + progress * 0.4 + Math.random() * 0.3;
        }
      });
    }

    for (let i = 0; i < bars; i++) {
      // Create frequency-like distribution (lower bars = bass, higher = treble)
      const freqFactor = 1 - (i / bars) * 0.5; // Bass stronger than treble

      // Multiple sine waves for richer movement
      const wave1 = Math.sin(elapsed / 300 + i * 0.15) * 0.15;
      const wave2 = Math.sin(elapsed / 150 + i * 0.08) * 0.1;
      const wave3 = Math.sin(elapsed / 500 + i * 0.25) * 0.08;

      // Beat pulse (affects all bars but more on bass)
      const beatPulse = beatPhase * freqFactor * 0.4;

      // Random variation (less than before)
      const randomVariation = Math.random() * 0.1;

      // Combine all factors with energy
      targetValues[i] = (wave1 + wave2 + wave3 + beatPulse + randomVariation + 0.2) * energy * freqFactor;
      targetValues[i] = Math.max(0.05, Math.min(1, targetValues[i]));

      // Smooth transition
      barValues[i] += (targetValues[i] - barValues[i]) * 0.15;

      const barHeight = barValues[i] * canvas.height;
      const x = i * (barWidth + 2);

      // Solid primary color bars
      canvasCtx.fillStyle = '#667eea';
      canvasCtx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
    }
  }

  draw();
}

function stopVisualization() {
  animationRunning = false;
  if (animationId) {
    cancelAnimationFrame(animationId);
  }

  // Clear canvas with white background
  const canvas = document.getElementById('audioVisualizer');
  if (canvas) {
    const canvasCtx = canvas.getContext('2d');
    canvasCtx.fillStyle = '#ffffff';
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
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
    document.body.style.overflow = 'hidden';
  }
}

function closeErrorModal() {
  const modal = document.getElementById('errorModal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }
}

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeErrorModal();
    closeSettingsModal();
  }
});


// ===== Profile and Settings Management =====
let userProfile = null;
let userSettings = null;

// Load user profile on page load
document.addEventListener('DOMContentLoaded', () => {
  loadUserProfile();
  loadUserSettings();
});

async function loadUserProfile() {
  try {
    const response = await fetch('/api/user/profile');

    if (response.ok) {
      userProfile = await response.json();
      updateProfileUI(userProfile);
    } else {
      console.log('User not authenticated');
    }
  } catch (error) {
    console.error('Failed to load profile:', error);
  }
}

function updateProfileUI(profile) {
  // Update avatar images
  const displayName = profile.display_name || 'User';
  const userAvatar = document.getElementById('userAvatar');
  const menuAvatar = document.getElementById('menuAvatar');

  if (profile.profile_image) {
    if (userAvatar) userAvatar.src = profile.profile_image;
    if (menuAvatar) menuAvatar.src = profile.profile_image;
  } else {
    // Use DiceBear avatar with initials as fallback
    const avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(displayName)}&backgroundColor=667eea&fontSize=40`;
    if (userAvatar) userAvatar.src = avatarUrl;
    if (menuAvatar) menuAvatar.src = avatarUrl;
  }

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
    document.body.style.overflow = 'hidden';

    // Close profile menu
    const userMenu = document.getElementById('userMenu');
    if (userMenu) userMenu.classList.add('hidden');

    // Load current settings into form
    if (userSettings) {
      const gameLength = document.getElementById('settingGameLength');
      const soundEffects = document.getElementById('settingSoundEffects');
      const notifications = document.getElementById('settingNotifications');
      const theme = document.getElementById('settingTheme');

      if (gameLength) gameLength.value = userSettings.default_game_length || 10;
      if (soundEffects) soundEffects.checked = userSettings.sound_effects !== false;
      if (notifications) notifications.checked = userSettings.notifications !== false;
      if (theme) theme.value = userSettings.theme || 'light';
    }
  }
}

function closeSettingsModal() {
  const modal = document.getElementById('settingsModal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
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

  const settings = {
    default_game_length: gameLength ? parseInt(gameLength.value) : 10,
    sound_effects: soundEffects ? soundEffects.checked : true,
    notifications: notifications ? notifications.checked : true,
    theme: theme ? theme.value : 'light'
  };

  try {
    const response = await fetch('/api/user/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });

    if (response.ok) {
      userSettings = settings;
      applySettings(settings);
      closeSettingsModal();

      // Show success notification
      showNotification('Settings saved successfully!', 'success');
    }
  } catch (error) {
    console.error('Failed to save settings:', error);
    showNotification('Failed to save settings', 'error');
  }
}

function applySettings(settings) {
  // Apply theme
  if (settings.theme === 'dark') {
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
  }

  // Other settings can be applied as needed
}

function showNotification(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `fixed bottom-4 right-4 px-6 py-3 rounded-lg shadow-lg z-50 ${type === 'success' ? 'bg-green-500' :
    type === 'error' ? 'bg-red-500' :
      'bg-blue-500'
    } text-white font-medium transition-opacity duration-300`;
  toast.textContent = message;

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
