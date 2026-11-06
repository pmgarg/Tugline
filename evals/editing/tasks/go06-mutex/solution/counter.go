package calc

import "sync"

// Counter is safe for concurrent use.
type Counter struct {
	mu sync.Mutex
	n  map[string]int
}

func NewCounter() *Counter { return &Counter{n: map[string]int{}} }

func (c *Counter) Inc(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n[key]++
}

func (c *Counter) Get(key string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n[key]
}
