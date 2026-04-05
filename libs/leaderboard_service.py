import os
import json
import uuid
from datetime import datetime

import logging
logger = logging.getLogger(__name__)


def _get_data_dir():
    return os.getenv("LEADERBOARD_DATA_DIR", "/data")


# Cache of LeaderboardService instances per host_id
_instances = {}


def get_leaderboard_service(host_id):
    """Get or create a LeaderboardService for a given host."""
    if host_id not in _instances:
        _instances[host_id] = LeaderboardService(host_id)
    return _instances[host_id]


class LeaderboardService:
    def __init__(self, host_id, data_dir=None):
        self.host_id = host_id
        self.data_dir = data_dir or _get_data_dir()
        self.file_path = os.path.join(self.data_dir, f"leaderboard_{host_id}.json")
        self._data = self._load()

    def _load(self):
        """Load leaderboard data from disk."""
        if os.path.exists(self.file_path):
            try:
                with open(self.file_path, "r") as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError) as e:
                logger.error(f"Failed to load leaderboard file {self.file_path}: {e}")
        return {"players": {}, "games": []}

    def _save(self):
        """Write leaderboard data to disk."""
        os.makedirs(self.data_dir, exist_ok=True)
        try:
            with open(self.file_path, "w") as f:
                json.dump(self._data, f, indent=2)
        except IOError as e:
            logger.error(f"Failed to save leaderboard file {self.file_path}: {e}")

    def get_or_create_player(self, player_id, name):
        """Find player by ID. Update display_name to most recent name used."""
        if player_id not in self._data["players"]:
            self._data["players"][player_id] = {
                "id": player_id,
                "names": [name],
                "display_name": name,
                "games_played": 0,
                "total_score": 0,
                "wins": 0,
                "correct_answers": 0,
                "total_answers": 0,
                "fastest_response_ms": None,
                "avg_response_ms": None,
                "last_played": None,
            }
        else:
            player = self._data["players"][player_id]
            player["display_name"] = name
            if name not in player["names"]:
                player["names"].append(name)
        return self._data["players"][player_id]

    def record_game(self, game_data):
        """Record a completed game and update player stats.

        game_data should contain:
            playlist_name, playlist_id, num_questions,
            players: [{player_id, name, score, correct, total, fastest_ms, avg_ms}]
        """
        now = datetime.now().isoformat()

        # Sort players by score descending to determine ranks
        sorted_players = sorted(game_data["players"], key=lambda p: p["score"], reverse=True)

        game_record = {
            "id": str(uuid.uuid4()),
            "date": now,
            "playlist_name": game_data.get("playlist_name", "Unknown"),
            "playlist_id": game_data.get("playlist_id", ""),
            "num_questions": game_data.get("num_questions", 0),
            "players": [],
            "winner": sorted_players[0]["name"] if sorted_players else None,
        }

        winner_id = sorted_players[0]["player_id"] if sorted_players else None

        for rank, p in enumerate(sorted_players, 1):
            game_record["players"].append({
                "id": p["player_id"],
                "name": p["name"],
                "score": p["score"],
                "correct": p.get("correct", 0),
                "rank": rank,
            })

            # Update player stats
            pid = p["player_id"]
            if pid not in self._data["players"]:
                self.get_or_create_player(pid, p["name"])

            player = self._data["players"][pid]
            player["display_name"] = p["name"]
            if p["name"] not in player["names"]:
                player["names"].append(p["name"])
            player["games_played"] += 1
            player["total_score"] += p["score"]
            player["correct_answers"] += p.get("correct", 0)
            player["total_answers"] += p.get("total", 0)
            player["last_played"] = now

            if pid == winner_id:
                player["wins"] += 1

            # Update fastest response time
            fastest = p.get("fastest_ms")
            if fastest is not None:
                if player["fastest_response_ms"] is None or fastest < player["fastest_response_ms"]:
                    player["fastest_response_ms"] = fastest

            # Update average response time (running average)
            avg = p.get("avg_ms")
            if avg is not None:
                if player["avg_response_ms"] is None:
                    player["avg_response_ms"] = avg
                else:
                    # Weighted running average
                    n = player["games_played"]
                    player["avg_response_ms"] = round(
                        (player["avg_response_ms"] * (n - 1) + avg) / n
                    )

        self._data["games"].append(game_record)
        self._save()

        logger.info(f"Recorded game for host {self.host_id}: {len(sorted_players)} players, winner: {game_record['winner']}")
        return game_record

    def get_leaderboard(self, limit=20):
        """Return top players sorted by total score."""
        players = list(self._data["players"].values())
        players.sort(key=lambda p: p["total_score"], reverse=True)
        return players[:limit]

    def get_player_stats(self, player_id):
        """Return stats for one player."""
        return self._data["players"].get(player_id)

    def get_game_history(self, limit=20):
        """Return most recent games."""
        return list(reversed(self._data["games"][-limit:]))
