// Force secure WebSocket when using HTTPS
const socket = io({
  transports: ['websocket', 'polling'],
  secure: window.location.protocol === 'https:',
  rejectUnauthorized: false
});

let currentPin = null;
let currentName = null;
let hasAnswered = false;
let selectedAnswer = null;
let readyForNextTimer = null;
let gamesInSeries = 1;
let currentGameNumber = 1;

// Connection resilience tracking
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let isReconnecting = false;

// DOM Elements
const joinScreen = document.getElementById('joinScreen');
const waitingScreen = document.getElementById('waitingScreen');
const gameScreen = document.getElementById('gameScreen');
const endScreen = document.getElementById('endScreen');

const playerNameInput = document.getElementById('playerName');
const roomPinInput = document.getElementById('roomPin');
const joinRoomBtn = document.getElementById('joinRoomBtn');

const currentPinDisplay = document.getElementById('currentPin');
const currentNameDisplay = document.getElementById('currentName');
const waitingParticipants = document.getElementById('participants');

const playerScore = document.getElementById('playerScore');
const answerButtons = document.querySelectorAll('.answer-btn');
const answerFeedback = document.getElementById('answerFeedback');
const scoresList = document.getElementById('scoresList');

const finalScore = document.getElementById('finalScore');
const finalScores = document.getElementById('finalScores');

// Loading overlay elements
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingTitle = document.getElementById('loadingTitle');
const loadingMessage = document.getElementById('loadingMessage');

// Loading state management
function showLoading(title = 'Loading...', message = 'Please wait') {
  if (loadingOverlay) {
    loadingTitle.textContent = title;
    loadingMessage.textContent = message;
    loadingOverlay.classList.remove('hidden');
    // Trigger reflow for animation
    loadingOverlay.offsetHeight;
    loadingOverlay.classList.add('show');
  }
}

function hideLoading() {
  if (loadingOverlay) {
    loadingOverlay.classList.remove('show');
    setTimeout(() => {
      loadingOverlay.classList.add('hidden');
    }, 300);
  }
}

// Cookie helper functions
function setCookie(name, value, days = 365) {
  const date = new Date();
  date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
  const expires = "expires=" + date.toUTCString();
  document.cookie = name + "=" + value + ";" + expires + ";path=/";
}

function getCookie(name) {
  const nameEQ = name + "=";
  const ca = document.cookie.split(';');
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) === ' ') c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
}

// Check for PIN in URL parameters and load saved name
window.addEventListener('load', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const pinFromUrl = urlParams.get('pin');

  // Load saved name from cookie
  const savedName = getCookie('playerName');
  if (savedName) {
    playerNameInput.value = savedName;
  }

  if (pinFromUrl && pinFromUrl.length === 4) {
    roomPinInput.value = pinFromUrl;
    // Focus on name input for convenience (or join button if name is filled)
    if (savedName) {
      joinRoomBtn.focus();
    } else {
      playerNameInput.focus();
    }
  } else if (savedName) {
    // If name is saved but no PIN, focus on PIN input
    roomPinInput.focus();
  }
});

// Join Room
joinRoomBtn.addEventListener('click', () => {
  const name = playerNameInput.value.trim();
  const pin = roomPinInput.value.trim();

  if (!name) {
    showErrorModal('Name Required', 'Please enter your name to join the game.');
    return;
  }

  if (!pin || pin.length !== 4) {
    showErrorModal('Invalid PIN', 'Please enter a valid 4-digit room PIN.');
    return;
  }

  currentName = name;
  currentPin = pin;

  // Save name to cookie
  setCookie('playerName', name);

  // Show loading state
  showLoading('Joining Game', `Connecting to room ${pin}...`);
  joinRoomBtn.disabled = true;

  socket.emit('join_room', { name, pin });
});

// Answer Buttons
answerButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (hasAnswered) return;

    const answer = parseInt(btn.dataset.answer);

    // Disable all buttons
    answerButtons.forEach(b => b.disabled = true);
    btn.classList.add('selected');

    hasAnswered = true;
    selectedAnswer = answer;

    socket.emit('submit_answer', {
      pin: currentPin,
      answer: answer
    });
  });
});

// Socket Events
socket.on('connected', (data) => {
  console.log('Connected to server:', data.sid);
});

