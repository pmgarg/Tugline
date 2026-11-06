package calc

import "testing"

func TestStack(t *testing.T) {
	var s Stack
	s.Push(1)
	s.Push(2)
	if x, _ := s.Pop(); x != 2 {
		t.Fatal(x)
	}
	if x, _ := s.Pop(); x != 1 {
		t.Fatal(x)
	}
	if _, ok := s.Pop(); ok {
		t.Fatal("empty")
	}
}
