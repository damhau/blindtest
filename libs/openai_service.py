import os
import json
import random
import re
import difflib
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()


class OpenAIService:
    def __init__(self):
        api_key = os.getenv('OPENAI_API_KEY')
        
        if not api_key:
            raise ValueError("OpenAI API key not found in environment variables")
        
        self.client = OpenAI(api_key=api_key)


    @staticmethod
    def _norm_name(value: str) -> str:
        return re.sub(r"\s+", " ", value or "").strip().lower()

    @staticmethod
    def _extract_json_object(text: str) -> Optional[Dict[str, Any]]:
        if not text:
            return None

        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        candidate = text[start : end + 1]

        try:
            obj = json.loads(candidate)
        except Exception:
            return None

        return obj if isinstance(obj, dict) else None

    def _chat(self, *, messages: Sequence[Dict[str, str]], temperature: float, max_completion_tokens: int) -> str:
        response = self.client.chat.completions.create(
            model="gpt-5.2",
            messages=list(messages),
            temperature=temperature,
            max_completion_tokens=max_completion_tokens,
        )
        return (response.choices[0].message.content or "").strip()

    def _embed(self, texts: Sequence[str]) -> List[List[float]]:
        if not texts:
            return []
        response = self.client.embeddings.create(
            model="text-embedding-3-small",
            input=list(texts),
        )
        return [d.embedding for d in response.data]

    @staticmethod
    def _cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
        # Avoid importing numpy for a tiny operation.
        dot = 0.0
        na = 0.0
        nb = 0.0
        for x, y in zip(a, b):
            dot += x * y
            na += x * x
            nb += y * y
        if na <= 0.0 or nb <= 0.0:
            return 0.0
        return dot / ((na ** 0.5) * (nb ** 0.5))

    def generate_funny_fake_artists_batch(
        self,
        items: Sequence[Dict[str, str]],
        *,
        playlist_name: Optional[str] = None,
        playlist_description: Optional[str] = None,
        playlist_artists_sample: Optional[Sequence[str]] = None,
        locale_hint: Optional[str] = None,
        recent_funny: Optional[Iterable[str]] = None,
        extra_banned: Optional[Iterable[str]] = None,
        max_repairs: int = 2,
    ) -> List[str]:
        """Generate one funny fake artist per item.

        Each item must include:
        - correct_artist
        - track_name

        Returns a list aligned with `items` (same length). Empty strings mean fallback needed.
        """

        if not items:
            return []

        # Keep prompts small but informative.
        sample_artists = list(dict.fromkeys([a for a in (playlist_artists_sample or []) if a]))[:60]
        recent = list(dict.fromkeys([x for x in (recent_funny or []) if x]))

        playlist_lines: List[str] = []
        if playlist_name:
            playlist_lines.append(f"Playlist name: {playlist_name}")
        if playlist_description:
            playlist_lines.append(f"Playlist description: {playlist_description}")
        if locale_hint:
            playlist_lines.append(f"Locale hint: {locale_hint}")
        playlist_context = "\n".join(playlist_lines) if playlist_lines else "(no playlist context available)"

        # A small, pragmatic banlist to avoid repetitive celebrity/meme outputs.
        default_banned = {
            "taylor swift",
            "ed sheeran",
            "drake",
            "beyonce",
            "beyoncé",
            "rihanna",
            "justin bieber",
            "billie eilish",
            "the beatles",
            "eminem",
        }
        banned: Set[str] = set(default_banned)
        banned.update({self._norm_name(x) for x in (extra_banned or []) if x})

        playlist_norm = {self._norm_name(a) for a in sample_artists}
        recent_norm = {self._norm_name(a) for a in recent}

        stop_tokens = {
            "a",
            "an",
            "and",
            "by",
            "da",
            "de",
            "del",
            "der",
            "des",
            "di",
            "do",
            "dos",
            "du",
            "el",
            "et",
            "la",
            "le",
            "les",
            "los",
            "of",
            "on",
            "the",
            "to",
            "van",
            "von",
            "y",
        }

        def _tokens_for_similarity(text: str) -> Set[str]:
            parts = re.split(r"[^A-Za-z0-9]+", (text or "").lower())
            return {p for p in parts if p and p not in stop_tokens and len(p) >= 4}

        def _too_similar_to_correct(fun: str, correct_artist: str) -> bool:
            # Prevent "Drizzle on Saturn" vs "Hurricane on Saturn" giveaways.
            fun_norm = self._norm_name(fun)
            correct_norm = self._norm_name(correct_artist)
            if not fun_norm or not correct_norm:
                return False

            # Token overlap (ignoring stopwords) is a strong giveaway.
            if _tokens_for_similarity(fun_norm) & _tokens_for_similarity(correct_norm):
                return True

            # Also block very high overall similarity.
            ratio = difflib.SequenceMatcher(None, fun_norm, correct_norm).ratio()
            if ratio >= 0.72:
                return True

            # And block long shared prefix/suffix.
            prefix_len = len(os.path.commonprefix([fun_norm, correct_norm]))
            if prefix_len >= 6:
                return True
            suffix_len = len(os.path.commonprefix([fun_norm[::-1], correct_norm[::-1]]))
            if suffix_len >= 6:
                return True

            return False

        def validate_funny(value: str, *, correct_artist: str) -> bool:
            if not value or not isinstance(value, str):
                return False
            v = value.strip()
            if not v:
                return False
            if len(v) > 48:
                return False
            v_norm = self._norm_name(v)
            if v_norm in banned:
                return False
            if v_norm in playlist_norm:
                return False
            if v_norm in recent_norm:
                return False
            # Avoid obvious formatting artifacts.
            if re.search(r"\b(https?://|www\.)", v, re.IGNORECASE):
                return False
            if re.search(r"\b(feat\.|ft\.|featuring)\b", v, re.IGNORECASE):
                return False

            # Important: do NOT make the funny option a near-variant of the correct artist.
            if _too_similar_to_correct(v, correct_artist):
                return False
            return True

        # Prepare stable input list.
        normalized_items: List[Dict[str, str]] = []
        for i, it in enumerate(items):
            correct_artist = (it.get("correct_artist") or "").strip()
            track_name = (it.get("track_name") or "").strip()
            if not correct_artist:
                correct_artist = "(unknown artist)"
            if not track_name:
                track_name = "(unknown track)"
            normalized_items.append({"i": str(i), "correct_artist": correct_artist, "track_name": track_name})

        # First pass + optional repair passes.
        results: List[str] = ["" for _ in normalized_items]
        invalid_indices: Set[int] = set(range(len(normalized_items)))

        for attempt in range(max(1, max_repairs + 1)):
            # If we only need to repair a subset, only send that subset.
            prompt_items = [normalized_items[i] for i in sorted(invalid_indices)]

            ban_block = "\n".join(f"- {b}" for b in sorted(banned))
            recent_block = "\n".join(f"- {x}" for x in recent[-30:]) if recent else "(none)"
            artists_block = "\n".join(f"- {a}" for a in sample_artists[:40]) if sample_artists else "(unavailable)"

            prompt = (
                "You are generating the FUNNY fake artist option for a blindtest quiz.\n"
                "For each item, output ONE fictional comedic artist name that looks like it *could* be an artist, "
                "but is clearly NOT a real artist.\n"
                "\nHard rules:\n"
                "- Must be fictional (do NOT output a real artist).\n"
                "- Must be 1–4 words and <= 48 characters.\n"
                "- Must NOT be a near-variant of the correct artist name.\n"
                "  Do NOT reuse any distinctive word from the correct artist name (e.g. avoid shared suffixes like '... on Saturn').\n"
                "  Do NOT make it rhyme/spell almost the same.\n"
                "- Must NOT be a hint for the correct artist.\n"
                "  Do NOT use puns, synonyms, translations, or conceptually related words/objects.\n"
                "- Can be funny via an unrelated fictional stage name that still fits the playlist vibe (NOT random celebrities).\n"
                "- Must NOT match any playlist artist examples.\n"
                "- Must NOT repeat any recent funny fakes.\n"
                "- Avoid meme answers and global celebrity names.\n"
                "\nPlaylist context:\n"
                f"{playlist_context}\n"
                "\nPlaylist artist examples (avoid matching any of these exactly):\n"
                f"{artists_block}\n"
                "\nRecent funny fakes (do NOT reuse):\n"
                f"{recent_block}\n"
                "\nBanned names/terms (do NOT output these):\n"
                f"{ban_block}\n"
                "\nReturn STRICT JSON ONLY with this schema:\n"
                "{\"results\":[{\"i\":0,\"funny\":\"...\"}]}\n"
                "Where `i` is the integer index from the input list.\n"
                "\nInput items:\n"
                + "\n".join(
                    f"- i={it['i']} | correct_artist={it['correct_artist']} | track_name={it['track_name']}"
                    for it in prompt_items
                )
            )

            try:
                text = self._chat(
                    messages=[
                        {
                            "role": "system",
                            "content": "You output strict JSON only. No markdown. No extra text.",
                        },
                        {"role": "user", "content": prompt},
                    ],
                    temperature=0.7,
                    max_completion_tokens=900,
                )
            except Exception as e:
                print(f"Error generating funny fake artists batch: {e}")
                break

            obj = self._extract_json_object(text)
            if not obj or "results" not in obj or not isinstance(obj.get("results"), list):
                # Force a single repair by treating all as invalid; if already repairing, break.
                if attempt >= max_repairs:
                    break
                continue

            proposed_indices: Set[int] = set()

            for row in obj.get("results", []):
                if not isinstance(row, dict):
                    continue
                i_val = row.get("i")
                funny = row.get("funny")
                try:
                    idx = int(i_val)
                except Exception:
                    continue
                if idx < 0 or idx >= len(normalized_items):
                    continue
                correct_artist = normalized_items[idx]["correct_artist"]
                if validate_funny(funny, correct_artist=correct_artist):
                    results[idx] = funny.strip()
                    proposed_indices.add(idx)

            # Semantic anti-hint check (batch embeddings): block funny options that are too related to the correct artist.
            # This catches cases like "Passport Trouble" for "Foreigner".
            semantic_threshold = 0.55
            candidates = [(i, results[i]) for i in sorted(proposed_indices) if results[i]]
            if candidates and invalid_indices:
                embed_texts: List[str] = []
                pair_index: List[int] = []
                for idx, fun in candidates:
                    correct_artist = normalized_items[idx]["correct_artist"]
                    # Skip unknowns.
                    if correct_artist.startswith("("):
                        continue
                    if len(fun.strip()) < 3 or len(correct_artist.strip()) < 3:
                        continue
                    embed_texts.append(correct_artist)
                    embed_texts.append(fun)
                    pair_index.append(idx)

                if embed_texts:
                    try:
                        vectors = self._embed(embed_texts)
                        # vectors are [correct0, fun0, correct1, fun1, ...]
                        for j, idx in enumerate(pair_index):
                            correct_vec = vectors[2 * j]
                            fun_vec = vectors[2 * j + 1]
                            score = self._cosine_similarity(correct_vec, fun_vec)
                            if score >= semantic_threshold:
                                # Too hint-like: reject and keep for repair.
                                results[idx] = ""
                    except Exception as e:
                        # If embeddings fail, we fall back to the prompt-only constraint.
                        print(f"Semantic hint check skipped (embeddings error): {e}")

            for idx in proposed_indices:
                fun = results[idx]
                if fun:
                    invalid_indices.discard(idx)
                    recent_norm.add(self._norm_name(fun))

            if not invalid_indices:
                break

        return results

    def generate_real_artist_distractors_batch(
        self,
        items: Sequence[Dict[str, str]],
        *,
        per_item_count: int = 1,
        playlist_name: Optional[str] = None,
        playlist_description: Optional[str] = None,
        playlist_artists_sample: Optional[Sequence[str]] = None,
        locale_hint: Optional[str] = None,
        recent_real: Optional[Iterable[str]] = None,
        extra_banned: Optional[Iterable[str]] = None,
        max_repairs: int = 2,
    ) -> List[List[str]]:
        """Generate REAL artist distractors for each item.

        Returns a list aligned with `items` (same length). Each element is a list of artist names
        (length <= per_item_count). Missing slots mean fallback/repair needed.
        """

        if not items:
            return []

        per_item_count = int(per_item_count)
        if per_item_count <= 0:
            return [[] for _ in items]

        sample_artists = list(dict.fromkeys([a for a in (playlist_artists_sample or []) if a]))[:60]
        recent = list(dict.fromkeys([x for x in (recent_real or []) if x]))

        banned: Set[str] = set()
        banned.update({self._norm_name(x) for x in (extra_banned or []) if x})

        recent_norm = {self._norm_name(a) for a in recent}

        def validate_real(value: str, correct_artist: str) -> bool:
            if not value or not isinstance(value, str):
                return False
            v = value.strip()
            if not v:
                return False
            if len(v) > 60:
                return False
            v_norm = self._norm_name(v)
            if v_norm == self._norm_name(correct_artist):
                return False
            if v_norm in banned:
                return False
            if v_norm in recent_norm:
                return False
            # Avoid obvious junk.
            if re.search(r"\b(https?://|www\.)", v, re.IGNORECASE):
                return False
            if re.search(r"\b(feat\.|ft\.|featuring)\b", v, re.IGNORECASE):
                return False
            return True

        normalized_items: List[Dict[str, str]] = []
        for i, it in enumerate(items):
            correct_artist = (it.get("correct_artist") or "").strip()
            track_name = (it.get("track_name") or "").strip()
            album = (it.get("album") or "").strip()
            if not correct_artist:
                correct_artist = "(unknown artist)"
            if not track_name:
                track_name = "(unknown track)"
            normalized_items.append(
                {
                    "i": str(i),
                    "correct_artist": correct_artist,
                    "track_name": track_name,
                    "album": album,
                }
            )

        playlist_lines: List[str] = []
        if playlist_name:
            playlist_lines.append(f"Playlist name: {playlist_name}")
        if playlist_description:
            playlist_lines.append(f"Playlist description: {playlist_description}")
        if locale_hint:
            playlist_lines.append(f"Locale hint: {locale_hint}")
        playlist_context = "\n".join(playlist_lines) if playlist_lines else "(no playlist context available)"

        artists_block = "\n".join(f"- {a}" for a in sample_artists[:40]) if sample_artists else "(unavailable)"
        recent_block = "\n".join(f"- {x}" for x in recent[-30:]) if recent else "(none)"
        ban_block = "\n".join(f"- {b}" for b in sorted(banned)) if banned else "(none)"

        results: List[List[str]] = [[] for _ in normalized_items]
        invalid_indices: Set[int] = set(range(len(normalized_items)))

        for attempt in range(max(1, max_repairs + 1)):
            prompt_items = [normalized_items[i] for i in sorted(invalid_indices)]

            prompt = (
                "You are generating REAL artist distractors for a blindtest quiz.\n"
                f"For each item, output {per_item_count} real recording artist names that could plausibly be confused with the correct artist.\n"
                "\nHard rules:\n"
                "- Must be a real artist you are confident exists. If unsure, choose a different one.\n"
                "- Must NOT be the correct artist.\n"
                "- Must fit the playlist vibe (era/scene/language) inferred from the playlist context.\n"
                "- Avoid picking artists wildly outside the playlist theme (e.g., modern trap for an 80s playlist).\n"
                "- Avoid repeating any recent real distractors.\n"
                "- Within each item: all returned artists must be distinct.\n"
                "- Output only the artist name (no feat., no links).\n"
                "\nPlaylist context:\n"
                f"{playlist_context}\n"
                "\nPlaylist artist examples (these indicate the vibe/era; you may use them as inspiration but do not copy the correct artist):\n"
                f"{artists_block}\n"
                "\nRecent real distractors (avoid repeating):\n"
                f"{recent_block}\n"
                "\nExtra banned names (avoid):\n"
                f"{ban_block}\n"
                "\nReturn STRICT JSON ONLY with this schema:\n"
                "{\"results\":[{\"i\":0,\"reals\":[\"...\",\"...\"]}]}\n"
                "Where `i` is the integer index from the input list.\n"
                "\nInput items:\n"
                + "\n".join(
                    f"- i={it['i']} | correct_artist={it['correct_artist']} | track_name={it['track_name']} | album={it['album']}"
                    for it in prompt_items
                )
            )

            try:
                text = self._chat(
                    messages=[
                        {
                            "role": "system",
                            "content": "You output strict JSON only. No markdown. No extra text.",
                        },
                        {"role": "user", "content": prompt},
                    ],
                    temperature=0.6,
                    max_completion_tokens=900,
                )
            except Exception as e:
                print(f"Error generating real distractors batch: {e}")
                break

            obj = self._extract_json_object(text)
            if not obj or "results" not in obj or not isinstance(obj.get("results"), list):
                if attempt >= max_repairs:
                    break
                continue

            for row in obj.get("results", []):
                if not isinstance(row, dict):
                    continue
                i_val = row.get("i")
                reals = row.get("reals")
                try:
                    idx = int(i_val)
                except Exception:
                    continue
                if idx < 0 or idx >= len(normalized_items):
                    continue
                correct_artist = normalized_items[idx]["correct_artist"]

                if not isinstance(reals, list):
                    continue

                picked: List[str] = []
                picked_norm: Set[str] = set()
                for value in reals:
                    if len(picked) >= per_item_count:
                        break
                    if not isinstance(value, str):
                        continue
                    candidate = value.strip()
                    cn = self._norm_name(candidate)
                    if not candidate or cn in picked_norm:
                        continue
                    if validate_real(candidate, correct_artist):
                        picked.append(candidate)
                        picked_norm.add(cn)

                if picked:
                    results[idx] = picked

                    # Update global "recent" memory for the duration of this request
                    for artist in picked:
                        recent_norm.add(self._norm_name(artist))

                if len(results[idx]) >= per_item_count:
                    invalid_indices.discard(idx)

            if not invalid_indices:
                break

        return results


    def generate_fake_artists(self, correct_artist, genre_hint=None, count=3):
        """
        Generate related artist names for a music quiz:
        - (count - 1) real artists that could be confused with the correct one
        - 1 funny fake artist name (not real), similar to the correct one

        Args:
            correct_artist: The real artist name
            genre_hint: Optional genre to make fakes more believable
            count: Total number of answers to return

        Returns:
            List of artist names (real + one funny fake)
        """
        try:
            import re
            import random

            if count <= 0:
                return []
            if count == 1:
                # If only one slot, prefer the funny fake (by design choice)
                real_count = 0
                include_funny_fake = True
            else:
                real_count = count - 1
                include_funny_fake = True

            genre_text = f" in the {genre_hint} genre" if genre_hint else ""
            genre_clause = (
                "\nGenre guidance:\n- Stay within the same broad genre family; adjacent subgenres are allowed."
                if genre_hint else
                "\nGenre guidance:\n- Stay within a similar broad genre family as the correct artist."
            )

            prompt = f"""You are generating multiple-choice options for a blindtest quiz.

    Task:
    1) Generate {real_count} real recording artists that could plausibly be confused with "{correct_artist}"{genre_text}.
    2) Generate 1 funny fake artist name that is clearly NOT a real artist, but is a playful riff.

    Rules for the REAL artists:
    - Must be real artists you are confident exist (not fictional, not labels, not venues).
    - If you are not confident an artist is real, do not include it.
    - Must not be "{correct_artist}".
    - Must be distinct.

    Rules for the FUNNY fake:
    - Must be obviously fictional and comedic (a pun / typo twist / silly remix of the name of an artist).
    - May match any known real artist with a simple changes like adding/removing one letter only.
    - Keep it short (1–4 words).
    - Must be distinct from all real artists generated.
    - Must not be inspired by "{correct_artist}".

    Choose the real distractors using:
    - name similarity (spelling, phonetics, spacing, initials, stage-name style)
    - plausibility similarity (same broad era and audience; not wildly more/less famous){genre_clause}

    Output format (strict):
    Return exactly {real_count + (1 if include_funny_fake else 0)} lines total.
    Each line must be just the name, one per line, no numbering, no bullets, no extra text.
    Put the funny fake on its own line as well.
    """

            response = self.client.chat.completions.create(
                model="gpt-5.2",
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You create quiz answer options. "
                            "For real artists: only output artists you are confident are real. "
                            "Also produce one clearly fictional funny option. "
                            "Return only names, one per line."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=0.7,
                max_completion_tokens=220,
            )

            raw_lines = response.choices[0].message.content.splitlines()

            # Clean common formatting accidents (bullets, numbering, etc.)
            candidates = []
            for line in raw_lines:
                name = re.sub(r"^\s*[-•\d\.\)\:]+\s*", "", line).strip()
                if name:
                    candidates.append(name)

            # De-dupe (case-insensitive) while preserving order, and drop the correct artist if it slips in
            seen = set()
            cleaned = []
            correct_norm = correct_artist.strip().lower()
            for name in candidates:
                n = name.strip()
                n_norm = n.lower()
                if n_norm == correct_norm:
                    continue
                if n_norm in seen:
                    continue
                seen.add(n_norm)
                cleaned.append(n)

            # If the model returns too many or too few, try to make the result usable:
            # - Prefer returning up to 'count'
            cleaned = cleaned[: max(count, 0)]

            # Optional: shuffle so the funny one isn't always last (keeps players honest)
            # If you prefer the funny always included but random position:
            if cleaned and len(cleaned) > 1:
                random.shuffle(cleaned)

            return cleaned[:count]

        except Exception as e:
            print(f"Error generating fake artists: {e}")
            return []


