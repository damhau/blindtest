const socket = io();

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

let selectedPlaylistId = null;

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

  socket.emit('start_game', { pin: currentPin });
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
  songNumber.textContent = data.question_number;
  totalSongs.textContent = data.total_questions;

  // Play audio - use preview URL or Web Playback SDK
  if (data.track_uri && isAuthenticated && spotifyPlayer) {
    // Use Spotify Web Playback SDK for full playback (OAuth)
    // Note: This requires proper player initialization with access token
    console.log('Would play track:', data.track_uri);
    // For now, fall back to preview
    if (data.preview_url) {
      audioPlayer.src = data.preview_url;
      audioPlayer.load();
      audioPlayer.play();
    } else {
      console.log('No preview URL available');
    }
  } else if (data.preview_url) {
    // Use preview URL
    audioPlayer.src = data.preview_url;
    audioPlayer.load();
    audioPlayer.play();
  } else {
    console.log('No audio available for this track');
    audioPlayer.removeAttribute('src');
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
  audioPlayer.pause();

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
