# Comprehensive Code Review & Improvement Proposals
**MusicQuiz Blindtest Application - December 31, 2025**

---

## Executive Summary

Your blindtest application is **well-architected** with solid real-time functionality, attractive UI, and good separation of concerns. The recent event-driven architecture improvements have significantly enhanced reliability. However, there are opportunities for improvement in:

1. **Code Quality & Architecture** - Memory management, error handling
2. **Gameplay Experience** - Fairness, engagement, accessibility
3. **UI/UX Polish** - Feedback, responsiveness, mobile optimization
4. **Reliability & Performance** - Connection handling, scaling considerations
5. **Security & Production Readiness** - Auth, configuration, deployment

---

## 1. CODE QUALITY & ARCHITECTURE

### 1.1 Memory Management & Resource Cleanup

**Issue**: Rooms persist indefinitely in memory even after games end.

**Current Risk**:
- Memory leaks from abandoned rooms
- Orphaned SocketIO rooms
- Growing `rooms` dictionary

**Proposal**:
```python
# Add to Room class
class Room:
    def __init__(self, ...):
        # ... existing code ...
        self.last_activity = datetime.now()
        self.cleanup_timer = None
    
    def update_activity(self):
        self.last_activity = datetime.now()

# Add periodic cleanup task
def cleanup_inactive_rooms():
    """Remove rooms inactive for > 1 hour"""
    while True:
        socketio.sleep(300)  # Check every 5 minutes
        cutoff = datetime.now() - timedelta(hours=1)
        rooms_to_delete = []
        
        for pin, room in rooms.items():
            if room.last_activity < cutoff:
                rooms_to_delete.append(pin)
                # Notify any remaining connections
                socketio.emit('room_closed', 
                    {'message': 'Room expired due to inactivity'}, 
                    room=pin)
        
        for pin in rooms_to_delete:
            print(f'Cleaning up inactive room: {pin}')
            del rooms[pin]

# Start on app launch
socketio.start_background_task(cleanup_inactive_rooms)
```

**Additional**: Add explicit cleanup on game end
```python
@socketio.on('end_game')
def handle_end_game(data):
    # ... existing code ...
    
    # Schedule room deletion after 5 minutes
    def delayed_cleanup():
        socketio.sleep(300)
        if pin in rooms:
            print(f'Removing completed game room: {pin}')
            del rooms[pin]
    
    socketio.start_background_task(delayed_cleanup)
```

### 1.2 Error Handling & Resilience

**Issue**: Limited error handling in critical paths.

**Examples of Missing Handlers**:
- Spotify API failures during game start
- OpenAI API failures for fake artists
- Network disconnections mid-game
- Invalid token refresh failures

**Proposal - Robust Game Start**:
```python
@socketio.on('start_game')
def handle_start_game(data):
    pin = data.get('pin')
    
    if pin not in rooms:
        emit('error', {'message': 'Room not found'})
        return
    
    room = rooms[pin]
    
    try:
        # Fetch tracks with retry logic
        tracks, error = fetch_tracks_with_retry(room, max_retries=3)
        if error:
            emit('game_start_failed', {
                'error': 'Failed to load playlist',
                'details': error
            })
            return
        
        # Generate questions with fallbacks
        for track in tracks:
            try:
                question = generate_question_safe(room, track)
                room.questions.append(question)
            except Exception as e:
                print(f'Skipping track {track.get("name")}: {e}')
                continue
        
        if len(room.questions) < 5:
            emit('game_start_failed', {
                'error': f'Only {len(room.questions)} valid tracks found',
                'details': 'Playlist may not have enough preview URLs or valid data'
            })
            return
        
        # Start game...
        
    except Exception as e:
        print(f'Critical error starting game: {e}')
        emit('game_start_failed', {
            'error': 'Unexpected error',
            'details': str(e)
        })

def fetch_tracks_with_retry(room, max_retries=3):
    """Fetch tracks with exponential backoff"""
    for attempt in range(max_retries):
        try:
            # ... fetch logic ...
            return tracks, None
        except spotipy.exceptions.SpotifyException as e:
            if attempt < max_retries - 1:
                wait_time = 2 ** attempt
                print(f'Spotify API error, retrying in {wait_time}s...')
                socketio.sleep(wait_time)
            else:
                return None, f'Spotify API error: {str(e)}'
        except Exception as e:
            return None, f'Unexpected error: {str(e)}'
```

**Frontend Error Display**:
```javascript
// Add to host.js
socket.on('game_start_failed', (data) => {
  const errorMsg = document.createElement('div');
  errorMsg.className = 'bg-red-100 border-l-4 border-red-500 text-red-700 p-4 rounded-lg mb-4';
  errorMsg.innerHTML = `
    <p class="font-bold">Failed to Start Game</p>
    <p>${data.error}</p>
    ${data.details ? `<p class="text-sm mt-2">${data.details}</p>` : ''}
    <button onclick="location.reload()" class="mt-3 px-4 py-2 bg-red-600 text-white rounded">
      Try Again
    </button>
  `;
  
  document.getElementById('createScreen').prepend(errorMsg);
});
```

### 1.3 Service Layer Improvements

**Issue**: Service instantiation and error handling mixed with business logic.

**Proposal - Singleton Pattern with Graceful Degradation**:
```python
# services.py (new file)
class ServiceManager:
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialize()
        return cls._instance
    
    def _initialize(self):
        self.spotify = None
        self.spotify_oauth = None
        self.openai = None
        self.services_status = {}
        
        # Initialize with error tracking
        try:
            from spotify_service import get_spotify_service
            self.spotify = get_spotify_service()
            self.services_status['spotify'] = 'available'
        except Exception as e:
            print(f'Spotify service unavailable: {e}')
            self.services_status['spotify'] = 'unavailable'
        
        try:
            from spotify_oauth_service import get_spotify_oauth_service
            self.spotify_oauth = get_spotify_oauth_service()
            self.services_status['spotify_oauth'] = 'available'
        except Exception as e:
            print(f'Spotify OAuth unavailable: {e}')
            self.services_status['spotify_oauth'] = 'unavailable'
        
        try:
            from openai_service import get_openai_service
            self.openai = get_openai_service()
            self.services_status['openai'] = 'available'
        except Exception as e:
            print(f'OpenAI service unavailable: {e}')
            self.services_status['openai'] = 'unavailable'
    
    def get_status(self):
        return self.services_status

# Endpoint to check service health
@app.route('/health')
def health_check():
    services = ServiceManager()
    return jsonify({
        'status': 'healthy',
        'services': services.get_status()
    })
```

---

## 2. GAMEPLAY EXPERIENCE

### 2.1 Answer Timing Fairness

**Issue**: Network latency creates unfair advantages. Player on fast connection always ranks higher.

**Current Behavior**:
```python
# Timestamp recorded when answer ARRIVES at server
self.answers[self.question_index][sid] = {
    'answer': answer,
    'timestamp': datetime.now()  # Server time, biased by network latency
}
```

**Proposal - Client-Side Timestamps**:
```python
# Backend
def record_answer(self, sid, answer, client_timestamp=None):
    if self.question_index not in self.answers:
        self.answers[self.question_index] = {}
    
    # Use client timestamp if provided, otherwise server time
    timestamp = client_timestamp if client_timestamp else datetime.now()
    
    self.answers[self.question_index][sid] = {
        'answer': answer,
        'timestamp': timestamp,
        'server_received': datetime.now()  # For debugging/validation
    }

# Frontend (participant.js)
function submitAnswer(answerIndex) {
    const clientTimestamp = new Date().toISOString();
    
    socket.emit('submit_answer', {
        pin: currentPin,
        answer: answerIndex,
        client_timestamp: clientTimestamp
    });
}
```

**Alternative - Latency Compensation**:
```python
# Measure round-trip time and compensate
@socketio.on('ping')
def handle_ping(data):
    emit('pong', {'server_time': datetime.now().isoformat()})

# Client sends measured latency with answer
# Server subtracts half the RTT from timestamp
```

### 2.2 Progressive Difficulty & Engagement

**Issue**: Flat difficulty curve, no tension building.

**Proposal - Dynamic Question Complexity**:
```python
class Room:
    def generate_question(self, track, fake_artists, difficulty='medium'):
        """Generate question with configurable difficulty"""
        correct_artist = track['artist']
        
        # Difficulty affects fake artist selection
        if difficulty == 'easy':
            # More obvious fakes, different genres
            prompt_modifier = "from clearly different genres"
        elif difficulty == 'hard':
            # Very similar artists
            prompt_modifier = "extremely similar in style and popularity"
        else:
            prompt_modifier = ""
        
        # Pass to OpenAI service...
        
        return question
    
    def get_question_difficulty(self):
        """Progressive difficulty"""
        progress = (self.question_index + 1) / len(self.questions)
        
        if progress < 0.33:
            return 'easy'
        elif progress < 0.66:
            return 'medium'
        else:
            return 'hard'
```

**Visual Feedback**:
```javascript
// Show difficulty indicator
function displayQuestion(data) {
    const difficulty = getDifficulty(data.question_number, data.total_questions);
    const badge = document.createElement('span');
    badge.className = `difficulty-badge ${difficulty}`;
    badge.textContent = difficulty.toUpperCase();
    // Add to question display...
}
```

### 2.3 Streaks & Power-Ups

