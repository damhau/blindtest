// Force secure WebSocket when using HTTPS
const socket = io({
  transports: ['websocket', 'polling'],
  secure: window.location.protocol === 'https:',
  rejectUnauthorized: false
});

let currentPin = null;
let currentName = null;
let hasAnswered = false;

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

// Join Room
joinRoomBtn.addEventListener('click', () => {
  const name = playerNameInput.value.trim();
  const pin = roomPinInput.value.trim();

  if (!name) {
    alert('Please enter your name');
    return;
  }

  if (!pin || pin.length !== 4) {
    alert('Please enter a valid 4-digit PIN');
    return;
  }

  currentName = name;
  currentPin = pin;

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

  // Reset buttons
  answerButtons.forEach(btn => {
    btn.disabled = false;
    btn.classList.remove('selected');
  });

  // Hide feedback
  answerFeedback.classList.add('hidden');
});

socket.on('answer_feedback', (data) => {
  playerScore.textContent = data.your_score;

  // Show feedback
  answerFeedback.classList.remove('hidden');
  answerFeedback.className = 'feedback';

  if (data.correct) {
    answerFeedback.classList.add('correct');
    answerFeedback.textContent = '✓ Correct! +1 point';
  } else {
    answerFeedback.classList.add('incorrect');
    answerFeedback.textContent = '✗ Wrong answer';
  }
});

socket.on('scores_updated', (data) => {
  updateScoreboard(data.scores);
});

socket.on('show_correct_answer', (data) => {
  // Show which color was correct
  if (!hasAnswered) {
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
  alert('Error: ' + data.message);
});

socket.on('room_closed', (data) => {
  alert('Room closed: ' + data.message);
  location.href = '/';
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

  participants.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.name;
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