socket.on('room_joined', (data) => {
  hideLoading();
  joinRoomBtn.disabled = false;

  currentPin = data.pin;
  currentName = data.name;

  currentPinDisplay.textContent = data.pin;
  currentNameDisplay.textContent = data.name;

  updateWaitingParticipants(data.participants);

  // Check if joining mid-game
  if (data.mid_game) {
    console.log('Joined mid-game, waiting for next question');

    // Show game screen with waiting state
    showScreen(gameScreen);

    // Update player name in game screen
    const gamePlayerName = document.getElementById('gamePlayerName');
    if (gamePlayerName) {
      gamePlayerName.textContent = currentName;
    }

    // Update score display
    updateScoreboard(data.current_scores);

    // Show "waiting for next question" overlay
    const waitingOverlay = document.createElement('div');
    waitingOverlay.id = 'midGameWaitingOverlay';
    waitingOverlay.className = 'fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50';
    waitingOverlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl p-8 max-w-md text-center">
        <div class="mb-4">
          <svg class="w-16 h-16 mx-auto text-primary animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
        </div>
        <h2 class="text-2xl font-bold text-gray-800 mb-2">Welcome to the Game!</h2>
        <p class="text-gray-600 mb-4">
          You joined mid-game at question <span class="font-bold text-primary">${data.current_question}/${data.total_questions}</span>
        </p>
        <p class="text-gray-500 text-sm">
          You'll be able to answer starting from the <span class="font-semibold">next question</span>
        </p>
        <div class="mt-6">
          <div class="inline-flex items-center gap-2 text-gray-400">
            <div class="w-2 h-2 bg-primary rounded-full animate-bounce"></div>
            <div class="w-2 h-2 bg-primary rounded-full animate-bounce" style="animation-delay: 0.1s"></div>
            <div class="w-2 h-2 bg-primary rounded-full animate-bounce" style="animation-delay: 0.2s"></div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(waitingOverlay);
  } else {
    // Normal join before game starts
    showScreen(waitingScreen);
  }
});

socket.on('question_progress', (data) => {
  // Show progress when game preparation starts
  const progressContainer = document.getElementById('gamePreparationProgress');
  const progressBar = document.getElementById('prepProgressBar');
  const progressText = document.getElementById('prepProgressText');
  const progressDetails = document.getElementById('prepProgressDetails');

  if (progressContainer && progressBar && progressText) {
    // Show progress container
    progressContainer.classList.remove('hidden');

    // Hide the "Waiting for Host..." header when progress starts
    const waitingHeader = document.querySelector('#waitingScreen .text-center.mb-8');
    if (waitingHeader) {
      waitingHeader.classList.add('hidden');
    }

    // Hide the "Waiting for the host to start the game..." message
    const waitingMessage = document.querySelector('#waitingScreen .bg-blue-50');
    if (waitingMessage) {
      waitingMessage.classList.add('hidden');
    }

    // Calculate percentage
    const percentage = (data.current / data.total) * 100;
    progressBar.style.width = percentage + '%';

    // Update text
    progressText.textContent = `Preparing track ${data.current} of ${data.total}...`;

    if (progressDetails) {
      progressDetails.textContent = `Building your perfect music quiz! 🎶`;
    }
  }
});

socket.on('participant_joined', (data) => {
  updateWaitingParticipants(data.participants);
});

socket.on('participant_left', (data) => {
  updateWaitingParticipants(data.participants);
});

socket.on('game_started', (data) => {
  // Remove mid-game waiting overlay if present
  const waitingOverlay = document.getElementById('midGameWaitingOverlay');
  if (waitingOverlay) {
    waitingOverlay.remove();
  }

  // Display player name in game screen
  const gamePlayerName = document.getElementById('gamePlayerName');
  if (gamePlayerName) {
    gamePlayerName.textContent = currentName;
  }

  // Track series info
  gamesInSeries = data?.games_in_series || 1;
  currentGameNumber = data?.current_game || 1;

  // Update header if multiple games - now insert into the player info card (p-6)
  if (gamesInSeries > 1) {
    const playerInfoCard = document.querySelector('#gameScreen .bg-white.rounded-2xl.shadow-lg.p-6');
    if (playerInfoCard && !document.getElementById('seriesInfo')) {
      const seriesInfo = document.createElement('div');
      seriesInfo.id = 'seriesInfo';
      seriesInfo.className = 'text-center mb-3';
      seriesInfo.innerHTML = `<span class="text-sm font-semibold text-purple-600">Game ${currentGameNumber} of ${gamesInSeries}</span>`;
      playerInfoCard.insertBefore(seriesInfo, playerInfoCard.firstChild);
    } else if (document.getElementById('seriesInfo')) {
      document.getElementById('seriesInfo').innerHTML = `<span class="text-sm font-semibold text-purple-600">Game ${currentGameNumber} of ${gamesInSeries}</span>`;
    }
  } else {
    // Remove series info if it exists (single game)
    const seriesInfo = document.getElementById('seriesInfo');
    if (seriesInfo) {
      seriesInfo.remove();
    }
  }

  // Go directly to game screen
  showScreen(gameScreen);
});