**Proposal - Reward Consistency**:
```python
class Room:
    def __init__(self, ...):
        # ... existing code ...
        self.participant_streaks = {}  # sid -> streak count
    
    def check_answer(self, sid, answer):
        is_correct = # ... existing logic ...
        
        if is_correct:
            # Increment streak
            self.participant_streaks[sid] = self.participant_streaks.get(sid, 0) + 1
            
            # Bonus for streaks
            streak = self.participant_streaks[sid]
            if streak >= 3:
                bonus_multiplier = 1 + (0.1 * (streak - 2))  # +10% per streak after 3
                points *= bonus_multiplier
                
                # Notify player
                socketio.emit('streak_bonus', {
                    'streak': streak,
                    'bonus': bonus_multiplier
                }, to=sid)
        else:
            # Reset streak
            self.participant_streaks[sid] = 0
        
        return is_correct
```

**UI Enhancement**:
```javascript
// Show streak indicator on participant screen
socket.on('streak_bonus', (data) => {
    const streakBadge = document.createElement('div');
    streakBadge.className = 'streak-badge animate-bounce';
    streakBadge.innerHTML = `
        <span class="text-2xl">🔥</span>
        <span>${data.streak}x STREAK!</span>
        <span class="text-sm">+${Math.round((data.bonus - 1) * 100)}% bonus</span>
    `;
    // Display and auto-remove...
});
```

### 2.4 Tie-Breaker Mechanism

**Issue**: Multiple players with identical scores lack final resolution.

**Proposal**:
```python
def get_scores(self):
    """Get scores with tie-breaker metrics"""
    scores = []
    for sid, participant in self.participants.items():
        # Calculate tie-breaker metrics
        correct_count = sum(
            1 for q_idx, answers in self.answers.items()
            if sid in answers and 
            answers[sid]['answer'] == self.questions[q_idx]['correct_answer']
        )
        
        # Average response time for correct answers
        correct_times = [
            (answers[sid]['timestamp'] - self.question_start_times[q_idx]).total_seconds()
            for q_idx, answers in self.answers.items()
            if sid in answers and 
            answers[sid]['answer'] == self.questions[q_idx]['correct_answer']
        ]
        avg_time = sum(correct_times) / len(correct_times) if correct_times else 999
        
        scores.append({
            'name': participant['name'],
            'score': participant['score'],
            'correct_count': correct_count,
            'avg_time': round(avg_time, 2),
            'sid': sid
        })
    
    # Sort: primary by score, secondary by correct count, tertiary by avg time
    scores.sort(
        key=lambda x: (-x['score'], -x['correct_count'], x['avg_time'])
    )
    
    return scores
```

---

## 3. UI/UX IMPROVEMENTS

### 3.1 Loading States & Feedback

**Issue**: Users see no feedback during long operations (game start, playlist load).

**Proposal - Skeleton Loaders**:
```html
<!-- In host.html -->
<div id="gameStartingOverlay" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
  <div class="bg-white rounded-2xl p-8 max-w-md">
    <div class="text-center">
      <div class="inline-block animate-spin rounded-full h-16 w-16 border-b-4 border-primary mb-4"></div>
      <h3 class="text-xl font-bold mb-2">Preparing Your Game</h3>
      <p id="loadingStep" class="text-gray-600 mb-4">Fetching tracks...</p>
      <div class="w-full bg-gray-200 rounded-full h-2">
        <div id="loadingProgress" class="bg-gradient-to-r from-indigo-600 to-purple-600 h-2 rounded-full transition-all" style="width: 0%"></div>
      </div>
      <p id="loadingDetails" class="text-sm text-gray-500 mt-3">This may take a moment...</p>
    </div>
  </div>
</div>
```

```python
# Backend - emit progress updates
@socketio.on('start_game')
def handle_start_game(data):
    pin = data.get('pin')
    room = rooms[pin]
    
    # Step 1: Fetch tracks
    emit('game_prep_progress', {'step': 'Fetching tracks', 'progress': 10}, to=room.host_sid)
    tracks, error = fetch_playlist_tracks(...)
    
    # Step 2: Generate questions
    emit('game_prep_progress', {'step': 'Generating questions', 'progress': 40}, to=room.host_sid)
    for i, track in enumerate(tracks):
        progress = 40 + (i / len(tracks)) * 50
        emit('game_prep_progress', {
            'step': f'Processing track {i+1}/{len(tracks)}',
            'progress': progress
        }, to=room.host_sid)
        # ... generate question ...
    
    emit('game_prep_progress', {'step': 'Starting game', 'progress': 100}, to=room.host_sid)
```

### 3.2 Mobile Optimization

**Issue**: Some interactions not optimized for touch devices.

**Proposal - Touch-Friendly Enhancements**:
```css
/* Add to style.css */
.answer-btn {
    /* Larger touch targets */
    min-height: 60px;
    padding: 1rem;
    
    /* Prevent text selection on rapid taps */
    -webkit-user-select: none;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    
    /* Smooth transitions */
    transition: transform 0.1s ease, background-color 0.2s ease;
}

.answer-btn:active {
    transform: scale(0.95);
}

/* Improve input fields on mobile */
input[type="text"], input[type="number"] {
    font-size: 16px; /* Prevents iOS zoom on focus */
    min-height: 44px; /* iOS recommended touch target */
}

/* Better modal sizing on mobile */
@media (max-width: 640px) {
    .modal-content {
        width: 95vw;
        max-height: 85vh;
        padding: 1rem;
    }
}
```

**Add Haptic Feedback** (for supported devices):
```javascript
function triggerHaptic(type = 'light') {
    if (navigator.vibrate) {
        const patterns = {
            light: 10,
            medium: 20,
            heavy: [10, 20, 10]
        };
        navigator.vibrate(patterns[type]);
    }
}

// Use on interactions
answerBtn.addEventListener('click', () => {
    triggerHaptic('medium');
    submitAnswer(index);
});
```

### 3.3 Accessibility Improvements

**Issue**: Limited keyboard navigation, no ARIA labels, poor screen reader support.

**Proposal**:
```html
<!-- Add proper ARIA labels -->
<button class="answer-btn" 
        role="button" 
        tabindex="0"
        aria-label="Answer option A"
        aria-pressed="false">
  <span aria-hidden="true">A</span>
</button>

<!-- Add keyboard navigation hints -->
<div class="sr-only" role="status" aria-live="polite" id="gameAnnouncements"></div>

<script>
// Announce game events to screen readers
function announce(message) {
    const announcer = document.getElementById('gameAnnouncements');
    announcer.textContent = message;
}

socket.on('new_question', () => {
    announce(`Question ${data.question_number} of ${data.total_questions}. Four answer options available.`);
});

socket.on('show_correct_answer', (data) => {
    announce(`Correct answer was option ${String.fromCharCode(65 + data.correct_answer)}`);
});
</script>
```

**Keyboard Shortcuts**:
```javascript
// Add to participant.js
document.addEventListener('keydown', (e) => {
    if (hasAnswered || !gameScreen.classList.contains('active')) return;
    
    const keyMap = {
        '1': 0, 'a': 0, 'A': 0,
        '2': 1, 'b': 1, 'B': 1,
        '3': 2, 'c': 2, 'C': 2,
        '4': 3, 'd': 3, 'D': 3
    };
    
    if (keyMap.hasOwnProperty(e.key)) {
        e.preventDefault();
        const answerIndex = keyMap[e.key];
        document.querySelectorAll('.answer-btn')[answerIndex].click();
    }
});
```

### 3.4 Real-Time Score Animations

**Issue**: Score updates are instant, missing satisfying feedback.

**Proposal**:
```javascript
// Animated score counter
function animateScore(element, from, to, duration = 1000) {
    const startTime = performance.now();
    const difference = to - from;
    
    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Ease-out cubic
        const easeProgress = 1 - Math.pow(1 - progress, 3);
        const currentScore = Math.round(from + difference * easeProgress);
        
        element.textContent = currentScore;
        
        if (progress < 1) {
            requestAnimationFrame(update);
        }
    }
    
    requestAnimationFrame(update);
}

// Use when updating scores
socket.on('scores_updated', (data) => {
    const oldScore = parseInt(playerScore.textContent) || 0;
    const newScore = data.scores.find(s => s.name === currentName)?.score || 0;
    
    if (newScore > oldScore) {
        animateScore(playerScore, oldScore, newScore, 800);
        // Add particle effect
        showScoreParticles(newScore - oldScore);
    }
});
```

---

## 4. RELIABILITY & PERFORMANCE

### 4.1 Connection Resilience

**Issue**: No automatic reconnection or state recovery after disconnection.

**Proposal**:
```javascript
// Add to both host.js and participant.js
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

socket.on('disconnect', (reason) => {
    console.log('Disconnected:', reason);
    
    if (reason === 'io server disconnect') {
        // Server forcibly disconnected, try to reconnect
        socket.connect();
    }
    
    // Show reconnection UI
    showReconnectingOverlay();
});

socket.on('connect', () => {
    reconnectAttempts = 0;
    hideReconnectingOverlay();
    
    // Attempt to rejoin room if we were in one
    if (currentPin && currentName) {
        socket.emit('rejoin_room', {
            pin: currentPin,
            name: currentName,
            was_host: isHost  // Track role
        });
    }
});

socket.on('connect_error', () => {
    reconnectAttempts++;
    
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        showConnectionFailedError();
    }
});

function showReconnectingOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'reconnectOverlay';
    overlay.className = 'fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50';
    overlay.innerHTML = `
        <div class="bg-white rounded-lg p-8 text-center">
            <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p class="text-lg font-semibold">Connection lost</p>
            <p class="text-gray-600">Attempting to reconnect...</p>
        </div>
    `;
    document.body.appendChild(overlay);
}
```

