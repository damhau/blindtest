import os
import random
import string
from flask import Flask, render_template, request, jsonify, redirect, session
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_cors import CORS
from dotenv import load_dotenv
from datetime import datetime
from spotify_service import get_spotify_service
from spotify_oauth_service import get_spotify_oauth_service
from openai_service import get_openai_service

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', 'dev-secret-key')
app.config['SESSION_COOKIE_SECURE'] = False  # Set to True in production with HTTPS
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
CORS(app, supports_credentials=True)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# Store active rooms and their state
rooms = {}
players = {}  # sid -> player info
spotify_tokens = {}  # sid -> token_info for authenticated hosts

# Initialize services
spotify_service = get_spotify_service()
spotify_oauth_service = get_spotify_oauth_service()
openai_service = get_openai_service()


class Room:
    def __init__(self, pin, host_sid, playlist_id, token_info=None):
        self.pin = pin
        self.host_sid = host_sid
        self.playlist_id = playlist_id
        self.token_info = token_info  # Spotify OAuth token for host
        self.participants = {}  # sid -> {name, score, sid}
        self.current_question = None
        self.question_index = 0
        self.questions = []
        self.state = 'waiting'  # waiting, playing, ended
        self.answers = {}  # question_index -> {sid -> answer}
        self.created_at = datetime.now()
        self.colors = ['red', 'blue', 'yellow', 'green']

    def add_participant(self, sid, name):
        self.participants[sid] = {
            'sid': sid,
            'name': name,
            'score': 0
        }

    def remove_participant(self, sid):
        if sid in self.participants:
            del self.participants[sid]

    def get_scores(self):
        return sorted(
            self.participants.values(),
            key=lambda x: x['score'],
            reverse=True
        )

    def record_answer(self, sid, answer):
        if self.question_index not in self.answers:
            self.answers[self.question_index] = {}
        # Store answer with timestamp
        self.answers[self.question_index][sid] = {
            'answer': answer,
            'timestamp': datetime.now()
        }

    def check_answer(self, sid, answer):
        if self.current_question and answer == self.current_question['correct_answer']:
            # Calculate points based on speed ranking
            base_points = self.calculate_speed_points(sid)
            # Apply multiplier based on song progression
            multiplier = self.get_score_multiplier()
            points = base_points * multiplier
            self.participants[sid]['score'] += points
            return True
        return False
    
    def get_score_multiplier(self):
        """Calculate score multiplier based on song progression
        - First ~50% of songs: 1x
        - Next ~30% of songs: 2x
        - Last ~20% of songs: 4x
        """
        total_songs = len(self.questions)
        current_song = self.question_index + 1  # 1-indexed
        
        # Calculate thresholds
        threshold_2x = int(total_songs * 0.5)  # After 50%
        threshold_4x = int(total_songs * 0.8)  # After 80%
        
        if current_song <= threshold_2x:
            return 1
        elif current_song <= threshold_4x:
            return 2
        else:
            return 4
    
    def calculate_speed_points(self, sid):
        """Calculate points based on answer speed ranking among correct answers"""
        current_answers = self.answers.get(self.question_index, {})
        correct_answer_index = self.current_question['correct_answer']
        
        # Get all correct answers with timestamps
        correct_answers = []
        for player_sid, answer_data in current_answers.items():
            if answer_data['answer'] == correct_answer_index:
                correct_answers.append({
                    'sid': player_sid,
                    'timestamp': answer_data['timestamp']
                })
        
        # Sort by timestamp (fastest first)
        correct_answers.sort(key=lambda x: x['timestamp'])
        
        # Find rank of current player (1-indexed)
        rank = next((i + 1 for i, a in enumerate(correct_answers) if a['sid'] == sid), 1)
        
        # Calculate points: 100 for 1st, halved for each subsequent rank, minimum 10
        base_score = 100
        min_score = 10
        points = base_score / (2 ** (rank - 1))
        
        return max(min_score, round(points))
    
    def generate_question(self, track, fake_artists):
        """Generate a question with correct answer and 3 fake options"""
        correct_artist = track['artist']
        
        # Create options list with correct answer and fakes
        options = [correct_artist] + fake_artists[:3]
        
        # Shuffle options
        random.shuffle(options)
        
        # Find where correct answer ended up
        correct_index = options.index(correct_artist)
        
        question = {
            'track_name': track['name'],
            'preview_url': track.get('preview_url'),
            'track_uri': track.get('uri'),  # Spotify URI for Web Playback SDK
            'options': options,
            'correct_answer': correct_index,
            'correct_artist': correct_artist,
            'colors': self.colors
        }
        
        return question


