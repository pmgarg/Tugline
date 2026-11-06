package calc

type Stack struct{ items []int }

func (s *Stack) Push(x int) { s.items = append(s.items, x) }

// Pop removes and returns the top (most recently pushed) item; ok is false when empty.
func (s *Stack) Pop() (int, bool) {
	if len(s.items) == 0 {
		return 0, false
	}
	x := s.items[len(s.items)-1]
	s.items = s.items[:len(s.items)-1]
	return x, true
}
