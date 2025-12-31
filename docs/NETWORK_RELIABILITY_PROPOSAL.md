# Network Reliability Improvements - Event-Driven Architecture

## ✅ TOKEN REFRESH FIX (COMPLETED)

### Issue Found:
The `/me` endpoint (user profile) was **NOT** refreshing expired tokens before making Spotify API calls. This caused `401 "access token expired"` errors.

### Root Cause:
```python
# OLD CODE (BUGGY):
@app.route('/me')
def get_user_profile():
    token_info = session.get('spotify_token')
    sp = spotipy.Spotify(auth=token_info['access_token'])  # ❌ No token refresh!
    user_info = sp.current_user()
```

### Fix Applied:
```python
# NEW CODE (FIXED):
@app.route('/me')
def get_user_profile():
    token_info = session.get('spotify_token')
    
    # ✅ Use get_spotify_client which auto-refreshes
    sp_client, refreshed_token = spotify_oauth_service.get_spotify_client(token_info)
    
    # ✅ Update session with new token
    if refreshed_token and refreshed_token != token_info:
        session['spotify_token'] = refreshed_token
    
    user_info = sp_client.current_user()
```

### Other Endpoints Checked:
- ✅ `/spotify_token` - Already refreshes token
- ✅ `/my_playlists` - Already refreshes token
- ✅ `start_game` socket handler - Already refreshes token during question generation
- ✅ All `spotify_oauth_service` methods - Receive pre-refreshed client

### Token Refresh Flow (Now Consistent):
1. Check if token expired: `sp_oauth.is_token_expired(token_info)`
2. If expired: `sp_oauth.refresh_access_token(token_info['refresh_token'])`
3. Update session/room with new token
4. Use refreshed client for API calls

---

# Network Reliability Improvements - Event-Driven Architecture

## Current Issues with Fixed Timers

### Problem Areas:
1. **0.5s delay before showing correct answer** (line 633 in app.py)
   - Unnecessary fixed delay after timeout
   - Should show immediately when voting closes

2. **1s delay after participant acknowledgments** (line 652 in app.py)
   - Unnecessary fixed delay after all participants acknowledge
   - Should show standings immediately

3. **7s auto-advance on host** (line 571 in host.js)
   - Fixed timer regardless of host readiness
   - Host may not have finished viewing standings
   - Network delay might mean host hasn't even seen standings yet

4. **3s delay on last question end** (line 733 in app.py)
   - Fixed delay before ending game
   - Should wait for acknowledgments instead

5. **Duplicate logic for "all answered" vs "timeout"**
   - When all participants answer, standings show immediately
   - When timeout occurs, there are multiple delays
   - Inconsistent user experience

## Proposed Event-Driven Flow

### 1. Question Timer (KEEP as-is)
- 10 seconds from playback start
- This is the only acceptable fixed timer (game mechanic)

### 2. When Voting Closes (timeout OR all answered)
**Current:**
```
timeout → 0.5s delay → show_correct_answer → wait for acks (max 3s) → 1s delay → show_standings
```

**Proposed:**
```
voting_closed event → show_correct_answer immediately → wait for acks (max 2s) → show_standings immediately
```

**Changes:**
- Remove 0.5s delay (show correct answer immediately)
- Remove 1s delay (show standings immediately after acks)
- Reduce max wait from 3s to 2s (more responsive)
- Unify the flow whether timeout or all-answered

### 3. Standings Display Duration
**Current:**
```
show_standings → 7s fixed delay → next_question
```

**Proposed:**
```
show_standings → host_ack → wait for participant_ready events (max 3s) → next_question
```

**Flow:**
1. Host receives `show_intermediate_scores`
2. Host displays modal and emits `standings_displayed` immediately
3. Server waits for all participants to emit `ready_for_next` (max 3s)
4. Participants auto-emit `ready_for_next` after 5-7 seconds (or immediately if already shown)
5. Server advances to next question when all ready OR timeout

