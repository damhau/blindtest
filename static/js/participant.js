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
  currentPin = data.pin;
  currentName = data.name;

  currentPinDisplay.textContent = data.pin;
  currentNameDisplay.textContent = data.name;

  updateWaitingParticipants(data.participants);
  showScreen(waitingScreen);
});

socket.on('participant_joined', (data) => {
  updateWaitingParticipants(data.participants);
});

socket.on('participant_left', (data) => {
  updateWaitingParticipants(data.participants);
});

socket.on('game_started', (data) => {
  showScreen(gameScreen);
});

socket.on('new_question_participant', (data) => {
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
  playerScore.textContent = data.your_score;

  // Don't show feedback message - just update score silently
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
  answerButtons.forEach((btn, index) => {
    if (index === correctIndex) {
      // Add checkmark to correct answer
      btn.innerHTML = `
        <div class="flex items-center justify-center gap-3">
          <span class="text-5xl font-bold">${['A', 'B', 'C', 'D'][index]}</span>
          <svg class="w-12 h-12 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" fill="#10b981" opacity="0.3"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
        </div>
      `;
      btn.style.border = '4px solid #10b981';
      btn.style.boxShadow = '0 0 20px rgba(16, 185, 129, 0.5)';
    } else if (hasAnswered && selectedAnswer === index) {
      // Add red X to wrong answer they selected
      btn.innerHTML = `
        <div class="flex items-center justify-center gap-3">
          <span class="text-5xl font-bold">${['A', 'B', 'C', 'D'][index]}</span>
          <svg class="w-12 h-12 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" fill="#ef4444" opacity="0.3"/>
            <path d="M8 8l8 8M16 8l-8 8"/>
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
    answerFeedback.textContent = '⏱ Time\'s up!';
  }
});

socket.on('game_ended', (data) => {
  displayFinalScores(data.final_scores);
  showScreen(endScreen);
});

socket.on('error', (data) => {
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
    finalScore.textContent = myScore.score;
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

    div.innerHTML = `
            <span>${medal}${player.name}</span>
            <span>${player.score} pts</span>
        `;

    finalScores.appendChild(div);
  });
}
