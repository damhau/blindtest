# Complete Event Workflow Analysis

## Current Flow from Question Start to Next Question

### Phase 1: Question Timer (10 seconds)
```
T=0s: Host emits 'playback_started'
      ↓
      Server receives, starts 10-second timer
      Server emits 'start_question_timer' to all
      ↓
T=0-10s: Participants answer
         - Each answer triggers 'submit_answer'
         - Server updates scores
         - Emits 'scores_updated' to room
```

### Phase 2A: Timeout Path (if timer expires)
```
T=10s: Timer expires
       ↓
       Server emits 'question_timeout' to all participants
       Server calls close_voting_and_show_answer(pin)
```

### Phase 2B: All Answered Path (if everyone answers before timeout)
```
T=<10s: Last participant answers
        ↓
        Server detects all answered
        Server calls close_voting_and_show_answer(pin)
```

### Phase 3: Close Voting (UNIFIED)
```
close_voting_and_show_answer() function:
├─ Set voting_closed = True
├─ Reset correct_answer_acks = set()
├─ Emit 'show_correct_answer' to all participants
│  └─ Participants display checkmark
│     └─ Immediately emit 'correct_answer_displayed'
│     └─ After 5 seconds, emit 'ready_for_next'
│
└─ Wait for participant acknowledgments (max 2 seconds)
   ├─ While loop checking correct_answer_acks
   └─ Exit when: all ack'd OR 2 seconds elapsed
```

### Phase 4: Show Standings to Host
```
After Phase 3 completes:
├─ Server emits 'show_intermediate_scores' to HOST ONLY
│
Host receives 'show_intermediate_scores':
├─ Stop timer
├─ Update scoreboard
├─ Show standings modal (classList.remove('hidden'))
└─ Immediately emit 'standings_displayed' to server
```

### Phase 5: Wait for Participants Ready
```
Server receives 'standings_displayed':
├─ Reset standings_ready_acks = set()
└─ Start background task wait_for_ready():
   ├─ While loop (max 10 seconds)
   │  └─ Check if all participants sent 'ready_for_next'
   │  └─ Exit when: all ready OR 10 seconds elapsed
   │
   └─ Emit 'advance_question' to HOST ONLY

Host receives 'advance_question':
└─ Emit 'next_question' to server
```

### Phase 6: Next Question
```
Server receives 'next_question':
├─ ⚠️ PROBLEM: Emits 'show_correct_answer' AGAIN! (duplicate)
├─ Increment question_index
├─ Reset voting_closed = False
└─ Send next question (new_question event)
```

## 🔴 IDENTIFIED PROBLEM

### Issue 1: Duplicate 'show_correct_answer' Event
**Location:** `handle_next_question()` at line ~823
```python
# Reveal correct answer  <-- ⚠️ Already shown in Phase 3!
socketio.emit('show_correct_answer', {
    'correct_answer': room.current_question['correct_answer'],
    'correct_artist': room.current_question['correct_artist']
}, room=pin)
```

**Impact:** 
- Participants see checkmark appear AGAIN when standings close
- This triggers ANOTHER 5-second timer on participants
- Causes confusion and timing issues

### Issue 2: Standings Modal May Close Immediately
**Root Cause:** Race condition in timing

**Scenario:**
1. T=0s: All participants answer quickly (all acknowledged by T=0.2s)
2. T=0.2s: Host gets standings, emits `standings_displayed`
3. T=0.2s: Server starts 10-second wait
4. T=5.2s: Participants emit `ready_for_next` (5s after their checkmark)
5. T=5.2s: Server receives all ready signals immediately
6. T=5.2s: Server emits `advance_question` → Host closes modal

**Result:** Modal only displayed for **5 seconds** instead of intended longer time

### Issue 3: No Reset of Participant Timers
When `new_question_participant` event is sent, the participant's setTimeout from previous `show_correct_answer` is still running if new question arrives before 5 seconds.

## 🟢 RECOMMENDED FIXES

### Fix 1: Remove Duplicate show_correct_answer
```python
@socketio.on('next_question')
def handle_next_question(data):
    pin = data.get('pin')
    
    if pin not in rooms:
        emit('error', {'message': 'Room not found'})
        return
    
    room = rooms[pin]
    
    if room.host_sid != request.sid:
        emit('error', {'message': 'Only host can advance questions'})
        return
    
    # ❌ REMOVE THIS - already shown in close_voting_and_show_answer()
    # socketio.emit('show_correct_answer', {
    #     'correct_answer': room.current_question['correct_answer'],
    #     'correct_artist': room.current_question['correct_artist']
    # }, room=pin)
    
    # Move to next question
    room.question_index += 1
    room.voting_closed = False  # ✅ ADD: Reset for next question
    
    if room.question_index >= len(room.questions):
        # Game over
        room.state = 'ended'
        socketio.emit('game_ended', {
            'final_scores': room.get_scores()
        }, room=pin)
        print(f'Game ended in room {pin}')
    else:
        # Next question
        room.current_question = room.questions[room.question_index]
        send_question(pin)
```

