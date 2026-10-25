public class DisplayWakeWaitTest {
    static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
    public static void main(String[] args) throws Exception {
        int[] sleeps = {0};
        CurtPhoneDisplay.DisplayStateReader delayedPanel = new CurtPhoneDisplay.DisplayStateReader() {
            public boolean interactive() { return true; }
            public int displayState() { return sleeps[0] >= 4 ? 2 : 1; }
        };
        check(CurtPhoneDisplay.awaitDisplayOn(delayedPanel, ms -> sleeps[0]++), "wait for panel ON after interactive");
        check(sleeps[0] == 4, "must not release the lock at interactive=true, display=OFF");
        sleeps[0] = 0;
        check(CurtPhoneDisplay.awaitDisplayOn(delayedPanel, ms -> sleeps[0] = 4), "panel eventually turns on");
        CurtPhoneDisplay.DisplayStateReader offPanel = new CurtPhoneDisplay.DisplayStateReader() {
            public boolean interactive() { return true; }
            public int displayState() { return 1; }
        };
        sleeps[0] = 0;
        check(!CurtPhoneDisplay.awaitDisplayOn(offPanel, ms -> { check(ms == 100, "bounded interval"); sleeps[0]++; }), "never claim success for an off panel");
        check(sleeps[0] == 24, "bounded wait stays below the existing three-second lock");
        CurtPhoneDisplay.DisplayStateReader alreadyOn = new CurtPhoneDisplay.DisplayStateReader() {
            public boolean interactive() { return true; }
            public int displayState() { return 2; }
        };
        check(CurtPhoneDisplay.awaitDisplayOn(alreadyOn, ms -> { throw new AssertionError("no wait for already-on panel"); }), "already on");
        System.out.println("Display transition regression checks passed");
    }
}
