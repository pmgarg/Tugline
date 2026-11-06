package inventory

import (
	"errors"
	"sync"
)

var ErrOutOfStock = errors.New("not enough units")

// Warehouse holds units per SKU and units held for open checkouts.
type Warehouse struct {
	mu       sync.Mutex
	units    map[string]int
	reserved map[string]int
}

// Hold sets units aside for a checkout so two buyers cannot take the last item.
func (w *Warehouse) Hold(sku string, n int) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.units[sku]-w.reserved[sku] < n {
		return ErrOutOfStock
	}
	w.reserved[sku] += n
	return nil
}

// Release returns held units when a checkout is abandoned.
func (w *Warehouse) Release(sku string, n int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.reserved[sku] -= n
}
