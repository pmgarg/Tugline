package shipping

import "math"

// Zone is a delivery region.
type Zone int

const (
	Domestic Zone = iota
	Europe
	World
)

var perKilo = map[Zone]float64{Domestic: 1.2, Europe: 3.5, World: 7.9}

// Quote returns the delivery price for a parcel of the given weight in grams.
func Quote(grams int, zone Zone, express bool) float64 {
	kilos := math.Ceil(float64(grams) / 1000)
	price := 4.0 + kilos*perKilo[zone]
	if express {
		price *= 1.8
	}
	return math.Round(price*100) / 100
}