**Backend State Recovery**:
```python
@socketio.on('rejoin_room')
def handle_rejoin(data):
    pin = data.get('pin')
    name = data.get('name')
    was_host = data.get('was_host', False)
    
    if pin not in rooms:
        emit('error', {'message': 'Room no longer exists'})
        return
    
    room = rooms[pin]
    
    if was_host and room.host_sid != request.sid:
        # Host reconnecting with new SID
        room.host_sid = request.sid
        join_room(pin)
        
        # Resend current game state
        if room.state == 'playing':
            host_data = {
                'question_number': room.question_index + 1,
                'total_questions': len(room.questions),
                # ... full current question ...
            }
            emit('state_sync', host_data)
    else:
        # Regular participant rejoining
        # ... handle participant rejoin ...
```

### 4.2 Rate Limiting & Abuse Prevention

**Issue**: No protection against spam/abuse (rapid answer submissions, room creation spam).

**Proposal**:
```python
from collections import defaultdict
from datetime import datetime, timedelta

# Rate limiting tracking
rate_limits = {
    'create_room': defaultdict(list),  # IP -> [timestamps]
    'submit_answer': defaultdict(list),  # SID -> [timestamps]
}

def check_rate_limit(category, identifier, max_requests=5, window_seconds=60):
    """Check if identifier exceeded rate limit"""
    now = datetime.now()
    cutoff = now - timedelta(seconds=window_seconds)
    
    # Clean old entries
    rate_limits[category][identifier] = [
        ts for ts in rate_limits[category][identifier]
        if ts > cutoff
    ]
    
    # Check limit
    if len(rate_limits[category][identifier]) >= max_requests:
        return False, f'Rate limit exceeded. Try again in {window_seconds}s'
    
    # Record request
    rate_limits[category][identifier].append(now)
    return True, None

@socketio.on('create_room')
def handle_create_room(data):
    # Rate limit by IP
    ip = request.remote_addr
    allowed, error = check_rate_limit('create_room', ip, max_requests=3, window_seconds=300)
    
    if not allowed:
        emit('error', {'message': error})
        return
    
    # ... continue with room creation ...

@socketio.on('submit_answer')
def handle_submit_answer(data):
    # Prevent spam submissions
    allowed, error = check_rate_limit('submit_answer', request.sid, max_requests=10, window_seconds=10)
    
    if not allowed:
        emit('error', {'message': 'Too many requests. Please slow down.'})
        return
    
    # ... continue with answer submission ...
```

### 4.4 Real-Time Connection Status Indicator

**Issue**: Users have no visibility into WebSocket connection status, leading to confusion when network issues occur.

**Proposal - Connection Status Badge**:

**HTML (Host & Participant)**:
```html
<!-- Add to top navigation in both host.html and participant.html -->
<nav class="bg-white border-b border-gray-200 px-6 py-4">
  <div class="max-w-7xl mx-auto flex items-center justify-between">
    <!-- Existing logo/content -->
    
    <!-- Connection Status Badge -->
    <div id="connectionStatus" class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-100 border border-green-300">
      <div id="connectionDot" class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
      <span id="connectionText" class="text-xs font-semibold text-green-700">Connected</span>
    </div>
  </div>
</nav>
```

**CSS (Add to style.css)**:
```css
/* Connection status animations */
#connectionStatus {
  transition: all 0.3s ease;
}

#connectionStatus.connected {
  background-color: #dcfce7;
  border-color: #86efac;
}

#connectionStatus.connected #connectionDot {
  background-color: #22c55e;
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

#connectionStatus.connecting {
  background-color: #fef3c7;
  border-color: #fde047;
}

#connectionStatus.connecting #connectionDot {
  background-color: #eab308;
  animation: pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

#connectionStatus.disconnected {
  background-color: #fee2e2;
  border-color: #fca5a5;
}

#connectionStatus.disconnected #connectionDot {
  background-color: #ef4444;
  animation: none;
}

#connectionStatus.reconnecting {
  background-color: #fed7aa;
  border-color: #fdba74;
}

#connectionStatus.reconnecting #connectionDot {
  background-color: #f97316;
  animation: pulse 0.5s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
```

**JavaScript (Add to both host.js and participant.js)**:
```javascript
// Connection status management
const connectionStatus = {
  badge: null,
  dot: null,
  text: null,
  
  init() {
    this.badge = document.getElementById('connectionStatus');
    this.dot = document.getElementById('connectionDot');
    this.text = document.getElementById('connectionText');
  },
  
  setState(state, message = null) {
    if (!this.badge) return;
    
    // Remove all state classes
    this.badge.classList.remove('connected', 'connecting', 'disconnected', 'reconnecting');
    
    // Add new state
    this.badge.classList.add(state);
    
    // Update text
    const messages = {
      connected: 'Connected',
      connecting: 'Connecting...',
      disconnected: 'Disconnected',
      reconnecting: 'Reconnecting...'
    };
    
    this.text.textContent = message || messages[state] || state;
  }
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  connectionStatus.init();
  connectionStatus.setState('connecting');
});

// Socket.IO connection event handlers
socket.on('connect', () => {
  console.log('WebSocket connected');
  connectionStatus.setState('connected');
  
  // Optional: Show brief success notification
  showConnectionNotification('Connected to server', 'success');
});

socket.on('disconnect', (reason) => {
  console.log('WebSocket disconnected:', reason);
  connectionStatus.setState('disconnected', 'Connection lost');
  
  // Show persistent notification
  showConnectionNotification('Lost connection to server. Attempting to reconnect...', 'error', true);
});

socket.on('connect_error', (error) => {
  console.error('Connection error:', error);
  connectionStatus.setState('reconnecting');
});

socket.on('reconnect_attempt', (attemptNumber) => {
  console.log('Reconnection attempt:', attemptNumber);
  connectionStatus.setState('reconnecting', `Reconnecting... (${attemptNumber})`);
});

socket.on('reconnect', (attemptNumber) => {
  console.log('Reconnected after', attemptNumber, 'attempts');
  connectionStatus.setState('connected');
  
  // Show success notification
  showConnectionNotification('Reconnected successfully!', 'success');
  
  // Attempt to rejoin room if we were in one
  if (currentPin && currentName) {
    socket.emit('rejoin_room', {
      pin: currentPin,
      name: currentName,
      was_host: isHost  // Track this appropriately
    });
  }
});

socket.on('reconnect_failed', () => {
  console.error('Reconnection failed');
  connectionStatus.setState('disconnected', 'Unable to reconnect');
  
  showConnectionNotification(
    'Unable to reconnect. Please refresh the page.',
    'error',
    true
  );
});

// Connection notification toast
function showConnectionNotification(message, type = 'info', persistent = false) {
  const toast = document.createElement('div');
  toast.className = `fixed bottom-4 right-4 px-6 py-3 rounded-lg shadow-lg z-50 transform transition-all ${
    type === 'success' ? 'bg-green-500' :
    type === 'error' ? 'bg-red-500' :
    'bg-blue-500'
  } text-white font-medium`;
  toast.textContent = message;
  
  document.body.appendChild(toast);
  
  // Slide in animation
  setTimeout(() => toast.classList.add('translate-y-0'), 10);
  
  // Auto-remove after 5 seconds unless persistent
  if (!persistent) {
    setTimeout(() => {
      toast.classList.add('opacity-0');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }
}

// Periodic connection health check
setInterval(() => {
  if (socket.connected) {
    connectionStatus.setState('connected');
  } else {
    connectionStatus.setState('disconnected');
  }
}, 5000);
```

**Enhanced with Latency Monitoring**:
```javascript
// Add latency monitoring
let lastPingTime = null;
let latency = null;

function measureLatency() {
  lastPingTime = Date.now();
  socket.emit('ping', { timestamp: lastPingTime });
}

socket.on('pong', (data) => {
  if (lastPingTime) {
    latency = Date.now() - lastPingTime;
    
    // Update connection status with latency
    let latencyText = '';
    if (latency < 100) {
      latencyText = `Connected (${latency}ms) • Excellent`;
    } else if (latency < 300) {
      latencyText = `Connected (${latency}ms) • Good`;
    } else if (latency < 500) {
      latencyText = `Connected (${latency}ms) • Fair`;
    } else {
      latencyText = `Connected (${latency}ms) • Slow`;
    }
    
    connectionStatus.setState('connected', latencyText);
  }
});

// Measure latency every 10 seconds when connected
setInterval(() => {
  if (socket.connected) {
    measureLatency();
  }
}, 10000);

// Backend ping handler
@socketio.on('ping')
def handle_ping(data):
    emit('pong', data)
```

**Benefits**:
1. **Transparency**: Users know if they're connected
2. **Network Issues**: Immediate feedback on connection problems
3. **Latency Awareness**: Optional display of connection quality
4. **Automatic Reconnection**: Visual feedback during reconnect attempts
5. **Professional Feel**: Shows app is monitoring connection health

**Visual States**:
- 🟢 **Connected** - Green badge, pulsing dot
- 🟡 **Connecting** - Yellow badge, faster pulse
- 🔴 **Disconnected** - Red badge, solid dot
- 🟠 **Reconnecting** - Orange badge, rapid pulse

