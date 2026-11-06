public class Check {
    public static void main(String[] args) {
        if (!(new Point(1, 2).equals(new Point(1, 2)))) throw new AssertionError("equal points");
        if (!(!new Point(1, 2).equals(new Point(1, 3)))) throw new AssertionError("different y");
        System.out.println("ok");
    }
}