socket.on('new_question_participant', (data) => {
  // Remove mid-game waiting overlay if present (for next question after joining)
  const waitingOverlay = document.getElementById('midGameWaitingOverlay');
  if (waitingOverlay) {
    waitingOverlay.remove();
  }

  hasAnswered = false;
  selectedAnswer = null;

  // Clear ready timer if still running
  if (readyForNextTimer) {
    clearTimeout(readyForNextTimer);
    readyForNextTimer = null;
  }

  // Reset buttons
  answerButtons.forEach((btn, index) => {
    btn.disabled = false;
    btn.classList.remove('selected');
    btn.style.border = '';
    // Reset button content to just the letter
    btn.innerHTML = `<span class="text-5xl font-bold">${['A', 'B', 'C', 'D'][index]}</span>`;
  });

  // Hide feedback
  answerFeedback.classList.add('hidden');
});

socket.on('answer_feedback', (data) => {
  // Keep the selected button pressed - don't remove the class
  // The button will stay pressed until the next question
  // Note: Score is not displayed anymore
});

socket.on('scores_updated', (data) => {
  updateScoreboard(data.scores);
});

socket.on('show_correct_answer', (data) => {
  // Clear any existing timer to prevent duplicates
  if (readyForNextTimer) {
    clearTimeout(readyForNextTimer);
    readyForNextTimer = null;
  }

  // Highlight the correct answer button with a checkmark
  const correctIndex = data.correct_answer;
  const letters = ['A', 'B', 'C', 'D'];

  answerButtons.forEach((btn, index) => {
    if (index === correctIndex) {
      // Add checkmark to correct answer
      btn.innerHTML = `
        <div class="flex items-center justify-center gap-3">
          <span class="text-5xl font-bold">${letters[index]}</span>
          <svg class="w-12 h-12" viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" fill="#10b981" opacity="0.3"/>
            <path d="M9 12l2 2 4-4" stroke="#10b981"/>
          </svg>
        </div>
      `;
      btn.style.border = '4px solid #10b981';
      btn.style.boxShadow = '0 0 20px rgba(16, 185, 129, 0.5)';
    } else if (hasAnswered && selectedAnswer === index) {
      // Add red X to wrong answer they selected
      btn.innerHTML = `
        <div class="flex items-center justify-center gap-3">
          <span class="text-5xl font-bold">${letters[index]}</span>
          <svg class="w-12 h-12" viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" fill="#ef4444" opacity="0.3"/>
            <path d="M8 8l8 8M16 8l-8 8" stroke="#ef4444"/>
          </svg>
        </div>
      `;
      btn.style.border = '4px solid #ef4444';
      btn.style.boxShadow = '0 0 20px rgba(239, 68, 68, 0.5)';
    }
  });

  // Show which color was correct
  if (!hasAnswered) {
    answerFeedback.classList.remove('hidden');
    answerFeedback.className = 'feedback incorrect';
    // answerFeedback.textContent = '⏱ Time\'s up!';
  }

  // Notify server that correct answer has been displayed
  socket.emit('correct_answer_displayed', { pin: currentPin });

  // After 5 seconds, signal ready for next
  readyForNextTimer = setTimeout(() => {
    socket.emit('ready_for_next', { pin: currentPin });
    readyForNextTimer = null;
  }, 5000);
});

socket.on('question_timeout', () => {
  // Disable voting when time runs out
  if (!hasAnswered) {
    answerButtons.forEach(btn => btn.disabled = true);
    answerFeedback.classList.remove('hidden');
    answerFeedback.className = 'feedback incorrect';
    // answerFeedback.textContent = '⏱ Time\'s up!';
  }
});

socket.on('game_ended', (data) => {
  // For single games or when intermediate game ends in a series
  // In series, this goes to host only (not participants)
  if (data.final_scores) {
    displayFinalScores(data.final_scores);
    showScreen(endScreen);
  }
});

socket.on('series_ended', (data) => {
  // When entire series ends, show final scores to participants
  displayFinalScores(data.final_scores);
  showScreen(endScreen);
});

socket.on('error', (data) => {
  hideLoading();
  joinRoomBtn.disabled = false;
  showErrorModal('Error', data.message);
});

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
  }
});

socket.on('room_closed', (data) => {
  showErrorModal('Room Closed', data.message);

  // Redirect to home after modal is closed
  setTimeout(() => {
    location.href = '/';
  }, 3000);
});