def generate_pin():
    """Generate a unique 4-digit PIN"""
    while True:
        pin = ''.join(random.choices(string.digits, k=4))
        if pin not in rooms:
            return pin


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/host')
def host():
    return render_template('host.html')


@app.route('/participant')
def participant():
    return render_template('participant.html')


@app.route('/login')
def login():
    """Redirect to Spotify authorization page"""
    if not spotify_oauth_service:
        return jsonify({'error': 'Spotify OAuth not configured'}), 500
    
    auth_url = spotify_oauth_service.get_auth_url()
    return redirect(auth_url)


@app.route('/callback')
def callback():
    """Handle Spotify OAuth callback"""
    if not spotify_oauth_service:
        return "Spotify OAuth not configured", 500
    
    code = request.args.get('code')
    if not code:
        return "Authorization failed", 400
    
    token_info = spotify_oauth_service.get_access_token(code)
    if not token_info:
        return "Failed to get access token", 500
    
    # Store token in session
    session['spotify_token'] = token_info
    session['authenticated'] = True
    
    # Redirect back to host page
    return redirect('/host?authenticated=true')


@app.route('/check_auth')
def check_auth():
    """Check if user is authenticated with Spotify"""
    authenticated = session.get('authenticated', False)
    token_info = session.get('spotify_token')
    
    # Verify token is actually valid, not just that session says it's authenticated
    if authenticated and token_info:
        return jsonify({'authenticated': True})
    else:
        # Clear invalid session
        session.pop('authenticated', None)
        session.pop('spotify_token', None)
        return jsonify({'authenticated': False})


@app.route('/logout')
def logout():
    """Clear Spotify authentication and cache"""
    session.clear()
    
    # Also clear the Spotipy cache file if it exists
    cache_path = '.cache'
    if os.path.exists(cache_path):
        try:
            os.remove(cache_path)
            print(f"Removed cached token at {cache_path}")
        except Exception as e:
            print(f"Could not remove cache file: {e}")
    
    return redirect('/host')


@app.route('/clear_session')
def clear_session():
    """Force clear all session data"""
    session.clear()
    return jsonify({'message': 'Session cleared', 'success': True})


@app.route('/spotify_token')
def get_spotify_token():
    """Get Spotify access token for Web Playback SDK"""
    token_info = session.get('spotify_token')
    
    if not token_info:
        return jsonify({'error': 'Not authenticated'}), 401
    
    # Refresh token if needed
    if spotify_oauth_service and spotify_oauth_service.sp_oauth.is_token_expired(token_info):
        token_info = spotify_oauth_service.sp_oauth.refresh_access_token(token_info['refresh_token'])
        session['spotify_token'] = token_info
    
    return jsonify({
        'access_token': token_info.get('access_token'),
        'expires_in': token_info.get('expires_in')
    })


