import os
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()


class OpenAIService:
    def __init__(self):
        api_key = os.getenv('OPENAI_API_KEY')
        
        if not api_key:
            raise ValueError("OpenAI API key not found in environment variables")
        
        self.client = OpenAI(api_key=api_key)


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