### 4.5 Database Persistence (Future Scalability)

**Issue**: All data in memory, lost on restart. No game history or analytics.

**Proposal - SQLite for Start**:
```python
import sqlite3
from datetime import datetime

def init_db():
    conn = sqlite3.connect('blindtest.db')
    c = conn.cursor()
    
    c.execute('''
        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pin TEXT NOT NULL,
            playlist_id TEXT,
            created_at TIMESTAMP,
            ended_at TIMESTAMP,
            total_questions INTEGER,
            total_players INTEGER
        )
    ''')
    
    c.execute('''
        CREATE TABLE IF NOT EXISTS game_participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER,
            name TEXT,
            final_score INTEGER,
            correct_answers INTEGER,
            avg_response_time REAL,
            FOREIGN KEY (game_id) REFERENCES games(id)
        )
    ''')
    
    c.execute('''
        CREATE TABLE IF NOT EXISTS game_questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER,
            question_number INTEGER,
            track_name TEXT,
            correct_artist TEXT,
            FOREIGN KEY (game_id) REFERENCES games(id)
        )
    ''')
    
    conn.commit()
    conn.close()

# Save game on completion
def save_game_to_db(room):
    conn = sqlite3.connect('blindtest.db')
    c = conn.cursor()
    
    # Insert game record
    c.execute('''
        INSERT INTO games (pin, playlist_id, created_at, ended_at, total_questions, total_players)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (
        room.pin,
        room.playlist_id,
        room.created_at,
        datetime.now(),
        len(room.questions),
        len(room.participants)
    ))
    
    game_id = c.lastrowid
    
    # Insert participants
    for sid, participant in room.participants.items():
        # Calculate stats...
        c.execute('''
            INSERT INTO game_participants (game_id, name, final_score, correct_answers, avg_response_time)
            VALUES (?, ?, ?, ?, ?)
        ''', (game_id, participant['name'], participant['score'], correct_count, avg_time))
    
    conn.commit()
    conn.close()
    
    return game_id
```

**Add Leaderboard Endpoint**:
```python
@app.route('/leaderboard')
def leaderboard():
    conn = sqlite3.connect('blindtest.db')
    c = conn.cursor()
    
    # Top players by total score
    c.execute('''
        SELECT name, SUM(final_score) as total_score, COUNT(*) as games_played
        FROM game_participants
        GROUP BY name
        ORDER BY total_score DESC
        LIMIT 10
    ''')
    
    top_players = c.fetchall()
    conn.close()
    
    return jsonify([
        {'name': row[0], 'total_score': row[1], 'games_played': row[2]}
        for row in top_players
    ])
```

---

## 5. SECURITY & PRODUCTION READINESS

### 5.1 Environment & Configuration

**Issue**: Some configs hardcoded, unclear production setup.

**Proposal - Config Management**:
```python
# config.py (new file)
import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    # Flask
    SECRET_KEY = os.getenv('SECRET_KEY', 'dev-secret-change-in-production')
    DEBUG = os.getenv('FLASK_DEBUG', 'False').lower() == 'true'
    
    # Security
    SESSION_COOKIE_SECURE = os.getenv('SESSION_SECURE', 'False').lower() == 'true'
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = 'Lax'
    
    # CORS
    CORS_ORIGINS = os.getenv('CORS_ORIGINS', '*').split(',')
    
    # Rate Limiting
    RATE_LIMIT_CREATE_ROOM = int(os.getenv('RATE_LIMIT_CREATE_ROOM', '3'))
    RATE_LIMIT_WINDOW = int(os.getenv('RATE_LIMIT_WINDOW', '300'))
    
    # Game Settings
    ROOM_CLEANUP_INTERVAL = int(os.getenv('ROOM_CLEANUP_INTERVAL', '300'))
    ROOM_INACTIVITY_TIMEOUT = int(os.getenv('ROOM_INACTIVITY_TIMEOUT', '3600'))
    
    # External Services
    SPOTIFY_CLIENT_ID = os.getenv('SPOTIFY_CLIENT_ID')
    SPOTIFY_CLIENT_SECRET = os.getenv('SPOTIFY_CLIENT_SECRET')
    OPENAI_API_KEY = os.getenv('OPENAI_API_KEY')
    
    @classmethod
    def validate(cls):
        """Validate required configs"""
        required = [
            'SECRET_KEY',
            'SPOTIFY_CLIENT_ID',
            'SPOTIFY_CLIENT_SECRET',
            'OPENAI_API_KEY'
        ]
        
        missing = [key for key in required if not getattr(cls, key)]
        
        if missing:
            raise ValueError(f'Missing required config: {", ".join(missing)}')

# Use in app.py
from config import Config

Config.validate()
app.config.from_object(Config)
```

**.env.example**:
```bash
# Flask
SECRET_KEY=your-secret-key-here
FLASK_DEBUG=False

# Security
SESSION_SECURE=True  # Set to True in production with HTTPS

# CORS (comma-separated)
CORS_ORIGINS=https://yourdomain.com,https://www.yourdomain.com

# Spotify
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REDIRECT_URI=https://yourdomain.com/callback

# OpenAI
OPENAI_API_KEY=your_openai_key

# Game Settings (optional)
ROOM_CLEANUP_INTERVAL=300
ROOM_INACTIVITY_TIMEOUT=3600
```

### 5.2 Input Validation & Sanitization

**Issue**: Limited input validation could allow injection or crashes.

**Proposal**:
```python
from flask import escape
import re

def validate_pin(pin):
    """Validate room PIN format"""
    if not pin or not isinstance(pin, str):
        return False, "Invalid PIN format"
    
    pin = pin.strip()
    if not re.match(r'^\d{4}$', pin):
        return False, "PIN must be 4 digits"
    
    return True, pin

def validate_name(name, max_length=20):
    """Validate and sanitize player name"""
    if not name or not isinstance(name, str):
        return False, "Name is required"
    
    name = name.strip()
    
    if len(name) == 0:
        return False, "Name cannot be empty"
    
    if len(name) > max_length:
        return False, f"Name too long (max {max_length} characters)"
    
    # Sanitize HTML/script tags
    name = escape(name)
    
    # Remove any non-printable characters
    name = re.sub(r'[^\x20-\x7E]', '', name)
    
    return True, name

def validate_playlist_id(playlist_id):
    """Validate Spotify playlist ID or URL"""
    if not playlist_id or not isinstance(playlist_id, str):
        return False, "Invalid playlist ID"
    
    playlist_id = playlist_id.strip()
    
    # Extract ID from full URL
    if 'spotify.com/playlist/' in playlist_id:
        match = re.search(r'playlist/([a-zA-Z0-9]+)', playlist_id)
        if match:
            playlist_id = match.group(1)
    
    # Validate format
    if not re.match(r'^[a-zA-Z0-9]+$', playlist_id):
        return False, "Invalid playlist ID format"
    
    return True, playlist_id

# Use in handlers
@socketio.on('join_room')
def handle_join_room(data):
    pin = data.get('pin', '')
    name = data.get('name', '')
    
    # Validate PIN
    valid, result = validate_pin(pin)
    if not valid:
        emit('error', {'message': result})
        return
    pin = result
    
    # Validate name
    valid, result = validate_name(name)
    if not valid:
        emit('error', {'message': result})
        return
    name = result
    
    # ... continue with join logic ...
```

### 5.3 User Profile & Settings Implementation

**Issue**: Currently using placeholder "Profile coming soon!" buttons. No user preferences or Spotify profile integration.

**Proposal - Complete Profile & Settings System**:

**Backend - User Profile Endpoints**:

```python
# app.py additions
@app.route('/profile')
def profile():
    """User profile page"""
    token_info = session.get('spotify_token')
    
    if not token_info:
        return redirect('/login')
    
    return render_template('profile.html')

@app.route('/api/user/profile')
def get_user_profile():
    """Get user profile data from Spotify"""
    token_info = session.get('spotify_token')
    
    if not token_info:
        return jsonify({'error': 'Not authenticated'}), 401
    
    try:
        sp_client, refreshed_token = spotify_oauth_service.get_spotify_client(token_info)
        
        if not sp_client:
            return jsonify({'error': 'Failed to get Spotify client'}), 500
        
        # Update session if token was refreshed
        if refreshed_token != token_info:
            session['spotify_token'] = refreshed_token
        
        # Get user profile
        user_info = sp_client.current_user()
        
        # Get user's top artists (for profile customization)
        top_artists = sp_client.current_user_top_artists(limit=5, time_range='medium_term')
        
        # Get user's saved tracks count
        saved_tracks = sp_client.current_user_saved_tracks(limit=1)
        
        profile_data = {
            'display_name': user_info.get('display_name', 'User'),
            'email': user_info.get('email'),
            'country': user_info.get('country'),
            'product': user_info.get('product'),  # free/premium
            'followers': user_info.get('followers', {}).get('total', 0),
            'profile_image': user_info['images'][0]['url'] if user_info.get('images') else None,
            'spotify_url': user_info.get('external_urls', {}).get('spotify'),
            'top_artists': [
                {
                    'name': artist['name'],
                    'image': artist['images'][0]['url'] if artist.get('images') else None,
                    'genres': artist.get('genres', [])[:3]
                }
                for artist in top_artists['items']
            ] if top_artists else [],
            'saved_tracks_count': saved_tracks['total'] if saved_tracks else 0
        }
        
        return jsonify(profile_data)
        
    except Exception as e:
        print(f"Error fetching profile: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/user/settings', methods=['GET', 'POST'])
def user_settings():
    """Get or update user settings"""
    if request.method == 'GET':
        # Get settings from session or defaults
        settings = session.get('user_settings', {
            'theme': 'light',
            'sound_effects': True,
            'notifications': True,
            'default_game_length': 10,
            'difficulty_preference': 'medium',
            'show_leaderboard': True,
            'auto_start_games': False,
            'preferred_genres': []
        })
        return jsonify(settings)
    
    elif request.method == 'POST':
        # Update settings
        settings = request.json
        session['user_settings'] = settings
        return jsonify({'success': True, 'settings': settings})

@app.route('/api/user/stats')
def user_stats():
    """Get user game statistics"""
    # This would query the database once implemented
    # For now, return mock data structure
    stats = {
        'games_played': 0,
        'total_score': 0,
        'correct_answers': 0,
        'avg_response_time': 0,
        'best_score': 0,
        'favorite_genre': 'Unknown',
        'win_rate': 0,
        'current_streak': 0,
        'longest_streak': 0
    }
    
    return jsonify(stats)
```