### Fix 2: Add Minimum Standings Display Time
Instead of advancing as soon as all participants are ready, enforce a minimum display time.

```python
@socketio.on('standings_displayed')
def handle_standings_displayed(data):
    pin = data.get('pin')
    
    if pin not in rooms:
        return
    
    print(f'Host displayed standings for room {pin}')
    
    # Reset ready acknowledgments
    rooms[pin].standings_ready_acks = set()
    
    # Record when standings were displayed
    import time
    standings_shown_at = time.time()
    
    # Wait for participants to be ready
    def wait_for_ready():
        min_display_time = 7.0  # Minimum 7 seconds display
        max_wait = 10.0
        wait_interval = 0.1
        waited = 0.0
        participant_count = len(rooms[pin].participants)
        
        # Wait for participants to be ready
        while waited < max_wait and len(rooms[pin].standings_ready_acks) < participant_count:
            socketio.sleep(wait_interval)
            waited += wait_interval
        
        # Ensure minimum display time
        elapsed = time.time() - standings_shown_at
        if elapsed < min_display_time:
            remaining = min_display_time - elapsed
            print(f'Enforcing minimum display time, waiting {remaining:.1f}s more')
            socketio.sleep(remaining)
        
        ack_count = len(rooms[pin].standings_ready_acks)
        total_time = time.time() - standings_shown_at
        print(f'Ready for next: {ack_count}/{participant_count} after {total_time:.1f}s total')
        
        # Auto-advance to next question
        socketio.emit('advance_question', {}, room=pin, to=rooms[pin].host_sid)
    
    socketio.start_background_task(wait_for_ready)
```

### Fix 3: Clear Participant Timers on New Question
```javascript
// participant.js
let readyForNextTimer = null;

socket.on('show_correct_answer', (data) => {
  // Clear any existing timer
  if (readyForNextTimer) {
    clearTimeout(readyForNextTimer);
  }
  
  // ... display checkmark code ...
  
  // Notify server that correct answer has been displayed
  socket.emit('correct_answer_displayed', { pin: currentPin });

  // After 5 seconds, signal ready for next
  readyForNextTimer = setTimeout(() => {
    socket.emit('ready_for_next', { pin: currentPin });
    readyForNextTimer = null;
  }, 5000);
});

socket.on('new_question_participant', (data) => {
  hasAnswered = false;

  // Clear ready timer if still running
  if (readyForNextTimer) {
    clearTimeout(readyForNextTimer);
    readyForNextTimer = null;
  }

  // Reset buttons...
});
```

## 📊 TIMING COMPARISON

### Current (Buggy):
```
All answer quickly:
T=0-0.2s: Participants answer
T=0.2s:   Acks received, host shows standings
T=5.2s:   Participants ready, standings close
Result: 5 SECOND STANDINGS DISPLAY

Timeout scenario:
T=10s:    Timer expires
T=10.2s:  Acks received, host shows standings  
T=15.2s:  Participants ready, standings close
Result: 5 SECOND STANDINGS DISPLAY
```

### Fixed (With 7s Minimum):
```
All answer quickly:
T=0-0.2s: Participants answer
T=0.2s:   Acks received, host shows standings
T=5.2s:   Participants ready
T=7.2s:   Min time reached, standings close
Result: 7 SECOND STANDINGS DISPLAY ✅

Timeout scenario:
T=10s:    Timer expires
T=10.2s:  Acks received, host shows standings
T=15.2s:  Participants ready (5s after ack)
T=17.2s:  Min time reached, standings close
Result: 7 SECOND STANDINGS DISPLAY ✅
```

## 🎯 SUMMARY OF CHANGES NEEDED

1. **Remove duplicate `show_correct_answer` in `handle_next_question()`**
2. **Add minimum 7-second display time for standings modal**
3. **Clear participant `ready_for_next` timer when new question arrives**
4. **Add `voting_closed = False` reset in `handle_next_question()`**

These changes will ensure:
- ✅ Standings always visible for at least 7 seconds
- ✅ No duplicate checkmark displays
- ✅ Cleaner event flow
- ✅ More reliable timing on all network conditions
