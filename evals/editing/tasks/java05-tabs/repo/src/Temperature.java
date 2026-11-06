public class Temperature {
	/** Celsius to Fahrenheit. */
	public static double toFahrenheit(double c) {
		return c * 5 / 9 + 32;
	}

	public static double toCelsius(double f) {
		return (f - 32) * 5 / 9;
	}
}