**Frontend - Profile Dropdown Menu (Replace placeholder)**:

```html
<!-- In host.html and index.html navigation -->
<div class="relative">
  <!-- User Avatar/Button -->
  <button id="profileMenuBtn" onclick="toggleProfileMenu()" 
    class="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-100 transition-colors">
    <img id="userAvatar" src="/static/assets/default-avatar.png" 
      alt="Profile" class="w-8 h-8 rounded-full">
    <span id="userName" class="font-medium text-gray-700">Profile</span>
    <svg class="w-4 h-4 text-gray-500 transition-transform" id="profileMenuIcon" 
      fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
    </svg>
  </button>

  <!-- Dropdown Menu -->
  <div id="profileMenu" class="hidden absolute right-0 mt-2 w-72 bg-white rounded-xl shadow-lg border border-gray-200 py-2 z-50">
    <!-- User Info Section -->
    <div class="px-4 py-3 border-b border-gray-100">
      <div class="flex items-center gap-3">
        <img id="menuAvatar" src="/static/assets/default-avatar.png" 
          class="w-12 h-12 rounded-full">
        <div class="flex-1">
          <p id="menuUserName" class="font-semibold text-gray-800">Loading...</p>
          <p id="menuUserEmail" class="text-sm text-gray-500">email@example.com</p>
        </div>
      </div>
      <div class="mt-2 flex gap-2 text-xs">
        <span id="userPlan" class="px-2 py-1 bg-purple-100 text-purple-700 rounded">Premium</span>
        <span class="px-2 py-1 bg-gray-100 text-gray-700 rounded">
          <span id="gamesPlayed">0</span> games played
        </span>
      </div>
    </div>

    <!-- Menu Items -->
    <div class="py-2">
      <a href="/profile" class="flex items-center gap-3 px-4 py-2 hover:bg-gray-50 transition-colors">
        <svg class="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
            d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path>
        </svg>
        <span class="text-gray-700 font-medium">View Profile</span>
      </a>

      <button onclick="openSettingsModal()" class="w-full flex items-center gap-3 px-4 py-2 hover:bg-gray-50 transition-colors">
        <svg class="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
        </svg>
        <span class="text-gray-700 font-medium">Settings</span>
      </button>

      <a href="/leaderboard" class="flex items-center gap-3 px-4 py-2 hover:bg-gray-50 transition-colors">
        <svg class="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
        </svg>
        <span class="text-gray-700 font-medium">Leaderboard</span>
      </a>
    </div>

    <div class="border-t border-gray-100 pt-2">
      <a href="/logout" class="flex items-center gap-3 px-4 py-2 hover:bg-red-50 transition-colors text-red-600">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
            d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path>
        </svg>
        <span class="font-medium">Logout</span>
      </a>
    </div>
  </div>
</div>

<!-- Settings Modal -->
<div id="settingsModal" class="hidden fixed inset-0 z-50 overflow-y-auto">
  <div class="flex items-center justify-center min-h-screen px-4">
    <div class="fixed inset-0 bg-black bg-opacity-50" onclick="closeSettingsModal()"></div>
    
    <div class="relative bg-white rounded-2xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
      <!-- Header -->
      <div class="sticky top-0 bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-6 py-4 rounded-t-2xl">
        <div class="flex items-center justify-between">
          <h2 class="text-2xl font-bold">⚙️ Settings</h2>
          <button onclick="closeSettingsModal()" class="text-white hover:text-gray-200">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>
      </div>

      <!-- Settings Content -->
      <div class="p-6 space-y-6">
        <!-- Game Preferences -->
        <div class="space-y-4">
          <h3 class="text-lg font-bold text-gray-800">Game Preferences</h3>
          
          <div class="flex items-center justify-between">
            <div>
              <p class="font-medium text-gray-700">Default Game Length</p>
              <p class="text-sm text-gray-500">Number of questions per game</p>
            </div>
            <select id="settingGameLength" class="px-4 py-2 border border-gray-300 rounded-lg">
              <option value="5">5 questions</option>
              <option value="10" selected>10 questions</option>
              <option value="15">15 questions</option>
              <option value="20">20 questions</option>
            </select>
          </div>

          <div class="flex items-center justify-between">
            <div>
              <p class="font-medium text-gray-700">Difficulty Preference</p>
              <p class="text-sm text-gray-500">Default difficulty for games</p>
            </div>
            <select id="settingDifficulty" class="px-4 py-2 border border-gray-300 rounded-lg">
              <option value="easy">Easy</option>
              <option value="medium" selected>Medium</option>
              <option value="hard">Hard</option>
            </select>
          </div>

          <div class="flex items-center justify-between">
            <div>
              <p class="font-medium text-gray-700">Sound Effects</p>
              <p class="text-sm text-gray-500">Play sounds for actions</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" id="settingSoundEffects" class="sr-only peer" checked>
              <div class="w-11 h-6 bg-gray-200 peer-focus:ring-4 peer-focus:ring-purple-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
            </label>
          </div>

          <div class="flex items-center justify-between">
            <div>
              <p class="font-medium text-gray-700">Notifications</p>
              <p class="text-sm text-gray-500">Show game notifications</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" id="settingNotifications" class="sr-only peer" checked>
              <div class="w-11 h-6 bg-gray-200 peer-focus:ring-4 peer-focus:ring-purple-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
            </label>
          </div>
        </div>

        <!-- Display Settings -->
        <div class="space-y-4 pt-4 border-t border-gray-200">
          <h3 class="text-lg font-bold text-gray-800">Display</h3>
          
          <div class="flex items-center justify-between">
            <div>
              <p class="font-medium text-gray-700">Theme</p>
              <p class="text-sm text-gray-500">Visual appearance</p>
            </div>
            <select id="settingTheme" class="px-4 py-2 border border-gray-300 rounded-lg">
              <option value="light" selected>Light</option>
              <option value="dark">Dark</option>
              <option value="auto">Auto</option>
            </select>
          </div>

          <div class="flex items-center justify-between">
            <div>
              <p class="font-medium text-gray-700">Show Leaderboard</p>
              <p class="text-sm text-gray-500">Display global rankings</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" id="settingShowLeaderboard" class="sr-only peer" checked>
              <div class="w-11 h-6 bg-gray-200 peer-focus:ring-4 peer-focus:ring-purple-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
            </label>
          </div>
        </div>

        <!-- Account Actions -->
        <div class="space-y-4 pt-4 border-t border-gray-200">
          <h3 class="text-lg font-bold text-gray-800">Account</h3>
          
          <button onclick="clearGameHistory()" 
            class="w-full px-4 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 text-left">
            <p class="font-medium text-gray-700">Clear Game History</p>
            <p class="text-sm text-gray-500">Remove all stored game data</p>
          </button>

          <button onclick="window.location.href='/logout'" 
            class="w-full px-4 py-3 border border-red-300 rounded-lg hover:bg-red-50 text-left text-red-600">
            <p class="font-medium">Logout from Spotify</p>
            <p class="text-sm">You'll need to login again</p>
          </button>
        </div>
      </div>

      <!-- Footer -->
      <div class="sticky bottom-0 bg-gray-50 px-6 py-4 rounded-b-2xl flex justify-end gap-3">
        <button onclick="closeSettingsModal()" 
          class="px-6 py-2 border border-gray-300 rounded-lg hover:bg-gray-100">
          Cancel
        </button>
        <button onclick="saveSettings()" 
          class="px-6 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-lg hover:from-indigo-700 hover:to-purple-700">
          Save Changes
        </button>
      </div>
    </div>
  </div>
</div>
```

**JavaScript Implementation**:

