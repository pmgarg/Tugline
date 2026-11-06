package shipping

import "time"

// Event is one scan of a parcel by the carrier.
type Event struct {
	At       time.Time
	Location string
	Status   string
}

// Timeline keeps the scans of one parcel in order.
type Timeline struct {
	Number string
	Events []Event
}

// Add records a carrier scan.
func (t *Timeline) Add(e Event) {
	t.Events = append(t.Events, e)
}

// Delivered reports whether the last scan says the parcel arrived.
func (t *Timeline) Delivered() bool {
	return len(t.Events) > 0 && t.Events[len(t.Events)-1].Status == "delivered"
}
