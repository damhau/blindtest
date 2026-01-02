import eventlet
eventlet.monkey_patch()
import eventlet.tpool as tpool

import os
import random
import string
import time
import re
from flask import Flask, render_template, request, jsonify, redirect, session
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_cors import CORS
from dotenv import load_dotenv
from datetime import datetime
import musicbrainzngs


_MB_ARTIST_POOL = []
_MB_ARTIST_POOL_LAST_REFRESH = 0.0
from libs.spotify_service import get_spotify_service
from libs.spotify_oauth_service import get_spotify_oauth_service
from libs.openai_service import get_openai_service

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


def _mb_norm_name(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "")).strip().lower()


def _mb_refresh_artist_pool() -> list:
    """Fetch a small pool of real artist names from MusicBrainz.

    Best-effort: returns an empty list on failure.
    """

    if not musicbrainzngs:
        return []

    # Keep it simple + lightweight: query a few random prefixes and merge results.
    letters = list("abcdefghijklmnopqrstuvwxyz")
    prefixes = random.sample(letters, k=3)
    names = []

    for prefix in prefixes:
        try:
            res = musicbrainzngs.search_artists(artist=prefix, limit=60)
            for artist in (res or {}).get("artist-list", []) or []:
                name = (artist or {}).get("name")
                if name:
                    names.append(str(name).strip())
        except Exception:
            continue

    # De-dupe while preserving order; filter out garbage.
    out = []
    seen = set()
    for n in names:
        nn = _mb_norm_name(n)
        if not nn or nn in seen:
            continue
        if len(n) > 60:
            continue
        seen.add(nn)
        out.append(n)

    random.shuffle(out)
    return out