```javascript
// Profile and settings management
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
  if (profile.profile_image) {
    document.getElementById('userAvatar').src = profile.profile_image;
    document.getElementById('menuAvatar').src = profile.profile_image;
  }
  
  // Update display name
  const displayName = profile.display_name || 'User';
  document.getElementById('userName').textContent = displayName;
  document.getElementById('menuUserName').textContent = displayName;
  
  // Update email
  if (profile.email) {
    document.getElementById('menuUserEmail').textContent = profile.email;
  }
  
  // Update plan badge
  const planBadge = document.getElementById('userPlan');
  if (profile.product === 'premium') {
    planBadge.textContent = '⭐ Premium';
    planBadge.className = 'px-2 py-1 bg-yellow-100 text-yellow-700 rounded';
  } else {
    planBadge.textContent = 'Free';
    planBadge.className = 'px-2 py-1 bg-gray-100 text-gray-700 rounded';
  }
}

function toggleProfileMenu() {
  const menu = document.getElementById('profileMenu');
  const icon = document.getElementById('profileMenuIcon');
  
  if (menu.classList.contains('hidden')) {
    menu.classList.remove('hidden');
    icon.style.transform = 'rotate(180deg)';
  } else {
    menu.classList.add('hidden');
    icon.style.transform = 'rotate(0deg)';
  }
}

// Close menu when clicking outside
document.addEventListener('click', (e) => {
  const menu = document.getElementById('profileMenu');
  const btn = document.getElementById('profileMenuBtn');
  
  if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) {
    menu.classList.add('hidden');
    document.getElementById('profileMenuIcon').style.transform = 'rotate(0deg)';
  }
});

// Settings modal functions
function openSettingsModal() {
  document.getElementById('settingsModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  
  // Close profile menu
  document.getElementById('profileMenu').classList.add('hidden');
  
  // Load current settings into form
  if (userSettings) {
    document.getElementById('settingGameLength').value = userSettings.default_game_length || 10;
    document.getElementById('settingDifficulty').value = userSettings.difficulty_preference || 'medium';
    document.getElementById('settingSoundEffects').checked = userSettings.sound_effects !== false;
    document.getElementById('settingNotifications').checked = userSettings.notifications !== false;
    document.getElementById('settingTheme').value = userSettings.theme || 'light';
    document.getElementById('settingShowLeaderboard').checked = userSettings.show_leaderboard !== false;
  }
}

function closeSettingsModal() {
  document.getElementById('settingsModal').classList.add('hidden');
  document.body.style.overflow = '';
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
  const settings = {
    default_game_length: parseInt(document.getElementById('settingGameLength').value),
    difficulty_preference: document.getElementById('settingDifficulty').value,
    sound_effects: document.getElementById('settingSoundEffects').checked,
    notifications: document.getElementById('settingNotifications').checked,
    theme: document.getElementById('settingTheme').value,
    show_leaderboard: document.getElementById('settingShowLeaderboard').checked
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

function clearGameHistory() {
  if (confirm('Are you sure you want to clear all your game history? This cannot be undone.')) {
    // Implement clear history logic
    localStorage.clear();
    showNotification('Game history cleared', 'success');
  }
}

function showNotification(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `fixed bottom-4 right-4 px-6 py-3 rounded-lg shadow-lg z-50 ${
    type === 'success' ? 'bg-green-500' :
    type === 'error' ? 'bg-red-500' :
    'bg-blue-500'
  } text-white font-medium`;
  toast.textContent = message;
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.add('opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
```

**Benefits**:
1. **Rich User Profiles** - Spotify data integration (avatar, name, plan, top artists)
2. **Customizable Settings** - Game preferences, display options, notifications
3. **Professional UI** - Dropdown menu with smooth transitions
4. **Persistent Preferences** - Settings saved in session/database
5. **Enhanced UX** - Clear account management and logout options

### 5.4 Logging & Monitoring
        return False, "Invalid playlist ID"
    
    playlist_id = playlist_id.strip()
    
    # Extract ID from full URL
    if 'spotify.com/playlist/' in playlist_id:
        match = re.search(r'playlist/([a-zA-Z0-9]+)', playlist_id)
        if match:
            playlist_id = match.group(1)
    
    # Validate format
    if not re.match(r'^[a-zA-Z0-9]+$', playlist_id):
        return False, "Invalid playlist ID format"
    
    return True, playlist_id

# Use in handlers
@socketio.on('join_room')
def handle_join_room(data):
    pin = data.get('pin', '')
    name = data.get('name', '')
    
    # Validate PIN
    valid, result = validate_pin(pin)
    if not valid:
        emit('error', {'message': result})
        return
    pin = result
    
    # Validate name
    valid, result = validate_name(name)
    if not valid:
        emit('error', {'message': result})
        return
    name = result
    
    # ... continue with join logic ...
```

### 5.3 Logging & Monitoring

**Issue**: Minimal logging, hard to debug production issues.

**Proposal**:
```python
import logging
from logging.handlers import RotatingFileHandler
import sys

def setup_logging(app):
    """Configure application logging"""
    # Create logs directory if it doesn't exist
    if not os.path.exists('logs'):
        os.mkdir('logs')
    
    # File handler with rotation
    file_handler = RotatingFileHandler(
        'logs/blindtest.log',
        maxBytes=10240000,  # 10MB
        backupCount=10
    )
    file_handler.setFormatter(logging.Formatter(
        '%(asctime)s %(levelname)s [%(name)s] %(message)s'
    ))
    file_handler.setLevel(logging.INFO)
    
    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(logging.Formatter(
        '%(levelname)s: %(message)s'
    ))
    console_handler.setLevel(logging.DEBUG if app.debug else logging.INFO)
    
    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    root_logger.addHandler(file_handler)
    root_logger.addHandler(console_handler)
    
    # App logger
    app.logger.setLevel(logging.INFO)
    app.logger.info('Blindtest application starting...')

# Use structured logging
logger = logging.getLogger(__name__)

@socketio.on('create_room')
def handle_create_room(data):
    logger.info(f'Room creation attempt', extra={
        'ip': request.remote_addr,
        'sid': request.sid,
        'playlist_id': data.get('playlist_id')
    })
    
    # ... room creation logic ...
    
    logger.info(f'Room created successfully', extra={
        'pin': pin,
        'host_sid': request.sid,
        'authenticated': token_info is not None
    })
```

---

## 6. TESTING & QUALITY ASSURANCE

### 6.1 Unit Tests

**Proposal - Test Structure**:
```python
# tests/test_room.py
import unittest
from app import Room, generate_pin
from datetime import datetime

class TestRoom(unittest.TestCase):
    def setUp(self):
        self.room = Room('1234', 'host_sid', 'playlist_123')
    
    def test_add_participant(self):
        self.room.add_participant('player1', 'Alice')
        self.assertEqual(len(self.room.participants), 1)
        self.assertEqual(self.room.participants['player1']['name'], 'Alice')
        self.assertEqual(self.room.participants['player1']['score'], 0)
    
    def test_record_answer(self):
        self.room.add_participant('player1', 'Alice')
        self.room.record_answer('player1', 2)
        
        self.assertIn(0, self.room.answers)
        self.assertIn('player1', self.room.answers[0])
        self.assertEqual(self.room.answers[0]['player1']['answer'], 2)
    
    def test_calculate_speed_points(self):
        # Setup question
        self.room.questions = [{
            'track_name': 'Test',
            'correct_answer': 1,
            'correct_artist': 'Test Artist',
            'options': ['A', 'B', 'C', 'D'],
            'colors': ['red', 'blue', 'yellow', 'green']
        }]
        self.room.current_question = self.room.questions[0]
        
        # Add participants and answers
        self.room.add_participant('player1', 'Alice')
        self.room.add_participant('player2', 'Bob')
        
        # Simulate answers with timestamps
        base_time = datetime.now()
        self.room.answers[0] = {
            'player1': {'answer': 1, 'timestamp': base_time},
            'player2': {'answer': 1, 'timestamp': base_time + timedelta(seconds=2)}
        }
        
        # Test scoring
        points1 = self.room.calculate_speed_points('player1')
        points2 = self.room.calculate_speed_points('player2')
        
        self.assertGreater(points1, points2)  # Faster answer gets more points
        self.assertGreaterEqual(points1, 85)  # Min 85% of base (100 * 0.85)
    
    def test_generate_pin_uniqueness(self):
        pins = set()
        for _ in range(100):
            pin = generate_pin()
            self.assertNotIn(pin, pins)
            pins.add(pin)
            self.assertEqual(len(pin), 4)
            self.assertTrue(pin.isdigit())

if __name__ == '__main__':
    unittest.main()
```

### 6.2 Integration Tests

```python
# tests/test_socketio.py
import unittest
from app import app, socketio
from flask_socketio import SocketIOTestClient

class TestSocketIO(unittest.TestCase):
    def setUp(self):
        self.client = SocketIOTestClient(app, socketio)
        self.client.connect()
    
    def tearDown(self):
        self.client.disconnect()
    
    def test_create_and_join_room(self):
        # Host creates room
        self.client.emit('create_room', {'playlist_id': 'test123'})
        received = self.client.get_received()
        
        self.assertEqual(received[0]['name'], 'room_created')
        pin = received[0]['args'][0]['pin']
        
        # Participant joins
        self.client.emit('join_room', {'pin': pin, 'name': 'Alice'})
        received = self.client.get_received()
        
        self.assertEqual(received[0]['name'], 'room_joined')
        self.assertEqual(received[0]['args'][0]['name'], 'Alice')