@app.route('/my_playlists')
def my_playlists():
    """Get user's Spotify playlists"""
    token_info = session.get('spotify_token')
    
    if not token_info or not spotify_oauth_service:
        return jsonify({'error': 'Not authenticated'}), 401
    
    try:
        sp_client, refreshed_token = spotify_oauth_service.get_spotify_client(token_info)
        if not sp_client:
            return jsonify({'error': 'Authentication expired'}), 401
        
        # Update session with refreshed token if changed
        if refreshed_token and refreshed_token != token_info:
            session['token_info'] = refreshed_token
        
        # Get user's playlists with pagination
        playlists = []
        
        # First, add "Liked Songs" as a special collection
        try:
            saved_tracks = sp_client.current_user_saved_tracks(limit=1)
            if saved_tracks and saved_tracks['total'] > 0:
                playlists.append({
                    'id': 'liked-songs',  # Special ID for liked songs
                    'name': 'Liked Songs',
                    'tracks': saved_tracks['total'],
                    'image': 'https://misc.scdn.co/liked-songs/liked-songs-640.png',  # Spotify's liked songs icon
                    'owner': 'You'
                })
        except Exception as e:
            print(f"Could not fetch liked songs: {e}")
        
        # Then get all playlists
        results = sp_client.current_user_playlists(limit=50)
        
        while results:
            for playlist in results['items']:
                if playlist:
                    playlist_name = playlist['name']
                    # print(f"Found playlist: {playlist_name} by {playlist['owner']['display_name']}")
                    playlists.append({
                        'id': playlist['id'],
                        'name': playlist_name,
                        'tracks': playlist['tracks']['total'],
                        'image': playlist['images'][0]['url'] if playlist['images'] else None,
                        'owner': playlist['owner']['display_name']
                    })
            
            # Check if there are more playlists to fetch
            if results['next']:
                print(f"Fetching next page of playlists...")
                results = sp_client.next(results)
            else:
                break
        
        print(f"Loaded {len(playlists)} playlists for user (including Liked Songs)")
        # print(f"Playlist names: {[p['name'] for p in playlists]}")
        return jsonify({'playlists': playlists})
    
    except Exception as e:
        print(f"Error fetching playlists: {e}")
        return jsonify({'error': str(e)}), 500


@socketio.on('connect')
def handle_connect():
    print(f'Client connected: {request.sid}')
    
    # Check if this client has Spotify auth
    token_info = session.get('spotify_token')
    if token_info:
        spotify_tokens[request.sid] = token_info
    
    emit('connected', {'sid': request.sid, 'authenticated': token_info is not None})


@socketio.on('disconnect')
def handle_disconnect():
    print(f'Client disconnected: {request.sid}')
    sid = request.sid
    
    # Check if disconnected user was a host
    room_to_delete = None
    for pin, room in rooms.items():
        if room.host_sid == sid:
            room_to_delete = pin
            # Notify all participants
            socketio.emit('room_closed', {'message': 'Host disconnected'}, room=pin)
            break
        elif sid in room.participants:
            room.remove_participant(sid)
            # Notify host and others about participant leaving
            socketio.emit('participant_left', {
                'participants': list(room.participants.values()),
                'scores': room.get_scores()
            }, room=pin)
            break
    
    if room_to_delete:
        del rooms[room_to_delete]


@socketio.on('create_room')
def handle_create_room(data):
    playlist_id = data.get('playlist_id', '')
    pin = generate_pin()
    
    # Get token info for this host if authenticated
    token_info = spotify_tokens.get(request.sid)
    
    room = Room(pin, request.sid, playlist_id, token_info)
    rooms[pin] = room
    
    join_room(pin)
    
    emit('room_created', {
        'pin': pin,
        'playlist_id': playlist_id,
        'authenticated': token_info is not None
    })
    
    print(f'Room created: {pin} by {request.sid} (OAuth: {token_info is not None})')


@socketio.on('join_room')
def handle_join_room(data):
    pin = data.get('pin', '').strip()
    name = data.get('name', 'Anonymous')
    
    if pin not in rooms:
        emit('error', {'message': 'Room not found'})
        return
    
    room = rooms[pin]
    
    if room.state != 'waiting':
        emit('error', {'message': 'Game already in progress'})
        return
    
    room.add_participant(request.sid, name)
    join_room(pin)
    
    emit('room_joined', {
        'pin': pin,
        'name': name,
        'participants': list(room.participants.values())
    })
    
    # Notify host and other participants
    socketio.emit('participant_joined', {
        'participants': list(room.participants.values()),
        'new_participant': {'name': name, 'sid': request.sid}
    }, room=pin, skip_sid=request.sid)
    
    print(f'Player {name} joined room {pin}')


