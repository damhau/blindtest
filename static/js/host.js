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

// DOM Elements
const loginScreen = document.getElementById('loginScreen');
const createScreen = document.getElementById('createScreen');
const waitingScreen = document.getElementById('waitingScreen');
const gameScreen = document.getElementById('gameScreen');
const endScreen = document.getElementById('endScreen');
const authStatus = document.getElementById('authStatus');
const skipLoginBtn = document.getElementById('skipLoginBtn');

const playlistIdInput = document.getElementById('playlistId');
const createRoomBtn = document.getElementById('createRoomBtn');
const roomPinDisplay = document.getElementById('roomPin');
const participantsList = document.getElementById('participants');
const participantCount = document.getElementById('participantCount');
const startGameBtn = document.getElementById('startGameBtn');

const songNumber = document.getElementById('songNumber');
const totalSongs = document.getElementById('totalSongs');
const audioPlayer = document.getElementById('audioPlayer');
const nextSongBtn = document.getElementById('nextSongBtn');
const scoresList = document.getElementById('scoresList');
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

// Update song count display when slider changes
if (songCountSlider && songCountValue) {
  songCountSlider.addEventListener('input', (e) => {
    songCountValue.textContent = e.target.value;
  });
}

// Force hide auth status immediately
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
    alert('Spotify Premium is required for playback. Falling back to preview mode.');
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

  // Connect to the player
  spotifyPlayer.connect().then(success => {
    if (success) {
      console.log('Spotify Player connected successfully!');
    } else {
      console.log('Spotify Player connection failed');
    }
  });
}