```

---

## 7. PRIORITIZED IMPLEMENTATION ROADMAP

### Phase 1: Critical Reliability (Week 1)
1. ✅ Memory cleanup for inactive rooms
2. ✅ Error handling for game start failures
3. ✅ Connection resilience with rejoin capability
4. ✅ Rate limiting
5. ✅ Input validation

**Impact**: Prevents crashes, data loss, abuse

### Phase 2: Gameplay Fairness (Week 2)
1. ✅ Client-side timestamps for answers
2. ✅ Tie-breaker mechanism
3. ✅ Progressive difficulty
4. ✅ Streak bonuses

**Impact**: More engaging, fairer competition

### Phase 3: UX Polish (Week 3)
1. ✅ Loading states with progress
2. ✅ Mobile optimizations
3. ✅ Accessibility improvements
4. ✅ Animated score updates
5. ✅ Keyboard shortcuts

**Impact**: Professional feel, better usability

### Phase 4: Production Ready (Week 4)
1. ✅ Configuration management
2. ✅ Comprehensive logging
3. ✅ Database persistence
4. ✅ Health check endpoint
5. ✅ Deployment guide

**Impact**: Scalable, maintainable, monitorable

### Phase 5: Advanced Features (Future)
1. ⏳ Custom game modes (speed round, marathon)
2. ⏳ Team mode (collaborative play)
3. ⏳ Tournament bracket system
4. ⏳ Spotify playlist creation from game
5. ⏳ Social sharing & replay

---

## 8. QUICK WINS (Can Implement Today)

### 1. Add Version to Footer
```html
<!-- In all templates -->
<footer class="text-center text-gray-500 text-sm mt-8">
  MusicQuiz Blindtest v1.0.0 • <a href="/health" class="underline">Status</a>
</footer>
```

### 2. Question Preview Before Start
```javascript
// In host.js after room creation
socket.on('room_created', (data) => {
    // ... existing code ...
    
    // Show preview of first few tracks
    socket.emit('preview_questions', { pin: data.pin, count: 3 });
});

socket.on('question_preview', (data) => {
    // Display: "Your game will include: Track 1, Track 2, Track 3..."
});
```

### 3. Copy PIN Button
```html
<!-- In host.html -->
<button onclick="copyPin()" class="ml-2 px-3 py-1 bg-gray-200 rounded hover:bg-gray-300">
  📋 Copy
</button>

<script>
function copyPin() {
    const pin = document.getElementById('roomPinDisplay').textContent;
    navigator.clipboard.writeText(pin);
    // Show toast notification
}
</script>
```

### 4. Last Played Track History
```python
# Add to Room class
self.track_history = []  # Store last N tracks

# After each question
self.track_history.append({
    'track': self.current_question['track_name'],
    'artist': self.current_question['correct_artist'],
    'question_number': self.question_index + 1
})
```

### 5. "Play Again" with Same Settings
```javascript
// On game end screen
<button onclick="playAgain()" class="btn-primary">
  🔄 Play Again with Same Playlist
</button>

function playAgain() {
    localStorage.setItem('last_playlist', currentPlaylistId);
    location.href = '/host';
}
```

---

## 8. ADVANCED FEATURE: PLAYLIST QUEUE & TOURNAMENT MODE

### 8.1 Multi-Playlist Sequential Games

**Concept**: Allow hosts to queue multiple playlists for consecutive games with cumulative scoring across all games.

**Use Cases**:
- Marathon sessions with genre variety
- Tournament-style competitions
- Progressive difficulty (easy playlist → hard playlist)
- Theme nights (90s → 2000s → 2010s)

**Architecture Overview**:

```python
# Extended Room class for tournaments
class TournamentRoom(Room):
    def __init__(self, pin, host_sid, playlist_queue, token_info=None):
        super().__init__(pin, host_sid, playlist_queue[0], token_info)
        self.playlist_queue = playlist_queue  # List of playlist IDs
        self.current_playlist_index = 0
        self.game_sessions = []  # Track each game's results
        self.cumulative_scores = {}  # player_sid -> total score across all games
        self.tournament_mode = True
        
    def start_next_playlist_game(self):
        """Move to next playlist in queue"""
        self.current_playlist_index += 1
        
        if self.current_playlist_index >= len(self.playlist_queue):
            return False  # Tournament complete
        
        # Save current game session
        self.game_sessions.append({
            'playlist_id': self.playlist_id,
            'questions': self.questions,
            'answers': self.answers,
            'scores': self.get_scores()
        })
        
        # Reset for next game
        self.playlist_id = self.playlist_queue[self.current_playlist_index]
        self.questions = []
        self.question_index = 0
        self.answers = {}
        self.voting_closed = False
        
        # Keep cumulative scores but reset round scores
        for sid in self.participants:
            self.cumulative_scores[sid] = self.cumulative_scores.get(sid, 0) + self.participants[sid]['score']
            self.participants[sid]['score'] = 0
        
        return True  # More games to play
    
    def get_tournament_standings(self):
        """Get overall standings across all games"""
        standings = []
        for sid, participant in self.participants.items():
            total_score = self.cumulative_scores.get(sid, 0) + participant['score']
            standings.append({
                'name': participant['name'],
                'total_score': total_score,
                'games_played': len(self.game_sessions) + 1,
                'current_game_score': participant['score'],
                'sid': sid
            })
        
        standings.sort(key=lambda x: -x['total_score'])
        return standings
```

### 8.2 Frontend: Playlist Queue Selection

**Host Playlist Selection UI Enhancement**:

```html
<!-- In host.html - Enhanced playlist selection -->
<div id="playlistSelector" class="hidden">
  <div class="flex items-center justify-between mb-4">
    <label class="text-lg font-semibold text-gray-800">Select Playlists:</label>
    <div class="flex gap-3">
      <input type="text" id="playlistSearch" placeholder="Search playlists..." 
        class="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary w-64">
      <button id="toggleTournamentMode" onclick="toggleTournamentMode()" 
        class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700">
        <span id="tournamentModeIcon">🏆</span>
        <span id="tournamentModeText">Tournament Mode: OFF</span>
      </button>
    </div>
  </div>

  <!-- Queue Display -->
  <div id="playlistQueue" class="hidden mb-6 p-4 bg-gradient-to-r from-purple-50 to-indigo-50 border-2 border-purple-300 rounded-xl">
    <div class="flex items-center justify-between mb-3">
      <h4 class="font-bold text-gray-800">📋 Playlist Queue (<span id="queueCount">0</span>)</h4>
      <button onclick="clearQueue()" class="text-sm text-red-600 hover:text-red-700">Clear All</button>
    </div>
    <div id="queuedPlaylists" class="flex flex-wrap gap-2"></div>
    <p class="text-sm text-gray-600 mt-2">
      Games will be played sequentially. Scores accumulate across all playlists.
    </p>
  </div>

  <!-- Playlist Grid with multi-select support -->
  <div id="playlistGrid" class="grid grid-cols-1 md:grid-cols-3 gap-4"></div>
</div>
```

**JavaScript Enhancement**:

```javascript
// host.js additions
let tournamentMode = false;
let playlistQueue = [];

function toggleTournamentMode() {
  tournamentMode = !tournamentMode;
  const modeText = document.getElementById('tournamentModeText');
  const queueDisplay = document.getElementById('playlistQueue');
  
  if (tournamentMode) {
    modeText.textContent = 'Tournament Mode: ON';
    queueDisplay.classList.remove('hidden');
  } else {
    modeText.textContent = 'Tournament Mode: OFF';
    queueDisplay.classList.add('hidden');
    playlistQueue = [];
    updateQueueDisplay();
  }
}

function selectPlaylist(playlist) {
  if (tournamentMode) {
    // Multi-select mode
    const index = playlistQueue.findIndex(p => p.id === playlist.id);
    
    if (index >= 0) {
      // Deselect
      playlistQueue.splice(index, 1);
      document.querySelector(`[data-playlist-id="${playlist.id}"]`).classList.remove('selected-queue');
    } else {
      // Add to queue
      playlistQueue.push(playlist);
      document.querySelector(`[data-playlist-id="${playlist.id}"]`).classList.add('selected-queue');
    }
    
    updateQueueDisplay();
  } else {
    // Single select mode (existing behavior)
    selectedPlaylistId = playlist.id;
    // ... existing single selection code ...
  }
}

function updateQueueDisplay() {
  const queueContainer = document.getElementById('queuedPlaylists');
  const queueCount = document.getElementById('queueCount');
  
  queueCount.textContent = playlistQueue.length;
  queueContainer.innerHTML = '';
  
  playlistQueue.forEach((playlist, index) => {
    const badge = document.createElement('div');
    badge.className = 'flex items-center gap-2 bg-white px-3 py-2 rounded-lg shadow-sm border border-purple-200';
    badge.innerHTML = `
      <span class="font-semibold text-purple-600">${index + 1}.</span>
      <span class="text-sm font-medium">${playlist.name}</span>
      <button onclick="removeFromQueue(${index})" class="text-red-500 hover:text-red-700 ml-2">×</button>
    `;
    queueContainer.appendChild(badge);
  });
}

function removeFromQueue(index) {
  const playlist = playlistQueue[index];
  playlistQueue.splice(index, 1);
  
  // Update UI
  document.querySelector(`[data-playlist-id="${playlist.id}"]`).classList.remove('selected-queue');
  updateQueueDisplay();
}

function clearQueue() {
  playlistQueue.forEach(playlist => {
    document.querySelector(`[data-playlist-id="${playlist.id}"]`).classList.remove('selected-queue');
  });
  playlistQueue = [];
  updateQueueDisplay();
}