### 4. Unified "All Answered" Flow
**Current Issue:**
- When all answer: immediate standings (no correct answer shown to participants!)
- When timeout: delayed flow with correct answer

**Proposed:**
- Always close voting (set voting_closed flag)
- Always show correct answer to participants
- Always wait for acknowledgments
- Always show standings with same flow

### 5. Last Question End
**Current:**
```
last question all answered → 3s delay → game_ended
```

**Proposed:**
```
last question voted → show_correct_answer → wait for acks → show_final_scores → wait for host_ack → game_ended
```

## Implementation Plan

### Backend Changes (app.py)

#### 1. Extract common "close voting" function:
```python
def close_voting_and_show_answer(pin):
    """Common flow when voting closes (timeout or all answered)"""
    room = rooms[pin]
    room.voting_closed = True
    room.correct_answer_acks = set()
    
    # Notify participants voting is closed
    socketio.emit('voting_closed', {}, room=pin)
    
    # Show correct answer immediately (no delay)
    socketio.emit('show_correct_answer', {
        'correct_answer': room.current_question['correct_answer'],
        'correct_artist': room.current_question['correct_artist']
    }, room=pin)
    
    # Wait for acknowledgments (max 2 seconds, reduced from 3)
    participant_count = len(room.participants)
    max_wait = 2.0
    wait_interval = 0.1
    waited = 0.0
    
    while waited < max_wait and len(room.correct_answer_acks) < participant_count:
        socketio.sleep(wait_interval)
        waited += wait_interval
    
    print(f'Acks: {len(room.correct_answer_acks)}/{participant_count} after {waited:.1f}s')
    
    # Check if last question
    is_last_question = (room.question_index + 1) >= len(room.questions)
    
    if is_last_question:
        # End game - wait for host to acknowledge final scores
        room.state = 'ended'
        socketio.emit('game_ended', {
            'final_scores': room.get_scores()
        }, room=pin)
    else:
        # Show intermediate scores immediately (no additional delay)
        socketio.emit('show_intermediate_scores', {
            'scores': room.get_scores()
        }, room=pin, to=room.host_sid)
```

#### 2. Modify timeout handler:
```python
def question_timeout():
    socketio.sleep(10)
    if pin in rooms and rooms[pin].question_index == current_question_index:
        socketio.emit('question_timeout', {}, room=pin)
        print(f'Question {current_question_index + 1} timeout in room {pin}')
        
        # Use common close voting function (no fixed delays)
        close_voting_and_show_answer(pin)
```

#### 3. Modify "all answered" handler:
```python
# In submit_answer, after checking all answered:
if len(current_answers) == len(room.participants):
    print(f'All participants answered question {room.question_index + 1}')
    
    # Use same flow as timeout (ensures consistency)
    def all_answered_flow():
        socketio.sleep(0)  # Yield to allow last answer to be processed
        if pin in rooms and rooms[pin].question_index == room.question_index:
            close_voting_and_show_answer(pin)
    
    socketio.start_background_task(all_answered_flow)
```

#### 4. Add host acknowledgment tracking:
```python
# Add to Room class:
self.standings_ready_acks = set()  # Track who's ready for next question

# New handler:
@socketio.on('standings_displayed')
def handle_standings_displayed(data):
    pin = data.get('pin')
    if pin in rooms:
        # Host saw standings, now wait for participants to be ready
        rooms[pin].standings_ready_acks = set()
        
        # Wait for participants (max 3 seconds)
        def wait_for_ready():
            max_wait = 3.0
            wait_interval = 0.1
            waited = 0.0
            participant_count = len(rooms[pin].participants)
            
            while waited < max_wait and len(rooms[pin].standings_ready_acks) < participant_count:
                socketio.sleep(wait_interval)
                waited += wait_interval
            
            print(f'Ready: {len(rooms[pin].standings_ready_acks)}/{participant_count}')
            
            # Auto-advance to next question
            socketio.emit('advance_question', {}, room=pin, to=rooms[pin].host_sid)
        
        socketio.start_background_task(wait_for_ready)

@socketio.on('ready_for_next')
def handle_ready_for_next(data):
    pin = data.get('pin')
    sid = request.sid
    if pin in rooms and sid in rooms[pin].participants:
        rooms[pin].standings_ready_acks.add(sid)
```