def _mb_pick_fallback_artist(avoid_norm_list: list) -> str:
    """Return one artist name from MusicBrainz not in avoid list, else empty string."""

    global _MB_ARTIST_POOL, _MB_ARTIST_POOL_LAST_REFRESH

    if not musicbrainzngs:
        return ""

    avoid_norm = set(avoid_norm_list or [])
    now = time.time()

    # Refresh at most once per hour, and only if pool looks depleted.
    if (not _MB_ARTIST_POOL) or (now - _MB_ARTIST_POOL_LAST_REFRESH > 3600):
        _MB_ARTIST_POOL = _mb_refresh_artist_pool()
        _MB_ARTIST_POOL_LAST_REFRESH = now

    # Try a few random picks.
    for _ in range(50):
        if not _MB_ARTIST_POOL:
            break
        name = random.choice(_MB_ARTIST_POOL)
        if _mb_norm_name(name) not in avoid_norm:
            return name

    return ""


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
        self.voting_closed = False  # Track if current question voting is closed
        self.correct_answer_acks = set()  # Track participants who saw the correct answer
        self.standings_ready_acks = set()  # Track participants ready for next question
        self.created_at = datetime.now()
        self.colors = ['red', 'blue', 'yellow', 'green']
        self.question_start_scores = {}  # Track scores at start of each question
        self.question_start_time = None  # Track when current question started
        # Series tracking
        self.games_in_series = 1  # Total number of games to play
        self.current_game_number = 1  # Current game (1-indexed)
        self.series_scores = {}  # sid -> cumulative score across all games
        self.all_questions = []  # All questions for all games
        self.game_questions_map = {}  # game_number -> list of question indices
        # Host reconnection tracking
        self.host_disconnected = False
        self.host_disconnect_time = None

    def add_participant(self, sid, name):
        self.participants[sid] = {
            'sid': sid,
            'name': name,
            'score': 0
        }
        # Initialize series score for new participant
        if sid not in self.series_scores:
            self.series_scores[sid] = 0

    def remove_participant(self, sid):
        if sid in self.participants:
            del self.participants[sid]

    def get_scores(self):
        return sorted(
            self.participants.values(),
            key=lambda x: x['score'],
            reverse=True
        )
    
    def get_series_scores(self):
        """Get cumulative scores across all games in series"""
        series_scores_list = []
        for sid, player in self.participants.items():
            series_scores_list.append({
                'sid': sid,
                'name': player['name'],
                'series_score': self.series_scores.get(sid, 0),
                'game_score': player['score']
            })
        return sorted(series_scores_list, key=lambda x: x['series_score'], reverse=True)

    def record_answer(self, sid, answer, client_timestamp=None):
        if self.question_index not in self.answers:
            self.answers[self.question_index] = {}
        
        # Use client timestamp if provided (for fairness), otherwise server time
        if client_timestamp:
            try:
                # Parse ISO format timestamp from client and make timezone-naive
                timestamp = datetime.fromisoformat(client_timestamp.replace('Z', '+00:00'))
                # Strip timezone info to match server's naive datetime
                timestamp = timestamp.replace(tzinfo=None)
            except (ValueError, AttributeError):
                # Fallback to server time if parsing fails
                timestamp = datetime.now()
        else:
            timestamp = datetime.now()
        
        # Store answer with timestamp
        self.answers[self.question_index][sid] = {
            'answer': answer,
            'timestamp': timestamp,
            'server_received': datetime.now(),  # For debugging/validation
            'used_client_time': client_timestamp is not None
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
        """Calculate points based on ranking and response time
        
        Scoring formula:
        1. Base score from ranking: S × (1 - α × (rank - 1))
           - S = 100 points (max)
           - α = 0.10 (10% decay per rank)
           - Example: 1st=100pts, 2nd=90pts, 3rd=80pts
        
        2. Time coefficient: max(1 - β × (delta_t / T), factor_min)
           - β = 0.12 (12% max penalty)
           - T = 15 seconds (time window)
           - factor_min = 0.85 (max 15% time penalty)
           - delta_t = player_time - fastest_time
        
        3. Final score: base_score × time_factor
        """
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
        
        # STEP 1: Base score from ranking
        S = 100  # Maximum score
        alpha = 0.10  # 10% decay per rank
        score_base = S * (1 - alpha * (rank - 1))
        
        # STEP 2: Time-based coefficient
        # Get player's response time
        player_time = next((a['timestamp'] for a in correct_answers if a['sid'] == sid), 0)
        # Get fastest response time
        t_min = correct_answers[0]['timestamp'] if correct_answers else 0
        
        # Calculate time delta in seconds
        delta_t = (player_time - t_min).total_seconds()
        
        # Time parameters
        T = 15  # Time window in seconds
        beta = 0.12  # 12% max penalty over full window
        factor_min = 0.85  # Minimum factor (max 15% time penalty)
        
        # Calculate time factor with floor
        facteur_temps = max(1 - beta * (delta_t / T), factor_min)
        
        # STEP 3: Final score
        final_score = score_base * facteur_temps
        
        return round(final_score)
    
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
    print(f"User authenticated with Spotify, token expires at {token_info.get('expires_at')}")
    print(f"Access token last 10 chars: {token_info.get('access_token')[-10:]}")
    print(f"Refresh token last 10 chars: {token_info.get('refresh_token')[-10:]}")
    session['authenticated'] = True
    
    # Redirect back to host page
    return redirect('/?authenticated=true')


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


@app.route('/me')
def get_user_profile():
    """Get current Spotify user profile"""
    token_info = session.get('spotify_token')
    if not token_info:
        return jsonify({'error': 'Not authenticated'}), 401
    
    if not spotify_oauth_service:
        return jsonify({'error': 'Spotify OAuth service not available'}), 500
    
    try:
        # Refresh token if needed
        sp_client, refreshed_token = spotify_oauth_service.get_spotify_client(token_info)
        if not sp_client:
            return jsonify({'error': 'Authentication expired'}), 401
        
        # Update session with refreshed token
        if refreshed_token and refreshed_token != token_info:
            session['spotify_token'] = refreshed_token
        
        user_info = sp_client.current_user()
        return jsonify(user_info)
    except Exception as e:
        print(f"Error fetching user profile: {e}")
        return jsonify({'error': 'Failed to fetch user profile'}), 500


@app.route('/logout')
def logout():
    """Clear Spotify authentication and cache"""
    session.clear()
    
    # Also clear Spotipy cache files if they exist
    # - SpotifyOAuthService uses cache_path=".spotify_cache"
    # - Some Spotipy flows default to ".cache"
    for cache_path in ('.spotify_cache', '.cache'):
        if os.path.exists(cache_path):
            try:
                os.remove(cache_path)
                print(f"Removed cached token at {cache_path}")
            except Exception as e:
                print(f"Could not remove cache file {cache_path}: {e}")
    
    return redirect('/')


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
        print(f"Access token expired, refreshing...")
        token_info = spotify_oauth_service.sp_oauth.refresh_access_token(token_info['refresh_token'])
        session['spotify_token'] = token_info
    
    return jsonify({
        'access_token': token_info.get('access_token'),
        'expires_in': token_info.get('expires_in')
    })

@app.route('/api/user/profile')
def get_user_profile_api():
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
        try:
            top_artists = sp_client.current_user_top_artists(limit=5, time_range='medium_term')
        except Exception as e:
            print(f"Error fetching top artists: {e}")
            top_artists = None
        
        # Get user's saved tracks count
        try:
            saved_tracks = sp_client.current_user_saved_tracks(limit=1)
        except Exception as e:
            print(f"Error fetching saved tracks: {e}")
            saved_tracks = None
        
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
            session['spotify_token'] = refreshed_token
        
        # Get user's playlists with pagination
        playlists = []
        
        
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
    
    # Check if disconnected user was a host or participant
    for pin, room in rooms.items():
        if room.host_sid == sid:
            # Mark host as disconnected instead of deleting room immediately
            room.host_disconnected = True
            room.host_disconnect_time = time.time()
            
            print(f"Host disconnected from room {pin}, grace period for reconnection")
            
            # Notify all participants that host is temporarily disconnected
            socketio.emit('host_disconnected', {
                'message': 'Host disconnected. Waiting for reconnection...'
            }, room=pin)
            break
        elif sid in room.participants:
            # Mark participant as disconnected instead of removing immediately
            # This allows them to reconnect within a grace period
            participant = room.participants[sid]
            participant['disconnected'] = True
            participant['disconnect_time'] = time.time()
            
            print(f"Participant {participant['name']} marked as disconnected, grace period for reconnection")
            
            # Notify host and others about participant disconnection
            socketio.emit('participant_disconnected', {
                'name': participant['name'],
                'participants': list(room.participants.values())
            }, room=pin)
            break


@socketio.on('create_room')
def handle_create_room(data):
    playlist_id = data.get('playlist_id', '')
    pin = generate_pin()
    
    # Get token info for this host if authenticated.
    # Prefer the current session token (so logout/login updates take effect immediately).
    token_info = session.get('spotify_token') or spotify_tokens.get(request.sid)
    
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
    
    # Allow joining during game (they'll participate from next question)
    is_mid_game = room.state == 'playing'
    
    room.add_participant(request.sid, name)
    join_room(pin)
    
    # Prepare response data
    response_data = {
        'pin': pin,
        'name': name,
        'participants': list(room.participants.values())
    }
    
    # If joining mid-game, send current game state
    if is_mid_game:
        response_data['mid_game'] = True
        response_data['current_question'] = room.question_index + 1
        response_data['total_questions'] = len(room.questions)
        response_data['current_scores'] = room.get_scores()
        print(f'Player {name} joined room {pin} mid-game (question {room.question_index + 1}/{len(room.questions)})')
    else:
        response_data['mid_game'] = False
        print(f'Player {name} joined room {pin}')
    
    emit('room_joined', response_data)
    
    # Notify host and other participants
    socketio.emit('participant_joined', {
        'participants': list(room.participants.values()),
        'new_participant': {'name': name, 'sid': request.sid}
    }, room=pin, skip_sid=request.sid)


@socketio.on('rejoin_room')
def handle_rejoin(data):
    """Handle participant/host attempting to rejoin after disconnect"""
    pin = data.get('pin')
    name = data.get('name')
    was_host = data.get('was_host', False)
    
    print(f'Rejoin attempt - PIN: {pin}, Name: {name}, Was Host: {was_host}')
    
    if pin not in rooms:
        emit('rejoin_failed', {'message': 'Room no longer exists'})
        return
    
    room = rooms[pin]
    
    if was_host:
        # Host reconnecting with new SID
        print(f'Host rejoining room {pin} with new SID {request.sid} (old: {room.host_sid})')
        
        # Update host SID and clear disconnected flags
        old_host_sid = room.host_sid
        room.host_sid = request.sid
        room.host_disconnected = False
        room.host_disconnect_time = None
        
        # Join the socket room
        join_room(pin)
        
        # Send success with current game state
        response_data = {
            'success': True,
            'state': room.state,
            'participants': list(room.participants.values())
        }
        
        # If game is in progress, send current question info
        if room.state == 'playing':
            response_data['current_question'] = room.current_question
            response_data['question_number'] = room.question_index + 1
            response_data['total_questions'] = len(room.questions)
            response_data['voting_closed'] = room.voting_closed
            
            # If voting is closed and all participants have acknowledged, auto-advance
            if room.voting_closed and len(room.standings_ready_acks) == len(room.participants):
                response_data['should_advance'] = True
        
        emit('rejoin_success', response_data)
        
        # Notify participants that host has reconnected
        socketio.emit('host_reconnected', {
            'message': 'Host reconnected'
        }, room=pin, skip_sid=request.sid)
        
        print(f'Host successfully rejoined room {pin}')
        
    else:
        # Regular participant rejoining
        # Find participant by name (they might have a new SID)
        old_sid = None
        for sid, participant in room.participants.items():
            if participant['name'] == name:
                old_sid = sid
                break
        
        if old_sid:
            print(f'Participant {name} rejoining room {pin} with new SID {request.sid} (old: {old_sid})')
            
            # Preserve the participant's score
            old_participant_data = room.participants[old_sid]
            current_score = old_participant_data['score']
            
            # Remove old SID entry
            del room.participants[old_sid]
            
            # Add with new SID, preserving score
            room.participants[request.sid] = {
                'sid': request.sid,
                'name': name,
                'score': current_score,
                'disconnected': False  # Clear disconnected flag
            }
            
            # Preserve series score if exists
            if old_sid in room.series_scores:
                room.series_scores[request.sid] = room.series_scores[old_sid]
                del room.series_scores[old_sid]
            
            # Transfer answers if in middle of question
            if room.question_index in room.answers and old_sid in room.answers[room.question_index]:
                room.answers[room.question_index][request.sid] = room.answers[room.question_index][old_sid]
                del room.answers[room.question_index][old_sid]
            
            # Join the socket room
            join_room(pin)
            
            # Send success with preserved score
            emit('rejoin_success', {
                'success': True,
                'current_score': current_score,
                'state': room.state
            })
            
            # Notify others about the reconnection
            socketio.emit('participant_reconnected', {
                'name': name,
                'participants': list(room.participants.values())
            }, room=pin, skip_sid=request.sid)
            
            print(f'Participant {name} successfully rejoined room {pin} with score {current_score}')
        else:
            # Participant not found - treat as new join
            print(f'Participant {name} not found in room {pin}, treating as new join')
            emit('rejoin_failed', {'message': 'Participant not found in room. Please join as new player.'})


@socketio.on('start_game')
def handle_start_game(data):
    import random
    import re
    
    pin = data.get('pin')
    song_count = data.get('song_count', 10)  # Default to 10 if not provided
    games_count = data.get('games_count', 1)  # Default to 1 game
    
    # Validate counts
    song_count = max(1, min(30, song_count))  # Clamp between 1 and 30
    games_count = max(1, min(5, games_count))  # Clamp between 1 and 5

    print(f'Starting game series in room {pin}: {games_count} game(s) with {song_count} songs each')
    
    if pin not in rooms:
        emit('error', {'message': 'Room not found'})
        return
    
    room = rooms[pin]
    
    if room.host_sid != request.sid:
        emit('error', {'message': 'Only host can start the game'})
        return

    def emit_prep_progress(label: str, percent: int):
        try:
            socketio.emit(
                'question_progress',
                {
                    'label': label,
                    'percent': int(max(0, min(100, percent))),
                },
                room=pin,
            )
            socketio.sleep(0)
        except Exception:
            pass

    emit_prep_progress('Loading playlist tracks…', 5)
    
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
            # Send refreshed token to host for Web Playback SDK
            emit('token_refreshed', {
                'access_token': refreshed_token['access_token'],
                'expires_at': refreshed_token.get('expires_at', 0)
            }, to=room.host_sid)
        
        # Fetch larger pool (200 tracks) from random offset for better variety
        tracks, error = spotify_oauth_service.get_playlist_tracks(sp_client, room.playlist_id, limit=200, fetch_pool_size=200)
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

    emit_prep_progress('Preparing playlist context…', 15)

    # Keep a pool snapshot for context + playlist-anchored distractors.
    tracks_pool = list(tracks)

    # Best-effort playlist context (helps decade/mixed playlists).
    print("\n=== 🎵 Playlist Context Analysis ===")
    playlist_name = None
    playlist_description = None
    try:
        if room.playlist_id == 'liked-songs':
            playlist_name = 'Liked Songs'
            print(f"✓ Playlist: {playlist_name} (user's liked tracks)")
        elif room.token_info and spotify_oauth_service:
            # Use authenticated client for private/collaborative playlists
            sp_client, refreshed_token = spotify_oauth_service.get_spotify_client(room.token_info)
            if refreshed_token:
                room.token_info = refreshed_token
            if sp_client:
                info = sp_client.playlist(room.playlist_id, fields='name,description')
                playlist_name = info.get('name')
                playlist_description = info.get('description')
                print(f"✓ Playlist: '{playlist_name}'")
                if playlist_description:
                    desc_preview = playlist_description[:80] + '...' if len(playlist_description) > 80 else playlist_description
                    print(f"  Description: {desc_preview}")
        elif spotify_service:
            info = spotify_service.sp.playlist(room.playlist_id, fields='name,description')
            playlist_name = info.get('name')
            playlist_description = info.get('description')
            print(f"✓ Playlist: '{playlist_name}'")
            if playlist_description:
                desc_preview = playlist_description[:80] + '...' if len(playlist_description) > 80 else playlist_description
                print(f"  Description: {desc_preview}")
    except Exception as e:
        print(f"⚠ Could not fetch playlist context: {e}")

    # Locale hint: useful to keep distractors language/scene-consistent.
    print("\n=== 🌍 Locale Detection ===")
    locale_hint = None
    try:
        if room.token_info and spotify_oauth_service:
            sp_client, _ = spotify_oauth_service.get_spotify_client(room.token_info)
            if sp_client:
                user_profile = sp_client.current_user()
                if user_profile:
                    locale_hint = user_profile.get('country')
                    if locale_hint:
                        print(f"✓ User locale: {locale_hint} (helps keep distractors culturally relevant)")
                    else:
                        print("⚠ No locale detected from user profile")
        else:
            print("⚠ No authenticated user, skipping locale detection")
    except Exception as e:
        print(f"⚠ Locale detection failed: {e}")
        locale_hint = None

    def _norm_name(value: str) -> str:
        return re.sub(r"\s+", " ", (value or "")).strip().lower()

    def _unique_preserve(values):
        seen = set()
        out = []
        for v in values:
            nv = _norm_name(v)
            if not nv or nv in seen:
                continue
            seen.add(nv)
            out.append(v.strip())
        return out

    playlist_artist_pool = _unique_preserve([t.get('artist', '') for t in tracks_pool if t.get('artist')])
    print(f"\n=== 🎤 Artist Pool Analysis ===")
    print(f"✓ Extracted {len(playlist_artist_pool)} unique artists from playlist for context")

    # Spotify Search validator to reduce LLM hallucinations (real artists only)
    print("\n=== 🔍 Spotify Search Validator Setup ===")
    sp_search = None
    try:
        if room.token_info and spotify_oauth_service:
            sp_search, refreshed_token = spotify_oauth_service.get_spotify_client(room.token_info)
            if refreshed_token:
                room.token_info = refreshed_token
        if not sp_search and spotify_service:
            sp_search = spotify_service.sp
        if sp_search:
            print("✓ Spotify API validator ready (will verify LLM-generated artists are real)")
        else:
            print("⚠ No Spotify validator available (will trust LLM output)")
    except Exception as e:
        print(f"⚠ Could not initialize Spotify search client: {e}")
        sp_search = spotify_service.sp if spotify_service else None

    _artist_exists_cache = {}
    _spotify_api_calls = 0  # Track validation API calls

    def artist_exists_on_spotify(name: str) -> bool:
        nonlocal _spotify_api_calls
        norm = _norm_name(name)
        if not norm:
            return False
        if norm in _artist_exists_cache:
            return _artist_exists_cache[norm]
        if not sp_search:
            # No verifier available; assume true and rely on LLM rules.
            _artist_exists_cache[norm] = True
            return True

        # Bounded retries with rate-limit backoff.
        max_attempts = 3
        for attempt in range(1, max_attempts + 1):
            try:
                # Use a strict-ish query; then confirm the top result matches reasonably.
                _spotify_api_calls += 1
                res = sp_search.search(q=f'artist:"{name}"', type='artist', limit=1)
                items = (res or {}).get('artists', {}).get('items', [])
                if not items:
                    _artist_exists_cache[norm] = False
                    return False
                top_name = (items[0].get('name') or '').strip()
                top_norm = _norm_name(top_name)
                ok = (top_norm == norm) or (norm in top_norm) or (top_norm in norm)
                _artist_exists_cache[norm] = ok
                return ok
            except Exception as e:
                # Spotipy raises SpotifyException with http_status + headers.
                status = getattr(e, 'http_status', None) or getattr(e, 'status', None)
                headers = getattr(e, 'headers', None) or {}
                retry_after = None
                try:
                    ra = None
                    if isinstance(headers, dict):
                        ra = headers.get('Retry-After') or headers.get('retry-after')
                    if ra is not None:
                        retry_after = float(ra)
                except Exception:
                    retry_after = None

                if status == 429 and attempt < max_attempts:
                    wait_s = retry_after if retry_after is not None else (0.8 * attempt)
                    # eventlet-friendly sleep (Flask-SocketIO stub wants int seconds)
                    wait_s_int = int(max(1.0, min(10.0, float(wait_s))))
                    socketio.sleep(wait_s_int)
                    continue

                # Be permissive on transient API errors
                _artist_exists_cache[norm] = True
                return True

            # Should be unreachable, but keep the type-checker happy.
            _artist_exists_cache[norm] = True
            return True

        # If all attempts were rate-limited, be permissive to avoid blocking the game.
        _artist_exists_cache[norm] = True
        return True


    def prefetch_artist_existence(names, label: str):
        """Prefetch Spotify existence checks in parallel (eventlet greenlets).

        This warms `_artist_exists_cache` so subsequent per-track loops mostly do
        fast cache hits.
        """

        if not sp_search:
            return

        try:
            concurrency = int(os.getenv('SPOTIFY_VALIDATE_CONCURRENCY', '4'))
        except Exception:
            concurrency = 6
        concurrency = max(1, min(12, concurrency))

        # De-dupe by normalized name to avoid duplicate API work.
        uniq = {}
        for n in names or []:
            nn = _norm_name(n)
            if not nn:
                continue
            if nn in _artist_exists_cache:
                continue
            if nn not in uniq:
                uniq[nn] = n

        if concurrency <= 1 or len(uniq) < 10:
            return

        try:
            import eventlet
            pool = eventlet.GreenPool(size=concurrency)
            todo = list(uniq.values())
            print(f"⚡ Prefetching Spotify validation for {len(todo)} unique artists ({label}, concurrency={concurrency})…")
            for n in todo:
                pool.spawn_n(artist_exists_on_spotify, n)
            pool.waitall()
            print(f"✓ Prefetch done ({label}): cache={len(_artist_exists_cache)}, Spotify API calls={_spotify_api_calls}")
        except Exception as e:
            print(f"⚠ Prefetch skipped ({label}): {type(e).__name__}: {e}")

    prep_total_started_at = time.time()

    emit_prep_progress('Selecting tracks…', 20)
    
    # Calculate total songs needed for all games
    total_songs_needed = song_count * games_count
    
    # Randomize and select enough songs for ALL games
    random.shuffle(tracks)
    tracks = tracks[:total_songs_needed]
    
    # Check if we have enough tracks
    if len(tracks) < total_songs_needed:
        emit('error', {'message': f'Not enough tracks in playlist. Need {total_songs_needed} but only found {len(tracks)}. Try a larger playlist or reduce songs/games.'})
        return
    
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
    
    # Generate ALL questions for ALL games with distractor artists
    total_tracks = len(tracks)
    print(f"\n{'='*60}")
    print(f"🤖 Starting LLM-based distractor generation for {total_tracks} tracks")
    print(f"   Games: {games_count} | Songs per game: {song_count}")
    print(f"{'='*60}")

    emit_prep_progress('Generating answer options…', 30)

    # Batch-generate GPT distractors once per start_game to reduce cost.
    # NOTE: OpenAI SDK calls are blocking; run them in eventlet's threadpool so
    # the eventlet hub can keep serving regular HTTP routes during generation.
    gpt_real_distractors = [[] for _ in range(total_tracks)]  # list[list[str]]
    gpt_funny_distractors = ["" for _ in range(total_tracks)]
    funny_enabled = [False for _ in range(total_tracks)]
    used_real = set()   # normalized
    used_funny = set()  # normalized

    if openai_service:
        print("\n=== 🎯 GPT Real Distractors Generation ===")
        try:
            batch_items = [
                {
                    'correct_artist': track.get('artist', ''),
                    'track_name': track.get('name', ''),
                    'album': track.get('album', '')
                }
                for track in tracks
            ]

            # Include a funny option only sometimes to reduce hinting and keep variety.
            funny_probability = 0.40
            funny_enabled = [random.random() < funny_probability for _ in range(total_tracks)]
            if total_tracks > 0 and not any(funny_enabled):
                funny_enabled[random.randrange(total_tracks)] = True

            # Provide a representative sample of artists to hint the playlist vibe.
            artist_sample = playlist_artist_pool[:60]
            print(f"📤 Requesting 3 real distractors per track from GPT (batch of {total_tracks})...")
            print(f"   Context: {len(artist_sample)} sample artists, locale={locale_hint or 'none'}")
            
            # Split large batches to avoid API timeouts/token limits
            BATCH_SIZE = 30  # Process max 30 tracks at a time
            if total_tracks > BATCH_SIZE:
                print(f"⚠ Large batch detected ({total_tracks} tracks) - splitting into chunks of {BATCH_SIZE}")
                for batch_start in range(0, total_tracks, BATCH_SIZE):
                    batch_end = min(batch_start + BATCH_SIZE, total_tracks)
                    batch_subset = batch_items[batch_start:batch_end]
                    print(f"   Processing batch {batch_start//BATCH_SIZE + 1}/{(total_tracks + BATCH_SIZE - 1)//BATCH_SIZE}: tracks {batch_start+1}-{batch_end}")
                    
                    try:
                        gpt_start = time.time()
                        batch_result = tpool.execute(
                            openai_service.generate_real_artist_distractors_batch,
                            batch_subset,
                            per_item_count=3,
                            playlist_name=playlist_name,
                            playlist_description=playlist_description,
                            playlist_artists_sample=artist_sample,
                            locale_hint=locale_hint,
                            recent_real=[],
                        )
                        gpt_duration = time.time() - gpt_start
                        
                        # Store results in correct position
                        for i, result in enumerate(batch_result):
                            gpt_real_distractors[batch_start + i] = result
                        
                        batch_generated = sum(len(d) for d in batch_result)
                        print(f"   ✓ Batch complete in {gpt_duration:.1f}s - generated {batch_generated} distractors")
                    except Exception as e:
                        print(f"   ❌ Batch {batch_start//BATCH_SIZE + 1} failed: {type(e).__name__}: {str(e)}")
                        # Fill with empty lists so indexing doesn't break
                        for i in range(batch_start, batch_end):
                            gpt_real_distractors[i] = []
                    
                    socketio.sleep(0)  # Yield between batches
                
                total_generated = sum(len(d) for d in gpt_real_distractors)
                print(f"✓ All batches complete - {total_generated} total distractors generated")
            else:
                # Small batch - process all at once
                try:
                    gpt_start = time.time()
                    gpt_real_distractors = tpool.execute(
                        openai_service.generate_real_artist_distractors_batch,
                        batch_items,
                        per_item_count=3,
                        playlist_name=playlist_name,
                        playlist_description=playlist_description,
                        playlist_artists_sample=artist_sample,
                        locale_hint=locale_hint,
                        recent_real=[],
                    )
                    gpt_duration = time.time() - gpt_start
                    total_generated = sum(len(d) for d in gpt_real_distractors)
                    print(f"✓ GPT returned {total_generated} real distractors in {gpt_duration:.1f}s")
                except Exception as e:
                    print(f"❌ Real distractor generation failed: {type(e).__name__}: {str(e)}")
                    gpt_real_distractors = [[] for _ in range(total_tracks)]
                    total_generated = 0
            
            if total_tracks > 0:
                print(f"   Average: {total_generated / total_tracks:.1f} distractors per track")
            
            # Diagnostic: inspect first few results
            if total_generated == 0:
                print("⚠ WARNING: No real distractors generated!")
                print(f"   This likely indicates an API error, timeout, or token limit")
                print(f"   Result type: {type(gpt_real_distractors)}, Length: {len(gpt_real_distractors)}")
                if len(gpt_real_distractors) > 0:
                    print(f"   First 3 elements: {gpt_real_distractors[:3]}")
            else:
                # Show sample of what was generated
                non_empty = [d for d in gpt_real_distractors if d]
                if non_empty:
                    print(f"   Sample results: {non_empty[0][:2] if len(non_empty[0]) >= 2 else non_empty[0]}")

            print("\n=== 😄 GPT Funny Distractors Generation ===")
            funny_items = [batch_items[i] for i in range(total_tracks) if funny_enabled[i]]
            funny_indices = [i for i in range(total_tracks) if funny_enabled[i]]
            if funny_items:
                print(f"📤 Requesting funny options for {len(funny_items)}/{total_tracks} tracks ({int(len(funny_items)/total_tracks*100)}%)...")
                try:
                    funny_start = time.time()
                    funny_generated = tpool.execute(
                        openai_service.generate_funny_fake_artists_batch,
                        funny_items,
                        playlist_name=playlist_name,
                        playlist_description=playlist_description,
                        playlist_artists_sample=artist_sample,
                        locale_hint=locale_hint,
                        recent_funny=[],
                    )
                    funny_duration = time.time() - funny_start
                    funny_count = sum(1 for f in funny_generated if f)
                    print(f"✓ GPT returned {funny_count} funny distractors in {funny_duration:.1f}s")
                    for local_i, original_i in enumerate(funny_indices):
                        if local_i < len(funny_generated):
                            gpt_funny_distractors[original_i] = funny_generated[local_i]
                except Exception as e:
                    print(f"❌ Funny distractor generation failed: {type(e).__name__}: {str(e)}")
            else:
                print("⚠ No funny distractors requested (probability check failed)")
        except Exception as e:
            print(f"\n❌ Batch distractor generation failed: {e}")
            print("   Will use fallback methods per-track")

    emit_prep_progress('Verifying answer options…', 65)

    def pick_valid_real_from_candidates(correct_artist: str, candidates, avoid_norm):
        """Pick a candidate artist name not in the avoid list.

        Note: this is used with `playlist_artist_pool`, which is derived from Spotify
        playlist tracks, so candidates are already real Spotify artists.
        """

        correct_norm = _norm_name(correct_artist)
        for cand in candidates or []:
            cn = _norm_name(cand)
            if not cn or cn == correct_norm or cn in avoid_norm:
                continue
            return cand
        return None

    # One repair round: for tracks where Spotify validation removes too many "real" picks
    print("\n=== ✅ Spotify Validation & Repair Round ===")
    if openai_service:
        print(f"🔍 Validating GPT-generated artists against Spotify API...")

        # Warm cache in parallel to reduce wall time in the per-track loop.
        try:
            all_candidates = []
            for cand_list in (gpt_real_distractors or []):
                if cand_list:
                    all_candidates.extend([c for c in cand_list if c])
            prefetch_artist_existence(all_candidates, label='initial')
        except Exception:
            pass

        validation_start = time.time()
        validation_start_api_calls = _spotify_api_calls  # Track API calls at validation start
        validation_attempts = 0  # Track how many artists we tried to validate
        validation_passed = 0    # Track how many passed validation
        needs_repair = []
        repair_map = []
        for i, track in enumerate(tracks):
            if i % 10 == 0:
                socketio.sleep(0)
            correct = track.get('artist', '')
            candidates = gpt_real_distractors[i] if i < len(gpt_real_distractors) else []
            # If we aren't planning to add a funny option, having 3 real distractors
            # reduces the need for playlist-based fallbacks (which can feel unrelated).
            target_real = 3 if (i < len(funny_enabled) and not funny_enabled[i]) else 2
            verified = []
            for cand in candidates:
                validation_attempts += 1
                if cand and _norm_name(cand) != _norm_name(correct) and artist_exists_on_spotify(cand):
                    verified.append(cand)
                    validation_passed += 1
                    if len(verified) >= target_real:
                        break
            gpt_real_distractors[i] = _unique_preserve(verified)[:3]
            if len(gpt_real_distractors[i]) < target_real:
                needs_repair.append({
                    'correct_artist': track.get('artist', ''),
                    'track_name': track.get('name', ''),
                    'album': track.get('album', '')
                })
                repair_map.append(i)

        validation_duration = time.time() - validation_start
        validation_api_calls_made = _spotify_api_calls - validation_start_api_calls  # Actual API calls during validation
        print(f"✓ Validation complete in {validation_duration:.1f}s")
        print(f"   Candidates checked: {validation_attempts}")
        print(f"   Validation passed: {validation_passed}/{validation_attempts}")
        print(f"   Spotify API calls: {validation_api_calls_made} ({_spotify_api_calls} total)")
        print(f"   Tracks needing repair: {len(needs_repair)}/{total_tracks} ({int(len(needs_repair)/total_tracks*100)}%)")
        
        if validation_attempts == 0:
            print("⚠ WARNING: No candidates were checked! GPT may have returned empty results.")
        
        if needs_repair:
            # If any track needs 3 real distractors, request a slightly larger pool.
            try:
                max_target = 2
                for ri in repair_map:
                    if ri < len(funny_enabled) and not funny_enabled[ri]:
                        max_target = 3
                        break
            except Exception:
                max_target = 2
            repair_per_item = 6 if max_target >= 3 else 4
            print(f"\n🔧 Repair Round: Requesting {repair_per_item} candidates per track for {len(needs_repair)} tracks...")
            try:
                artist_sample = playlist_artist_pool[:60]
                repair_start = time.time()
                
                # Split repair batch if too large
                REPAIR_BATCH_SIZE = 30
                if len(needs_repair) > REPAIR_BATCH_SIZE:
                    print(f"   Splitting repair into chunks of {REPAIR_BATCH_SIZE}...")
                    repaired = [[] for _ in range(len(needs_repair))]
                    for batch_start in range(0, len(needs_repair), REPAIR_BATCH_SIZE):
                        batch_end = min(batch_start + REPAIR_BATCH_SIZE, len(needs_repair))
                        batch_subset = needs_repair[batch_start:batch_end]
                        print(f"   Repair batch {batch_start//REPAIR_BATCH_SIZE + 1}/{(len(needs_repair) + REPAIR_BATCH_SIZE - 1)//REPAIR_BATCH_SIZE}...")
                        
                        try:
                            batch_repaired = tpool.execute(
                                openai_service.generate_real_artist_distractors_batch,
                                batch_subset,
                                per_item_count=repair_per_item,
                                playlist_name=playlist_name,
                                playlist_description=playlist_description,
                                playlist_artists_sample=artist_sample,
                                locale_hint=locale_hint,
                                recent_real=[],
                                extra_banned=list(used_real),
                            )
                            for i, result in enumerate(batch_repaired):
                                repaired[batch_start + i] = result
                        except Exception as e:
                            print(f"   ❌ Repair batch failed: {type(e).__name__}: {str(e)}")
                            for i in range(batch_start, batch_end):
                                repaired[i] = []
                        
                        socketio.sleep(0)
                else:
                    repaired = tpool.execute(
                        openai_service.generate_real_artist_distractors_batch,
                        needs_repair,
                        per_item_count=repair_per_item,
                        playlist_name=playlist_name,
                        playlist_description=playlist_description,
                        playlist_artists_sample=artist_sample,
                        locale_hint=locale_hint,
                        recent_real=[],
                        extra_banned=list(used_real),
                    )

                # Prefetch repair candidate validations in parallel.
                try:
                    repair_candidates = []
                    for cand_list in (repaired or []):
                        if cand_list:
                            repair_candidates.extend([c for c in cand_list if c])
                    prefetch_artist_existence(repair_candidates, label='repair')
                except Exception:
                    pass
                
                for local_i, original_i in enumerate(repair_map):
                    correct = tracks[original_i].get('artist', '')
                    avoid = {_norm_name(correct)}
                    target_real = 3 if (original_i < len(funny_enabled) and not funny_enabled[original_i]) else 2
                    # Keep any already-verified picks, then top up from repaired candidates.
                    picks = list(gpt_real_distractors[original_i])
                    for cand in (repaired[local_i] if local_i < len(repaired) else []):
                        if len(picks) >= target_real:
                            break
                        cn = _norm_name(cand)
                        if cn in avoid:
                            continue
                        if not artist_exists_on_spotify(cand):
                            continue
                        if cn not in {_norm_name(x) for x in picks}:
                            picks.append(cand)
                    gpt_real_distractors[original_i] = picks[:3]
                
                repair_duration = time.time() - repair_start
                repaired_count = sum(1 for i in repair_map if len(gpt_real_distractors[i]) >= 2)
                repair_api_calls = _spotify_api_calls - validation_start_api_calls - validation_api_calls_made
                print(f"✓ Repair complete in {repair_duration:.1f}s")
                print(f"   Successfully repaired: {repaired_count}/{len(needs_repair)} tracks")
                print(f"   Spotify API calls during repair: {repair_api_calls}")
            except Exception as e:
                print(f"❌ Real-distractor repair batch failed: {type(e).__name__}: {str(e)}")
        else:
            print("✓ All tracks have sufficient validated distractors")

    emit_prep_progress('Finalizing questions…', 85)
    
    print("\n=== 🎲 Finalizing Questions (Fallback Filling) ===")
    finalize_started_at = time.time()

    fallback_used_playlist = 0
    fallback_used_musicbrainz = 0
    fallback_used_relaxed_playlist = 0
    fallback_used_unknown = 0

    tracks_with_any_fallback = 0
    playlist_scan_steps = 0
    t_playlist_pick = 0.0
    t_musicbrainz_pick = 0.0
    t_relaxed_pick = 0.0
    
    for idx, track in enumerate(tracks, 1):
        # Yield periodically so long preparation doesn't starve other requests.
        if idx % 5 == 0:
            socketio.sleep(0)
        correct_artist = track.get('artist', '')
        correct_norm = _norm_name(correct_artist)

        # Build 3 distractors: prefer GPT real picks; add GPT funny when enabled;
        # only then fall back to playlist/MB/Unknown.
        fake_artists = []
        avoid_norm = set(used_real) | set(used_funny) | {correct_norm}

        want_funny = (idx - 1 < len(funny_enabled)) and bool(funny_enabled[idx - 1])

        # Collect up to 3 validated GPT real candidates (don't commit them globally yet).
        real_candidates = gpt_real_distractors[idx - 1] if idx - 1 < len(gpt_real_distractors) else []
        real_picks = []
        for cand in real_candidates:
            if len(real_picks) >= 3:
                break
            cn = _norm_name(cand)
            if not cand or cn in avoid_norm:
                continue
            if not artist_exists_on_spotify(cand):
                continue
            real_picks.append(cand)
            avoid_norm.add(cn)

        # Funny option (only when enabled).
        gpt_funny = ""
        if want_funny and idx - 1 < len(gpt_funny_distractors):
            gpt_funny = (gpt_funny_distractors[idx - 1] or "").strip()
        gpt_funny_norm = _norm_name(gpt_funny)

        # Prefer 2 real + funny when available; otherwise use 3 real.
        if want_funny and gpt_funny and gpt_funny_norm not in avoid_norm:
            fake_artists.extend(real_picks[:2])
            fake_artists.append(gpt_funny)
            used_funny.add(gpt_funny_norm)
            avoid_norm.add(gpt_funny_norm)
        else:
            fake_artists.extend(real_picks[:3])

        # Commit any chosen real picks to the global de-dupe set.
        for a in fake_artists:
            na = _norm_name(a)
            if na and a != gpt_funny:
                used_real.add(na)

        # Fill remaining REAL slots with a playlist-derived fallback list (playlist pool), or generic placeholders.
        # Note: we do NOT rely on related-artists endpoints.
        used_fallback_this_track = False
        while len(fake_artists) < 3:
            # Try playlist pool as last resort (still keeps some playlist coherence)
            t0 = time.perf_counter()
            candidate = None
            # Inline scan so we can measure how much work we do here.
            correct_norm_local = correct_norm
            for cand in playlist_artist_pool or []:
                playlist_scan_steps += 1
                cn = _norm_name(cand)
                if not cn or cn == correct_norm_local or cn in avoid_norm:
                    continue
                candidate = cand
                break
            t_playlist_pick += (time.perf_counter() - t0)

            if candidate:
                cn = _norm_name(candidate)
                fake_artists.insert(min(len(fake_artists), 2), candidate)
                used_real.add(cn)
                avoid_norm.add(cn)
                fallback_used_playlist += 1
                used_fallback_this_track = True
                continue

            # Relax constraints and reuse any other playlist artist.
            # This avoids getting stuck once the global de-dupe set gets large.
            relaxed_pool = [a for a in playlist_artist_pool if _norm_name(a) != correct_norm]
            if relaxed_pool:
                t0 = time.perf_counter()
                candidate = random.choice(relaxed_pool)
                t_relaxed_pick += (time.perf_counter() - t0)
                cn = _norm_name(candidate)
                fake_artists.insert(min(len(fake_artists), 2), candidate)
                used_real.add(cn)
                avoid_norm.add(cn)
                fallback_used_relaxed_playlist += 1
                used_fallback_this_track = True
                continue

            # Last-resort fallback: pick a real artist name from MusicBrainz.
            mb_candidate = ""
            if musicbrainzngs:
                try:
                    t0 = time.perf_counter()
                    mb_candidate = tpool.execute(_mb_pick_fallback_artist, list(avoid_norm))
                    t_musicbrainz_pick += (time.perf_counter() - t0)
                except Exception:
                    mb_candidate = ""

            if mb_candidate:
                cn = _norm_name(mb_candidate)
                fake_artists.insert(min(len(fake_artists), 2), mb_candidate)
                used_real.add(cn)
                avoid_norm.add(cn)
                fallback_used_musicbrainz += 1
                used_fallback_this_track = True
                continue

            # Absolute last fallback.
            fake_artists.append("Unknown Artist")
            fallback_used_unknown += 1
            used_fallback_this_track = True

        if used_fallback_this_track:
            tracks_with_any_fallback += 1

        # Progress diagnostics (keep it lightweight)
        if idx == 1 or idx % 10 == 0 or idx == total_tracks:
            elapsed = time.time() - finalize_started_at
            avg_ms = (elapsed / idx) * 1000.0 if idx else 0.0
            remaining = (elapsed / idx) * (total_tracks - idx) if idx else 0.0
            print(
                f"   • Finalizing {idx}/{total_tracks} | {elapsed:.1f}s elapsed, {avg_ms:.0f}ms/track, ~{remaining:.1f}s remaining | "
                f"fallback slots: playlist={fallback_used_playlist}, mb={fallback_used_musicbrainz}, relaxed={fallback_used_relaxed_playlist}, unknown={fallback_used_unknown} | "
                f"playlist scan steps={playlist_scan_steps}"
            )
        
        question = room.generate_question(track, fake_artists)
        room.all_questions.append(question)

    finalize_duration = time.time() - finalize_started_at
    print(f"\n📊 Fallback Statistics:")
    print(f"   Tracks needing any fallback: {tracks_with_any_fallback}/{total_tracks}")
    print(f"   Playlist pool fallbacks: {fallback_used_playlist} slots")
    print(f"   MusicBrainz fallbacks: {fallback_used_musicbrainz} slots")
    print(f"   Relaxed playlist fallbacks: {fallback_used_relaxed_playlist} slots")
    print(f"   Unknown Artist fallbacks: {fallback_used_unknown} slots")
    print(f"   Playlist scan steps: {playlist_scan_steps}")
    print(f"   Finalizing duration: {finalize_duration:.1f}s")
    print(f"     - Playlist pick time: {t_playlist_pick:.2f}s")
    print(f"     - MusicBrainz pick time: {t_musicbrainz_pick:.2f}s")
    print(f"     - Relaxed pick time: {t_relaxed_pick:.2f}s")
    print(f"   Total Spotify API calls: {_spotify_api_calls}")
    print(f"\n✅ All {total_tracks} questions generated successfully!")
    print(f"{'='*60}\n")

    emit_prep_progress('Starting game…', 95)
    
    # Split questions into game-specific pools
    for game_num in range(1, games_count + 1):
        start_idx = (game_num - 1) * song_count
        end_idx = game_num * song_count
        room.game_questions_map[game_num] = list(range(start_idx, end_idx))
    
    # Set up first game with its questions
    room.games_in_series = games_count
    room.current_game_number = 1
    room.questions = [room.all_questions[i] for i in room.game_questions_map[1]]
    room.state = 'playing'
    room.question_index = 0
    room.current_question = room.questions[0]
    
    # Notify all players game is starting
    socketio.emit('game_started', {
        'total_songs': len(room.questions),
        'has_oauth': room.token_info is not None,
        'games_in_series': games_count,
        'current_game': 1
    }, room=pin)
    
    # Send first question
    send_question(pin)
    
    prep_total_duration = time.time() - prep_total_started_at
    per_track = (prep_total_duration / total_tracks) if total_tracks else 0.0
    print(f"⏱ Total preparation time: {prep_total_duration:.1f}s ({per_track:.2f}s/track)")
    print(f'Game started in room {pin} with {len(room.questions)} questions (OAuth: {room.token_info is not None})')


def send_question(pin):
    """Send current question to all players in room"""
    room = rooms[pin]
    question = room.current_question
    
    # Save current scores at start of question
    room.question_start_scores = {
        sid: player['score']
        for sid, player in room.participants.items()
    }
    
    # Record question start time
    room.question_start_time = datetime.now()
    
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
    
    # Don't start timer automatically - wait for playback_started event from frontend
    room.voting_closed = False  # Reset voting flag for new question


@socketio.on('playback_started')
def handle_playback_started(data):
    pin = data.get('pin')
    
    if pin not in rooms:
        return
    
    room = rooms[pin]
    current_question_index = room.question_index
    
    print(f'Playback started for question {room.question_index + 1} in room {pin}, starting timer')
    
    # Notify all clients to start their timers
    socketio.emit('start_question_timer', {}, room=pin)
    
    # Start timer now that playback has begun
    def question_timeout():
        socketio.sleep(15)
        if pin in rooms and rooms[pin].question_index == current_question_index:
            if not rooms[pin].voting_closed:
                print(f'Question {current_question_index + 1} timeout in room {pin}')
                socketio.emit('question_timeout', {}, room=pin)
                close_voting_and_show_answer(pin)
    
    socketio.start_background_task(question_timeout)


def close_voting_and_show_answer(pin):
    """Unified flow when voting closes (timeout or all answered)"""
    if pin not in rooms:
        return
    
    room = rooms[pin]
    room.voting_closed = True
    room.correct_answer_acks = set()
    
    print(f'Closing voting for question {room.question_index + 1} in room {pin}')
    
    # Show correct answer immediately (no delay)
    socketio.emit('show_correct_answer', {
        'correct_answer': room.current_question['correct_answer'],
        'correct_artist': room.current_question['correct_artist']
    }, room=pin)
    
    # Wait for all participants to acknowledge (max 2 seconds)
    participant_count = len(room.participants)
    max_wait = 2.0
    wait_interval = 0.1
    waited = 0.0
    
    while waited < max_wait and len(room.correct_answer_acks) < participant_count:
        socketio.sleep(wait_interval)
        waited += wait_interval
    
    print(f'Participants acknowledged: {len(room.correct_answer_acks)}/{participant_count} after {waited:.1f}s')
    
    # Calculate points gained for each player in this question
    scores_with_gains = []
    for sid, player in room.participants.items():
        previous_score = room.question_start_scores.get(sid, 0)
        points_gained = player['score'] - previous_score
        scores_with_gains.append({
            'name': player['name'],
            'score': player['score'],
            'sid': player['sid'],
            'points_gained': points_gained
        })
    
    # Sort by total score (descending)
    scores_with_gains.sort(key=lambda x: x['score'], reverse=True)
    
    # Always show standings to host (even for last question)
    # This ensures host and participants can see the final results
    socketio.emit('show_intermediate_scores', {
        'scores': scores_with_gains,
        'is_last_question': (room.question_index + 1) >= len(room.questions)
    }, room=pin, to=room.host_sid)


@socketio.on('correct_answer_displayed')
def handle_correct_answer_displayed(data):
    pin = data.get('pin')
    sid = request.sid
    
    if pin in rooms and sid in rooms[pin].participants:
        rooms[pin].correct_answer_acks.add(sid)
        print(f'Participant {rooms[pin].participants[sid]["name"]} acknowledged correct answer in room {pin}')


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
    
    # Wait for participants to be ready with minimum display time
    def wait_for_ready():
        min_display_time = 6.0  # Minimum 6 seconds display
        max_wait = 14.0  # Increased from 10 to accommodate min display time
        wait_interval = 0.1
        waited = 0.0
        participant_count = len(rooms[pin].participants)
        
        # Wait for participants to be ready
        while waited < max_wait and len(rooms[pin].standings_ready_acks) < participant_count:
            socketio.sleep(wait_interval)
            waited += wait_interval
        
        # Ensure minimum display time has elapsed
        elapsed = time.time() - standings_shown_at
        if elapsed < min_display_time:
            remaining = min_display_time - elapsed
            print(f'Enforcing minimum display time, waiting {remaining:.1f}s more')
            socketio.sleep(remaining)
        
        ack_count = len(rooms[pin].standings_ready_acks)
        total_time = time.time() - standings_shown_at
        print(f'Ready for next: {ack_count}/{participant_count} after {total_time:.1f}s total display time')
        
        # Check if this was the last question
        is_last_question = (rooms[pin].question_index + 1) >= len(rooms[pin].questions)
        
        if is_last_question:
            room = rooms[pin]
            # Update series scores with current game scores
            for sid, player in room.participants.items():
                room.series_scores[sid] = room.series_scores.get(sid, 0) + player['score']
            
            # Check if this was the last game in the series
            is_last_game = room.current_game_number >= room.games_in_series
            
            if is_last_game:
                # End the entire series
                room.state = 'ended'
                socketio.emit('series_ended', {
                    'final_scores': room.get_series_scores(),
                    'games_played': room.games_in_series
                }, room=pin)
                print(f'Game series ended in room {pin} after {room.games_in_series} game(s)')
            else:
                # End current game and prepare for next
                socketio.emit('game_ended', {
                    'game_scores': room.get_scores(),
                    'series_scores': room.get_series_scores(),
                    'current_game': room.current_game_number,
                    'total_games': room.games_in_series
                }, room=pin)
                print(f'Game {room.current_game_number}/{room.games_in_series} ended in room {pin}')
        else:
            # Auto-advance to next question
            socketio.emit('advance_question', {}, room=pin, to=rooms[pin].host_sid)
    
    socketio.start_background_task(wait_for_ready)


@socketio.on('ready_for_next')
def handle_ready_for_next(data):
    pin = data.get('pin')
    sid = request.sid
    
    if pin in rooms and sid in rooms[pin].participants:
        rooms[pin].standings_ready_acks.add(sid)
        print(f'Participant {rooms[pin].participants[sid]["name"]} ready for next question')


@socketio.on('start_next_game')
def handle_start_next_game(data):
    """Start the next game in a multi-game series"""
    pin = data.get('pin')
    
    if pin not in rooms:
        emit('error', {'message': 'Room not found'})
        return
    
    room = rooms[pin]
    
    if room.host_sid != request.sid:
        emit('error', {'message': 'Only host can start next game'})
        return
    
    # Reset game state but keep series scores
    room.current_game_number += 1
    room.question_index = 0
    room.answers = {}
    room.voting_closed = False
    room.correct_answer_acks = set()
    room.standings_ready_acks = set()
    room.question_start_scores = {}
    
    # Reset individual game scores to 0
    for sid, player in room.participants.items():
        player['score'] = 0
    
    # Load next game's questions from the pre-generated pool
    game_question_indices = room.game_questions_map[room.current_game_number]
    room.questions = [room.all_questions[i] for i in game_question_indices]
    
    room.current_question = room.questions[0]
    room.state = 'playing'
    
    print(f"Loaded {len(room.questions)} unique questions for game {room.current_game_number}")
    
    # Notify all players that next game is starting
    socketio.emit('game_started', {
        'total_songs': len(room.questions),
        'has_oauth': room.token_info is not None,
        'games_in_series': room.games_in_series,
        'current_game': room.current_game_number
    }, room=pin)
    
    # Send first question
    send_question(pin)
    
    print(f'Game {room.current_game_number}/{room.games_in_series} started in room {pin}')


@socketio.on('submit_answer')
def handle_submit_answer(data):
    pin = data.get('pin')
    answer = data.get('answer')  # Index of selected option (0-3)
    client_timestamp = data.get('client_timestamp')  # Client-side timestamp for fairness
    
    if pin not in rooms:
        emit('error', {'message': 'Room not found'})
        return
    
    room = rooms[pin]
    
    if request.sid not in room.participants:
        emit('error', {'message': 'You are not in this game'})
        return
    
    # Check if voting is still open
    if room.voting_closed:
        emit('error', {'message': 'Voting has ended for this question'})
        return
    
    # Check if player already answered this question
    if room.question_index in room.answers and request.sid in room.answers[room.question_index]:
        emit('error', {'message': 'You have already answered this question'})
        return
    
    # Record answer with client timestamp for fairness
    room.record_answer(request.sid, answer, client_timestamp)
    
    # Check if correct
    is_correct = room.check_answer(request.sid, answer)
    
    # Send feedback to player
    emit('answer_feedback', {
        'correct': is_correct,
        'your_score': room.participants[request.sid]['score']
    })
    
    # Calculate response time in milliseconds using both client and server times
    response_time_ms = None
    if room.question_start_time:
        # Server-side calculation (includes network latency)
        server_received = room.answers[room.question_index][request.sid]['server_received']
        server_response_time_ms = int((server_received - room.question_start_time).total_seconds() * 1000)
        
        # Get client-side response time if provided (excludes network latency)
        client_response_time_ms = data.get('client_response_time_ms')
        
        # Use the minimum of both (favors the player by removing network latency)
        if client_response_time_ms is not None and isinstance(client_response_time_ms, (int, float)) and client_response_time_ms > 0:
            response_time_ms = min(server_response_time_ms, int(client_response_time_ms))
        else:
            # Fallback to server time if client time not available or invalid
            response_time_ms = server_response_time_ms
    
    # Notify everyone that this player has answered
    socketio.emit('player_answered', {
        'player_name': room.participants[request.sid]['name'],
        'response_time_ms': response_time_ms
    }, room=pin)
    
    # Update scores for everyone
    socketio.emit('scores_updated', {
        'scores': room.get_scores()
    }, room=pin)
    
    print(f'Player {room.participants[request.sid]["name"]} answered: {answer} ({"correct" if is_correct else "incorrect"})')
    
    # Check if all participants have answered
    current_answers = room.answers.get(room.question_index, {})
    if len(current_answers) == len(room.participants):
        print(f'All {len(room.participants)} participants have answered question {room.question_index + 1} - music will continue until timer ends')
        
        # Notify that all have voted (but don't end the question yet - let timer finish)
        socketio.emit('all_participants_voted', {
            'message': 'All players have voted - music continues'
        }, room=pin)


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
    
    # Note: correct answer already shown in close_voting_and_show_answer()
    # No need to show it again here
    
    # Move to next question
    room.question_index += 1
    room.voting_closed = False  # Reset for next question
    
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


def cleanup_disconnected_participants():
    """Background task to remove participants and rooms who haven't reconnected after grace period"""
    GRACE_PERIOD = 30  # seconds
    
    while True:
        socketio.sleep(5)  # Check every 5 seconds
        
        current_time = time.time()
        rooms_to_check = list(rooms.items())  # Create a copy to avoid dict size change during iteration
        rooms_to_delete = []
        
        for pin, room in rooms_to_check:
            if pin not in rooms:  # Room might have been deleted
                continue
            
            # Check if host has been disconnected too long
            if room.host_disconnected and room.host_disconnect_time:
                if current_time - room.host_disconnect_time > GRACE_PERIOD:
                    # Host grace period expired, delete room
                    print(f"Removing room {pin} - host grace period expired")
                    socketio.emit('room_closed', {
                        'message': 'Host did not reconnect. Room closed.'
                    }, room=pin)
                    rooms_to_delete.append(pin)
                    continue  # Skip participant cleanup for this room
            
            # Check for disconnected participants
            sids_to_remove = []
            
            for sid, participant in list(room.participants.items()):
                if participant.get('disconnected', False):
                    disconnect_time = participant.get('disconnect_time', current_time)
                    
                    if current_time - disconnect_time > GRACE_PERIOD:
                        # Grace period expired, remove participant
                        sids_to_remove.append(sid)
                        print(f"Removing participant {participant['name']} from room {pin} - grace period expired")
            
            # Remove expired participants
            for sid in sids_to_remove:
                room.remove_participant(sid)
                
                # Notify others
                socketio.emit('participant_left', {
                    'participants': list(room.participants.values()),
                    'scores': room.get_scores()
                }, room=pin)
        
        # Delete rooms with expired host disconnections
        for pin in rooms_to_delete:
            if pin in rooms:
                del rooms[pin]


if __name__ == '__main__':
    # Start background cleanup task
    socketio.start_background_task(cleanup_disconnected_participants)
    
    socketio.run(app, debug=True, host='0.0.0.0', port=8000)