// Modified create room
createRoomBtn.addEventListener('click', () => {
  if (tournamentMode && playlistQueue.length === 0) {
    showErrorModal('No Playlists Selected', 'Please select at least one playlist for tournament mode.');
    return;
  }
  
  if (!tournamentMode && !selectedPlaylistId) {
    showErrorModal('No Playlist Selected', 'Please select a playlist.');
    return;
  }
  
  const payload = tournamentMode 
    ? { 
        playlist_ids: playlistQueue.map(p => p.id),
        tournament_mode: true 
      }
    : { 
        playlist_id: selectedPlaylistId,
        tournament_mode: false 
      };
  
  socket.emit('create_room', payload);
});
```

### 8.3 Backend Implementation

**Room Creation Handler**:

```python
@socketio.on('create_room')
def handle_create_room(data):
    tournament_mode = data.get('tournament_mode', False)
    pin = generate_pin()
    token_info = session.get('spotify_token') or spotify_tokens.get(request.sid)
    
    if tournament_mode:
        # Create tournament room
        playlist_ids = data.get('playlist_ids', [])
        
        if len(playlist_ids) < 1:
            emit('error', {'message': 'At least one playlist required for tournament'})
            return
        
        room = TournamentRoom(pin, request.sid, playlist_ids, token_info)
    else:
        # Single game room
        playlist_id = data.get('playlist_id', '')
        room = Room(pin, request.sid, playlist_id, token_info)
    
    rooms[pin] = room
    join_room(pin)
    
    emit('room_created', {
        'pin': pin,
        'tournament_mode': tournament_mode,
        'playlist_count': len(playlist_ids) if tournament_mode else 1,
        'authenticated': token_info is not None
    })
```

**Game Transition Handler**:

```python
@socketio.on('next_playlist')
def handle_next_playlist(data):
    """Move to next playlist in tournament"""
    pin = data.get('pin')
    
    if pin not in rooms:
        emit('error', {'message': 'Room not found'})
        return
    
    room = rooms[pin]
    
    if not isinstance(room, TournamentRoom):
        emit('error', {'message': 'Not a tournament room'})
        return
    
    if room.host_sid != request.sid:
        emit('error', {'message': 'Only host can advance'})
        return
    
    # Check if more playlists remain
    has_next = room.start_next_playlist_game()
    
    if has_next:
        # Show inter-game standings
        socketio.emit('inter_game_standings', {
            'current_game': room.current_playlist_index,
            'total_games': len(room.playlist_queue),
            'standings': room.get_tournament_standings(),
            'next_playlist_id': room.playlist_id
        }, room=pin)
        
        # Prepare next game
        emit('preparing_next_game', {
            'game_number': room.current_playlist_index + 1,
            'total_games': len(room.playlist_queue)
        }, room=pin)
        
        # Start next game
        # ... fetch tracks and start game ...
    else:
        # Tournament complete
        socketio.emit('tournament_ended', {
            'final_standings': room.get_tournament_standings(),
            'total_games_played': len(room.game_sessions) + 1,
            'game_history': room.game_sessions
        }, room=pin)
```

### 8.4 Tournament Standings UI

**Inter-Game Standings Modal**:

```html
<!-- In host.html -->
<div id="tournamentStandingsModal" class="modal hidden">
  <div class="modal-backdrop" onclick="closeTournamentStandings()"></div>
  <div class="modal-content max-w-3xl">
    <div class="bg-gradient-to-r from-purple-600 to-indigo-600 text-white px-6 py-4 rounded-t-2xl">
      <h2 class="text-2xl font-bold">🏆 Tournament Standings</h2>
      <p class="text-purple-100">Game <span id="currentGameNum">1</span> of <span id="totalGamesNum">3</span> Complete</p>
    </div>
    
    <div class="p-6">
      <!-- Current Standings -->
      <div class="mb-6">
        <h3 class="text-lg font-bold text-gray-800 mb-3">Overall Standings</h3>
        <div id="tournamentStandingsList" class="space-y-2"></div>
      </div>
      
      <!-- Last Game Stats -->
      <div class="bg-gray-50 rounded-lg p-4">
        <h4 class="font-semibold text-gray-700 mb-2">Last Game Performance</h4>
        <div id="lastGameStats" class="text-sm text-gray-600"></div>
      </div>
      
      <!-- Continue Button (Host Only) -->
      <button id="continueToNextGame" onclick="startNextPlaylist()" 
        class="w-full mt-6 bg-gradient-to-r from-purple-600 to-indigo-600 text-white font-bold py-4 rounded-lg hover:from-purple-700 hover:to-indigo-700">
        Continue to Game <span id="nextGameNum">2</span> 🎵
      </button>
    </div>
  </div>
</div>
```

**JavaScript Tournament Handlers**:

```javascript
// host.js
socket.on('inter_game_standings', (data) => {
  displayTournamentStandings(data);
  
  // Auto-continue after 10 seconds or wait for host click
  let countdown = 10;
  const countdownInterval = setInterval(() => {
    countdown--;
    document.getElementById('continueToNextGame').textContent = 
      `Continue to Game ${data.current_game + 1} (${countdown}s)`;
    
    if (countdown <= 0) {
      clearInterval(countdownInterval);
      startNextPlaylist();
    }
  }, 1000);
});

socket.on('tournament_ended', (data) => {
  displayFinalTournamentResults(data);
});

function displayTournamentStandings(data) {
  const modal = document.getElementById('tournamentStandingsModal');
  const standingsList = document.getElementById('tournamentStandingsList');
  
  document.getElementById('currentGameNum').textContent = data.current_game;
  document.getElementById('totalGamesNum').textContent = data.total_games;
  document.getElementById('nextGameNum').textContent = data.current_game + 1;
  
  // Display standings
  standingsList.innerHTML = '';
  data.standings.forEach((player, index) => {
    const item = document.createElement('div');
    item.className = 'flex items-center justify-between bg-white p-3 rounded-lg shadow-sm';
    item.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="text-2xl font-bold ${index < 3 ? 'text-yellow-500' : 'text-gray-400'}">
          ${index + 1}${index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : ''}
        </span>
        <div>
          <p class="font-semibold">${player.name}</p>
          <p class="text-xs text-gray-500">${player.games_played} games played</p>
        </div>
      </div>
      <div class="text-right">
        <p class="text-2xl font-bold text-purple-600">${player.total_score}</p>
        <p class="text-xs text-gray-500">+${player.current_game_score} this game</p>
      </div>
    `;
    standingsList.appendChild(item);
  });
  
  modal.classList.remove('hidden');
}

function startNextPlaylist() {
  socket.emit('next_playlist', { pin: currentPin });
  document.getElementById('tournamentStandingsModal').classList.add('hidden');
}
```

### 8.5 Database Schema for Tournaments

```python
# Extended schema
c.execute('''
    CREATE TABLE IF NOT EXISTS tournaments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pin TEXT NOT NULL,
        created_at TIMESTAMP,
        ended_at TIMESTAMP,
        total_games INTEGER,
        total_players INTEGER
    )
''')

c.execute('''
    CREATE TABLE IF NOT EXISTS tournament_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tournament_id INTEGER,
        game_number INTEGER,
        playlist_id TEXT,
        questions_count INTEGER,
        FOREIGN KEY (tournament_id) REFERENCES tournaments(id)
    )
''')

c.execute('''
    CREATE TABLE IF NOT EXISTS tournament_participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tournament_id INTEGER,
        name TEXT,
        final_total_score INTEGER,
        games_completed INTEGER,
        FOREIGN KEY (tournament_id) REFERENCES tournaments(id)
    )
''')
```


### 8.6 Benefits & Use Cases

**Benefits**:
1. **Extended Engagement** - Longer gaming sessions with variety
2. **Fair Competition** - More questions = more accurate skill assessment
3. **Progressive Challenge** - Start easy, increase difficulty
4. **Theme Flexibility** - Mix genres, eras, artists
5. **Tournament Format** - Professional competition structure

**Use Cases**:
- **Music Trivia Nights** - Host multi-hour events
- **Office Competitions** - Weekly tournaments with accumulated scores
- **Educational** - Teaching music history through themed playlists
- **Party Mode** - Keep the fun going without manual restarts
- **Streamer Content** - Long-form engaging content for audiences

**Future Enhancements**:
- Bracket elimination (losers drop after each round)
- Team tournaments (2v2, 3v3)
- Handicap system for mixed skill levels
- Playlist recommendations based on performance
- Export tournament results to PDF/CSV

---

## 9. SPOTIFY CONNECT

- play on spotify compatible device instead of browser


## 10. ADD PLAYER AFTER GAME START

- allow player to be added after game is started

## CONCLUSION

Your blindtest application has a **solid foundation** with good architecture and user experience. The proposed improvements focus on:

1. **Reliability**: Prevent memory leaks, handle errors gracefully
2. **Fairness**: Address network latency, add tie-breakers
3. **Engagement**: Progressive difficulty, streaks, better feedback
4. **Professionalism**: Mobile support, accessibility, logging
5. **Scalability**: Database persistence, rate limiting, monitoring
6. **Tournament Mode**: Multi-playlist queuing for extended competitive play

**Recommended Starting Point**: Implement Phase 1 (Critical Reliability) first, then cherry-pick Quick Wins for immediate polish.

**Estimated Total Implementation**: 3-4 weeks for Phases 1-4, assuming 10-15 hours/week.

Let me know which improvements you'd like to tackle first! 🎵
