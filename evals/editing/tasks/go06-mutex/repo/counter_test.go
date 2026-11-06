package calc

import (
	"testing"
	"time"
)

// Deterministic: Inc must wait while someone else holds the mutex.
func TestIncLocks(t *testing.T) {
	c := NewCounter()
	c.mu.Lock()
	done := make(chan bool)
	go func() { c.Inc("k"); done <- true }()
	select {
	case <-done:
		c.mu.Unlock()
		t.Fatal("Inc did not wait for the mutex")
	case <-time.After(200 * time.Millisecond):
	}
	c.mu.Unlock()
	<-done
	if c.Get("k") != 1 {
		t.Fatal(c.Get("k"))
	}
}

func TestCounter(t *testing.T) {
	c := NewCounter()
	done := make(chan bool)
	for g := 0; g < 8; g++ {
		go func() {
			for i := 0; i < 5000; i++ {
				c.Inc("k")
			}
			done <- true
		}()
	}
	for g := 0; g < 8; g++ {
		<-done
	}
	if c.Get("k") != 40000 {
		t.Fatal(c.Get("k"))
	}
}