function playSpotifyTrack(trackUri) {
  if (!spotifyPlayer || !deviceId) {
    console.log('Spotify player not ready');
    return false;
  }

  console.log('Attempting to play via Spotify SDK:', trackUri);
  console.log('Device ID:', deviceId);
  console.log('Token available:', !!spotifyAccessToken);

  fetch(`https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`, {
    method: 'PUT',
    body: JSON.stringify({ uris: [trackUri] }),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${spotifyAccessToken}`
    },
  }).then(response => {
    if (response.ok) {
      console.log('✓ Playing track via SDK:', trackUri);
      return true;
    } else {
      console.log('Failed to play track:', response.status, response.statusText);
      response.text().then(text => console.log('Error response:', text));
      return false;
    }
  }).catch(err => {
    console.error('Error playing track:', err);
    return false;
  });

  return true;
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

// Force hide auth status immediately
if (authStatus) {
  authStatus.classList.add('hidden');
  authStatus.style.display = 'none';
}

// Check authentication status on page load
window.addEventListener('load', () => {
  // Always start with auth status hidden
  if (authStatus) {
    authStatus.classList.add('hidden');
    authStatus.style.display = 'none';
  }

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('authenticated') === 'true') {
    // Verify with server before showing
    fetch('/check_auth')
      .then(res => res.json())
      .then(data => {
        if (data.authenticated) {
          isAuthenticated = true;
          if (authStatus) {
            authStatus.classList.remove('hidden');
            authStatus.style.display = 'block';
          }
          loadUserPlaylists();
          fetchSpotifyToken();
        }
      })
      .catch(err => {
        console.error('Auth check failed:', err);
        if (authStatus) {
          authStatus.classList.add('hidden');
          authStatus.style.display = 'none';
        }
      });
  } else {
    // Check if already authenticated
    fetch('/check_auth')
      .then(res => res.json())
      .then(data => {
        if (data.authenticated) {
          isAuthenticated = true;
          if (authStatus) {
            authStatus.classList.remove('hidden');
            authStatus.style.display = 'block';
          }
          loadUserPlaylists();
          fetchSpotifyToken();
        }
      })
      .catch(err => {
        console.error('Auth check failed:', err);
        if (authStatus) {
          authStatus.classList.add('hidden');
          authStatus.style.display = 'none';
        }
      });
  }
});

// Load user's playlists
function loadUserPlaylists() {
  if (!playlistSelector || !playlistGrid) return;

  // Show playlist selector, hide manual input
  playlistSelector.classList.remove('hidden');
  manualInput.classList.add('hidden');

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

        card.innerHTML = `
          ${playlist.image ? `<img src="${playlist.image}" alt="${playlist.name}">` : '<div class="no-image">🎵</div>'}
          <div class="playlist-info">
            <h4>${playlist.name}</h4>
            <p>${playlist.tracks} tracks</p>
            <small>by ${playlist.owner}</small>
          </div>
        `;

        card.addEventListener('click', () => {
          // Deselect all
          document.querySelectorAll('.playlist-card').forEach(c => c.classList.remove('selected'));
          // Select this one
          card.classList.add('selected');
          selectedPlaylistId = playlist.id;
        });

        playlistGrid.appendChild(card);
      });
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
    alert('Please select a playlist or enter a Spotify playlist ID/URL');
    return;
  }

  socket.emit('create_room', { playlist_id: playlistId });
});

// Start Game
startGameBtn.addEventListener('click', () => {
  if (!currentPin) return;

  console.log('Start Game clicked');

  // Get song count from slider
  const songCount = songCountSlider ? parseInt(songCountSlider.value) : 10;
  console.log('Song count selected:', songCount);

  // Disable button and show progress
  startGameBtn.disabled = true;
  startGameBtn.textContent = 'Generating questions...';

  const progressContainer = document.getElementById('generatingProgress');
  console.log('Progress container found:', !!progressContainer);

  if (progressContainer) {
    progressContainer.classList.remove('hidden');
    console.log('Progress container shown');
  }

  socket.emit('start_game', { pin: currentPin, song_count: songCount });
});

// Next Song
nextSongBtn.addEventListener('click', () => {
  if (!currentPin) return;

  socket.emit('next_question', { pin: currentPin });
});

// New Game
newGameBtn.addEventListener('click', () => {
  location.reload();
});

// Socket Events
socket.on('connected', (data) => {
  console.log('Connected to server:', data.sid);
});

socket.on('question_progress', (data) => {
  console.log('Progress update received:', data);

  const progressBarFill = document.getElementById('progressBarFill');
  const progressText = document.getElementById('progressText');
  const progressTotalSongs = document.getElementById('progressTotalSongs');

  console.log('Progress elements found:', !!progressBarFill, !!progressText);

  if (progressBarFill && progressText) {
    const percentage = (data.current / data.total) * 100;
    progressBarFill.style.width = percentage + '%';
    progressText.textContent = `Preparing track ${data.current} of ${data.total}`;
    if (progressTotalSongs) {
      progressTotalSongs.textContent = data.total;
    }
    console.log(`Progress: ${percentage}%`);
  }
});

socket.on('room_created', (data) => {
  currentPin = data.pin;
  roomPinDisplay.textContent = data.pin;

  showScreen(waitingScreen);
});

socket.on('participant_joined', (data) => {
  updateParticipantsList(data.participants);
});

socket.on('participant_left', (data) => {
  updateParticipantsList(data.participants);
});

socket.on('game_started', (data) => {
  // Hide progress bar and reset button
  const progressContainer = document.getElementById('generatingProgress');
  if (progressContainer) {
    progressContainer.classList.add('hidden');
  }
  startGameBtn.disabled = false;
  startGameBtn.textContent = 'Start Game';

  totalSongs.textContent = data.total_songs;
  showScreen(gameScreen);
});

socket.on('new_question', (data) => {
  currentQuestion = data;
  displayQuestion(data);
});

socket.on('scores_updated', (data) => {
  updateScoreboard(data.scores);
});

socket.on('show_correct_answer', (data) => {
  highlightCorrectAnswer(data.correct_answer);
});

socket.on('game_ended', (data) => {
  displayFinalScores(data.final_scores);
  showScreen(endScreen);
});

socket.on('error', (data) => {
  alert('Error: ' + data.message);
});

socket.on('room_closed', (data) => {
  alert(data.message);
  location.href = '/';
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

  participants.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.name;
    participantsList.appendChild(li);
  });
}

function displayQuestion(data) {
  // Debug logging
  console.log('=== Question Data ===');
  console.log('Track Name:', data.track_name);
  console.log('Artist:', data.options ? data.options[data.correct_answer] : 'N/A');
  console.log('All Options:', data.options);
  console.log('Correct Answer Index:', data.correct_answer);
  console.log('Track URI:', data.track_uri);
  console.log('Preview URL:', data.preview_url);
  console.log('Question Number:', data.question_number, '/', data.total_questions);
  console.log('====================');

  songNumber.textContent = data.question_number;
  totalSongs.textContent = data.total_questions;

  const spotifyPlayerUI = document.getElementById('spotifyPlayerUI');

  // Try Web Playback SDK first if available and we have a track URI
  let audioAvailable = false;

  if (data.track_uri && spotifyPlayer && deviceId) {
    console.log('Using Spotify Web Playback SDK for track:', data.track_uri);
    playSpotifyTrack(data.track_uri);

    // Hide HTML5 audio, show Spotify UI
    audioPlayer.style.display = 'none';
    if (spotifyPlayerUI) {
      spotifyPlayerUI.classList.remove('hidden');
      document.getElementById('playerTrackInfo').textContent = `Playing: ${data.track_name || 'Loading...'}`;
    }
    audioAvailable = true;
  } else if (data.preview_url) {
    // Fall back to preview URL
    console.log('Using preview URL');
    audioPlayer.src = data.preview_url;
    audioPlayer.load();
    audioPlayer.play();
    audioPlayer.style.display = 'block';

    // Hide Spotify UI
    if (spotifyPlayerUI) {
      spotifyPlayerUI.classList.add('hidden');
    }
    audioAvailable = true;
  }

  // Handle no audio case
  if (!audioAvailable) {
    audioPlayer.removeAttribute('src');
    audioPlayer.style.display = 'none';

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
    opt.classList.remove('correct');
  });
}

function highlightCorrectAnswer(correctIndex) {
  // Pause audio
  if (spotifyPlayer && deviceId) {
    spotifyPlayer.pause();
  } else {
    audioPlayer.pause();
  }

  // Highlight correct answer
  const correctOption = document.querySelector(`.answer-option:nth-child(${correctIndex + 1})`);
  if (correctOption) {
    correctOption.classList.add('correct');
  }
}

function updateScoreboard(scores) {
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

function displayFinalScores(scores) {
  finalScores.innerHTML = '';

  scores.forEach((player, index) => {
    const div = document.createElement('div');
    div.className = 'score-item';

    if (index === 0) div.classList.add('first');
    else if (index === 1) div.classList.add('second');
    else if (index === 2) div.classList.add('third');

    let medal = '';
    if (index === 0) medal = '🥇 ';
    else if (index === 1) medal = '🥈 ';
    else if (index === 2) medal = '🥉 ';

    div.innerHTML = `
            <span>${medal}${player.name}</span>
            <span>${player.score} pts</span>
        `;

    finalScores.appendChild(div);
  });
}
