public class Check {
    public static void main(String[] args) {
        if (!(Range.inclusive(1, 3).equals(java.util.List.of(1, 2, 3)))) throw new AssertionError("inclusive");
        System.out.println("ok");
    }
}