### Frontend Changes

#### host.js:
```javascript
socket.on('show_intermediate_scores', (data) => {
  // Stop the timer immediately
  stopQuestionTimer();

  // Update intermediate scoreboard
  updateIntermediateScoreboard(data.scores);

  // Show modal with correct answer
  if (standingsModal) {
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
      }, index * 1000);
    });
  }
});

// Server triggers advance when ready
socket.on('advance_question', () => {
  socket.emit('next_question', { pin: currentPin });
});
```

#### participant.js:
```javascript
socket.on('show_correct_answer', (data) => {
  // Display checkmark
  const correctIndex = data.correct_answer;
  answerButtons.forEach((btn, index) => {
    if (index === correctIndex) {
      btn.innerHTML = `
        <span class="text-5xl font-bold">${['A', 'B', 'C', 'D'][index]}</span>
        <span class="text-3xl ml-2">✓</span>
      `;
      btn.style.border = '4px solid white';
    }
  });

  if (!hasAnswered) {
    answerFeedback.classList.remove('hidden');
    answerFeedback.className = 'feedback incorrect';
    answerFeedback.textContent = '⏱ Time\'s up!';
  }

  // Notify server immediately
  socket.emit('correct_answer_displayed', { pin: currentPin });
  
  // After 5-7 seconds, signal ready for next (random to avoid thundering herd)
  const readyDelay = 5000 + Math.random() * 2000;
  setTimeout(() => {
    socket.emit('ready_for_next', { pin: currentPin });
  }, readyDelay);
});
```

## Benefits

### 1. Improved Reliability
- No arbitrary delays that might be too short for slow networks
- Event-driven flow adapts to actual network conditions
- Acknowledgments ensure everyone has seen critical information

### 2. Better User Experience
- Faster flow on good networks (no unnecessary waiting)
- More graceful on bad networks (waits for actual readiness)
- Consistent behavior whether timeout or all-answered

### 3. Reduced Total Time
**Current worst case:** 0.5s + 3s + 1s + 7s = 11.5s between questions
**Proposed typical case:** ~0.1s + 2s + ~0.1s + 5-7s = 7-9s between questions
**Proposed best case:** ~0.1s + 0.2s + ~0.1s + 5s = 5.4s between questions

### 4. Unified Code Paths
- Single flow for closing voting (timeout vs all-answered)
- Easier to maintain and debug
- Consistent experience for players

## Migration Strategy

1. Implement new event handlers alongside old ones
2. Test with feature flag to switch between old/new flows
3. Deploy and monitor with old flow as fallback
4. Switch to new flow after validation
5. Remove old code once stable

## Testing Checklist

- [ ] Test with 1 player
- [ ] Test with 4+ players
- [ ] Simulate slow network (Chrome DevTools throttling)
- [ ] Test all players answer quickly
- [ ] Test mixed timing (some quick, some timeout)
- [ ] Test player disconnection during voting
- [ ] Test last question flow
- [ ] Test rapid succession questions
- [ ] Verify no memory leaks from event listeners
- [ ] Check server logs for timing accuracy

## Risk Analysis

**Low Risk:**
- Backend logic changes are well-contained
- Acknowledgment pattern already proven to work

**Medium Risk:**
- Client-side timeout coordination needs careful testing
- Multiple concurrent WebSocket events need proper sequencing

**Mitigation:**
- Keep max timeout safeguards (prevent infinite waiting)
- Add extensive logging for debugging
- Deploy gradually with monitoring