// Helper Functions
function showScreen(screen) {
  [joinScreen, waitingScreen, gameScreen, endScreen].forEach(s => {
    s.classList.add('hidden');
  });
  screen.classList.remove('hidden');
}

function updateWaitingParticipants(participants) {
  waitingParticipants.innerHTML = '';

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
    waitingParticipants.appendChild(li);
  });
}

function updateScoreboard(scores) {
  // Participant page doesn't have a live scoreboard, only end screen scores
  if (!scoresList) {
    console.log('Scoreboard not available on participant view');
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

function displayFinalScores(scores) {
  // Find current player's score
  const myScore = scores.find(s => s.name === currentName);
  if (myScore) {
    // Use series_score for multi-game, score for single game
    const displayScore = myScore.series_score !== undefined ? myScore.series_score : myScore.score;
    finalScore.textContent = displayScore;
  }

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

    // Use series_score for multi-game, score for single game
    const displayScore = player.series_score !== undefined ? player.series_score : player.score;

    div.innerHTML = `
            <span>${medal}${player.name}</span>
            <span>${displayScore} pts</span>
        `;

    finalScores.appendChild(div);
  });
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
  showReconnectingOverlay();
});

socket.on('connect', () => {
  console.log('WebSocket connected');

  if (isReconnecting && currentPin && currentName) {
    console.log('Attempting to rejoin room:', currentPin);

    // Attempt to rejoin room
    socket.emit('rejoin_room', {
      pin: currentPin,
      name: currentName,
      was_host: false
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
  updateReconnectingOverlay();

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    hideReconnectingOverlay();
    showConnectionFailedError();
  }
});

socket.on('rejoin_success', (data) => {
  console.log('Successfully rejoined room');
  hideReconnectingOverlay();

  // Update local state with synced data
  if (data.current_score !== undefined) {
    playerScore.textContent = data.current_score;
  }

  // Show brief success message
  showNotification('Reconnected successfully!', 'success');
});

socket.on('rejoin_failed', (data) => {
  console.error('Failed to rejoin room:', data.message);
  hideReconnectingOverlay();
  showConnectionFailedError(data.message);
});

function showReconnectingOverlay() {
  // Remove existing overlay if present
  hideReconnectingOverlay();

  const overlay = document.createElement('div');
  overlay.id = 'reconnectOverlay';
  overlay.className = 'fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50';
  overlay.innerHTML = `
    <div class="bg-white rounded-lg p-8 text-center max-w-md">
      <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
      <p class="text-lg font-semibold text-gray-800">Connection lost</p>
      <p class="text-gray-600 mt-2">Attempting to reconnect...</p>
      <p id="reconnectAttemptCount" class="text-sm text-gray-500 mt-4">Attempt ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS}</p>
    </div>
  `;
  document.body.appendChild(overlay);
}

function updateReconnectingOverlay() {
  const attemptCountElement = document.getElementById('reconnectAttemptCount');
  if (attemptCountElement) {
    attemptCountElement.textContent = `Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`;
  }
}

function hideReconnectingOverlay() {
  const overlay = document.getElementById('reconnectOverlay');
  if (overlay) {
    overlay.remove();
  }
}

function showConnectionFailedError(message = 'Unable to reconnect to the server') {
  const overlay = document.createElement('div');
  overlay.id = 'connectionFailedOverlay';
  overlay.className = 'fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50';
  overlay.innerHTML = `
    <div class="bg-white rounded-lg p-8 text-center max-w-md">
      <div class="text-red-500 text-5xl mb-4">⚠️</div>
      <p class="text-lg font-semibold text-gray-800 mb-2">Connection Failed</p>
      <p class="text-gray-600 mb-6">${message}</p>
      <button onclick="location.reload()" class="px-6 py-2 bg-primary text-white rounded-lg hover:bg-primary-dark">
        Refresh Page
      </button>
    </div>
  `;
  document.body.appendChild(overlay);
}

function showNotification(message, type = 'info') {
  const toast = document.createElement('div');
  const bgColor = type === 'success' ? 'bg-green-500' :
    type === 'error' ? 'bg-red-500' :
      'bg-blue-500';

  toast.className = `fixed bottom-4 right-4 px-6 py-3 rounded-lg shadow-lg z-50 ${bgColor} text-white font-medium transform transition-all`;
  toast.textContent = message;
  toast.style.transform = 'translateY(100px)';

  document.body.appendChild(toast);

  // Slide in animation
  setTimeout(() => {
    toast.style.transform = 'translateY(0)';
  }, 10);

  // Auto-remove after 3 seconds
  setTimeout(() => {
    toast.style.transform = 'translateY(100px)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