@socketio.on('start_game')
def handle_start_game(data):
    import random
    
    pin = data.get('pin')
    song_count = data.get('song_count', 10)  # Default to 10 if not provided
    
    # Validate song count
    song_count = max(5, min(30, song_count))  # Clamp between 5 and 30

    print(f'Starting game in room {pin} with {song_count} songs')
    
    if pin not in rooms:
        emit('error', {'message': 'Room not found'})
        return
    
    room = rooms[pin]
    
    if room.host_sid != request.sid:
        emit('error', {'message': 'Only host can start the game'})
        return
    
    # Use OAuth service if host is authenticated, otherwise fall back to basic service
    if room.token_info and spotify_oauth_service:
        # Host is authenticated - use OAuth service for full playback
        sp_client, refreshed_token = spotify_oauth_service.get_spotify_client(room.token_info)
        if not sp_client:
            emit('error', {'message': 'Spotify authentication expired. Please log in again.'})
            return
        
        # Update room token if refreshed
        if refreshed_token:
            room.token_info = refreshed_token
        
        # Fetch more tracks than needed to randomize from
        tracks, error = spotify_oauth_service.get_playlist_tracks(sp_client, room.playlist_id, limit=50)
    elif spotify_service:
        # Fall back to basic service (preview URLs only)
        tracks, error = spotify_service.get_playlist_tracks(room.playlist_id, limit=50)
    else:
        emit('error', {'message': 'Spotify service not configured. Check your .env file.'})
        return
    
    if error:
        emit('error', {'message': error})
        return
    
    if not tracks:
        emit('error', {'message': 'No tracks found in playlist. Try a different playlist with more songs.'})
        return
    
    # Randomize and select the requested number of songs
    random.shuffle(tracks)
    tracks = tracks[:song_count]
    
    # Check audio availability
    tracks_with_audio = sum(1 for t in tracks if t.get('preview_url'))
    
    # Only block if no auth AND no previews
    if not room.token_info and tracks_with_audio == 0:
        emit('error', {'message': 'No tracks in this playlist have audio previews. Please login with Spotify or try a different playlist.'})
        return
    
    # Warn about limited audio (but allow to continue if authenticated)
    if tracks_with_audio < len(tracks):
        print(f"Warning: Only {tracks_with_audio}/{len(tracks)} tracks have preview URLs")
        if room.token_info:
            print(f"User is authenticated - allowing game to proceed without preview URLs")
    
    # Generate questions with fake artists
    total_tracks = len(tracks)
    for idx, track in enumerate(tracks, 1):
        # Emit progress update
        socketio.emit('question_progress', {
            'current': idx,
            'total': total_tracks
        }, room=pin)
        
        # Yield control to allow event to be sent immediately
        socketio.sleep(0)
        
        if openai_service:
            print(f"Using OpenAI to generate fake artists for track: {track['name']}")
            fake_artists = openai_service.generate_fake_artists(track['artist'], count=3)
        else:
            # Fallback: use similar artists from Spotify
            if room.token_info and spotify_oauth_service:
                print(f"Using get_similar_artists to generate fake artists for track: {track['name']}")
                sp_client, refreshed_token = spotify_oauth_service.get_spotify_client(room.token_info)
                if refreshed_token:
                    room.token_info = refreshed_token
                fake_artists = spotify_oauth_service.get_similar_artists(sp_client, track['artist'], limit=3)
            elif spotify_service:
                print(f"Using get_similar_artists to generate fake artists")
                fake_artists = spotify_service.get_similar_artists(track['artist'], limit=3)
            else:
                fake_artists = []
            
            if len(fake_artists) < 3:
                # Ultimate fallback
                fake_artists += [f"Artist {i}" for i in range(3 - len(fake_artists))]
        
        question = room.generate_question(track, fake_artists)
        room.questions.append(question)
    
    room.state = 'playing'
    room.question_index = 0
    room.current_question = room.questions[0]
    
    # Notify all players game is starting
    socketio.emit('game_started', {
        'total_songs': len(room.questions),
        'has_oauth': room.token_info is not None
    }, room=pin)
    
    # Send first question
    send_question(pin)
    
    print(f'Game started in room {pin} with {len(room.questions)} questions (OAuth: {room.token_info is not None})')