#     def generate_fake_artists(self, correct_artist, genre_hint=None, count=3):
#         """
#         Generate a related existing artist names that sound plausible
        
#         Args:
#             correct_artist: The real artist name
#             genre_hint: Optional genre to make fakes more believable
#             count: Number of related existing artist artists to generate
        
#         Returns:
#             List of related existing artist names
#         """
#         try:
#             genre_text = f" in the {genre_hint} genre" if genre_hint else ""
            
#             prompt = f"""Generate {count} of related existing artist names that could be confused with "{correct_artist}"{genre_text}. 
# Make them sound realistic but ensure they are ARE real artists.
# Return only the names, one per line, without numbering or extra text."""

#             response = self.client.chat.completions.create(
#                 model="gpt-5.2",
#                 messages=[
#                     {"role": "system", "content": "You are a creative assistant that generates related artist names for each artist for a music quiz game."},
#                     {"role": "user", "content": prompt}
#                 ],
#                 temperature=0.8,
#                 max_completion_tokens=100
#             )
            
#             fake_names = response.choices[0].message.content.strip().split('\n')
#             fake_names = [name.strip() for name in fake_names if name.strip()]
            
#             return fake_names[:count]
        
#         except Exception as e:
#             print(f"Error generating fake artists: {e}")
#             # Fallback to generic fake names
#             return [
#                 f"The {correct_artist[0]}{correct_artist[-1]} Band",
#                 f"{correct_artist} Jr.",
#                 f"{correct_artist.split()[0] if ' ' in correct_artist else correct_artist} & Friends"
#             ][:count]


def get_openai_service():
    try:
        return OpenAIService()
    except ValueError as e:
        print(f"Warning: {e}")
        return None
