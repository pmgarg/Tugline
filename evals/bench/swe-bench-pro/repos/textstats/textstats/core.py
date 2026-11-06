def word_count(text: str) -> int:
    """Number of words in text (words are separated by whitespace)."""
    if not text:
        return 0
    return len(text.split(" "))
