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
        Generate a related existing artist names that sound plausible
        
        Args:
            correct_artist: The real artist name
            genre_hint: Optional genre to make fakes more believable
            count: Number of related existing artist artists to generate
        
        Returns:
            List of related existing artist names
        """
        try:
            genre_text = f" in the {genre_hint} genre" if genre_hint else ""
            
            prompt = f"""Generate {count} of related existing artist names that could be confused with "{correct_artist}"{genre_text}. 
Make them sound realistic but ensure they are ARE real artists.
Return only the names, one per line, without numbering or extra text."""

            response = self.client.chat.completions.create(
                model="gpt-5.2",
                messages=[
                    {"role": "system", "content": "You are a creative assistant that generates related artist names for each artist for a music quiz game."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.8,
                max_completion_tokens=100
            )
            
            fake_names = response.choices[0].message.content.strip().split('\n')
            fake_names = [name.strip() for name in fake_names if name.strip()]
            
            return fake_names[:count]
        
        except Exception as e:
            print(f"Error generating fake artists: {e}")
            # Fallback to generic fake names
            return [
                f"The {correct_artist[0]}{correct_artist[-1]} Band",
                f"{correct_artist} Jr.",
                f"{correct_artist.split()[0] if ' ' in correct_artist else correct_artist} & Friends"
            ][:count]


def get_openai_service():
    try:
        return OpenAIService()
    except ValueError as e:
        print(f"Warning: {e}")
        return None