def send_question(pin):
    """Send current question to all players in room"""
    room = rooms[pin]
    question = room.current_question
    
    # Send to host with all details
    host_data = {
        'question_number': room.question_index + 1,
        'total_questions': len(room.questions),
        'track_name': question['track_name'],
        'preview_url': question.get('preview_url'),
        'track_uri': question.get('track_uri'),  # For Spotify Web Playback SDK
        'options': question['options'],
        'correct_answer': question['correct_answer'],  # Index of correct answer for debugging
        'colors': question['colors'],
        'multiplier': room.get_score_multiplier(),  # Current score multiplier
        'has_oauth': room.token_info is not None
    }
    
    socketio.emit('new_question', host_data, room=pin, to=room.host_sid)
    
    # Send to participants (only colors, no artist names)
    socketio.emit('new_question_participant', {
        'question_number': room.question_index + 1,
        'total_questions': len(room.questions),
        'colors': question['colors']
    }, room=pin, skip_sid=room.host_sid)


@socketio.on('submit_answer')
def handle_submit_answer(data):
    pin = data.get('pin')
    answer = data.get('answer')  # Index of selected option (0-3)
    
    if pin not in rooms:
        emit('error', {'message': 'Room not found'})
        return
    
    room = rooms[pin]
    
    if request.sid not in room.participants:
        emit('error', {'message': 'You are not in this game'})
        return
    
    # Record answer
    room.record_answer(request.sid, answer)
    
    # Check if correct
    is_correct = room.check_answer(request.sid, answer)
    
    # Send feedback to player
    emit('answer_feedback', {
        'correct': is_correct,
        'your_score': room.participants[request.sid]['score']
    })
    
    # Update scores for everyone
    socketio.emit('scores_updated', {
        'scores': room.get_scores()
    }, room=pin)
    
    print(f'Player {room.participants[request.sid]["name"]} answered: {answer} ({"correct" if is_correct else "incorrect"})')
    
    # Check if all participants have answered
    current_answers = room.answers.get(room.question_index, {})
    if len(current_answers) == len(room.participants):
        print(f'All {len(room.participants)} participants have answered question {room.question_index + 1}')
        
        # Check if this is the last question
        is_last_question = (room.question_index + 1) >= len(room.questions)
        
        if is_last_question:
            # Last question - end the game directly after showing correct answer
            # Wait a moment for correct answer to be shown
            def end_game_after_delay():
                socketio.sleep(3)  # Wait 3 seconds to show correct answer
                room.state = 'ended'
                socketio.emit('game_ended', {
                    'final_scores': room.get_scores()
                }, room=pin)
                print(f'Game ended in room {pin}')
            
            socketio.start_background_task(end_game_after_delay)
        else:
            # Show intermediate scores to host only
            socketio.emit('show_intermediate_scores', {
                'scores': room.get_scores()
            }, room=pin, to=room.host_sid)


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
    
    # Reveal correct answer
    socketio.emit('show_correct_answer', {
        'correct_answer': room.current_question['correct_answer'],
        'correct_artist': room.current_question['correct_artist']
    }, room=pin)
    
    # Move to next question
    room.question_index += 1
    
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


@socketio.on('end_game')
def handle_end_game(data):
    pin = data.get('pin')
    
    if pin not in rooms:
        emit('error', {'message': 'Room not found'})
        return
    
    room = rooms[pin]
    
    if room.host_sid != request.sid:
        emit('error', {'message': 'Only host can end the game'})
        return
    
    room.state = 'ended'
    socketio.emit('game_ended', {
        'final_scores': room.get_scores()
    }, room=pin)


if __name__ == '__main__':
    socketio.run(app, debug=True, host='0.0.0.0', port=8000)
