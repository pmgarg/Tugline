from pathlib import Path


def test_hello_file_exists():
    assert Path("hello.txt").exists()


def test_hello_file_content():
    assert Path("hello.txt").read_text() == "Hello, world!\n"
