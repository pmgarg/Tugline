from .merge import merge

DEFAULTS = {
    "name": "app",
    "debug": False,
    "database": {"host": "localhost", "port": 5432, "options": {"timeout": 5, "ssl": False}},
}


def load_config(overrides=None):
    """Defaults with the user's overrides applied."""
    return merge(DEFAULTS, overrides or {})
