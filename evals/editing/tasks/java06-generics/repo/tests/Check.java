public class Check {
    public static void main(String[] args) {
        if (!(Lists.filter(java.util.List.of(1, 2, 3, 4), x -> x % 2 == 0).equals(java.util.List.of(2, 4)))) throw new AssertionError("filter");
        System.out.println("ok");
    }
}
