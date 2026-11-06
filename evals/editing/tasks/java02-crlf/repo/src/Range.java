import java.util.ArrayList;
import java.util.List;

public class Range {
    /** Returns the integers from..to, both inclusive. */
    public static List<Integer> inclusive(int from, int to) {
        List<Integer> out = new ArrayList<>();
        for (int i = from; i < to; i++) {
            out.add(i);
        }
        return out;
    }
}
