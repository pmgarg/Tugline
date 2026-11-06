public class Check {
    public static void main(String[] args) {
        if (!(Temperature.toFahrenheit(100) == 212)) throw new AssertionError("f");
        if (!(Temperature.toCelsius(212) == 100)) throw new AssertionError("c");
        System.out.println("ok");
    }
}
