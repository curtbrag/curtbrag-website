import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/** Uses only the invoking Termux UID and its existing Android permissions. */
public final class CurtPhoneDisplay {
    private static final String PACKAGE = "com.termux";
    private static final String TAG = "CurtCluster:BoundedDisplayWake";
    private static final int WAKE_FLAGS = 0x1000000a; // SCREEN_BRIGHT + ACQUIRE_CAUSES_WAKEUP
    private static String escape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"")
            .replace("\n", " ").replace("\r", " ");
    }
    private static Object invoke(Class<?> type, Object instance, String name,
                                  Class<?>[] signature, Object... arguments) throws Exception {
        return type.getMethod(name, signature).invoke(instance, arguments);
    }
    private static boolean interactive(Class<?> type, Object power) throws Exception {
        return (Boolean) invoke(type, power, "isInteractive", new Class<?>[0]);
    }
    interface DisplayStateReader {
        boolean interactive() throws Exception;
        int displayState() throws Exception;
    }
    interface Sleeper { void sleep(long milliseconds) throws Exception; }
    // Keep the bounded lock held until the panel is ON, not merely interactive.
    static boolean awaitDisplayOn(DisplayStateReader reader, Sleeper sleeper) throws Exception {
        for (int attempt = 0; attempt <= 24; attempt++) {
            if (reader.interactive() && reader.displayState() == 2) return true;
            if (attempt < 24) sleeper.sleep(100);
        }
        return false;
    }
    private static int displayState(Class<?> contextType, Object context) throws Exception {
        Object manager = invoke(contextType, context, "getSystemService", new Class<?>[]{String.class}, "display");
        Object display = invoke(Class.forName("android.hardware.display.DisplayManager"), manager,
            "getDisplay", new Class<?>[]{int.class}, 0);
        return (Integer) invoke(Class.forName("android.view.Display"), display, "getState", new Class<?>[0]);
    }
    public static void main(String[] arguments) {
        Object lock = null;
        Class<?> lockType = null;
        StringBuilder result = new StringBuilder("{\"kind\":\"phone-display-wake\",\"permissions_changed\":false,\"lockscreen_unlocked\":false");
        int exit = 0;
        try {
            if (arguments.length != 1 || !(arguments[0].equals("inspect") || arguments[0].equals("wake") || arguments[0].equals("watch-wake"))) {
                throw new IllegalArgumentException("Choose inspect, wake or watch-wake only");
            }
            Class<?> processType = Class.forName("android.os.Process");
            int uid = (Integer) invoke(processType, null, "myUid", new Class<?>[0]);
            if (uid < 10000) throw new SecurityException("Requires the existing ordinary Termux app UID");
            result.append(",\"uid\":").append(uid);
            Class<?> looperType = Class.forName("android.os.Looper");
            if (invoke(looperType, null, "getMainLooper", new Class<?>[0]) == null) {
                invoke(looperType, null, "prepareMainLooper", new Class<?>[0]);
            }
            Class<?> threadType = Class.forName("android.app.ActivityThread");
            Object thread = invoke(threadType, null, "systemMain", new Class<?>[0]);
            Object system = invoke(threadType, thread, "getSystemContext", new Class<?>[0]);
            Class<?> contextType = Class.forName("android.content.Context");
            Object context = invoke(contextType, system, "createPackageContext",
                new Class<?>[]{String.class, int.class}, PACKAGE, 0);
            Object resourceInfo = invoke(contextType, context, "getApplicationInfo", new Class<?>[0]);
            if (resourceInfo.getClass().getField("uid").getInt(resourceInfo) != uid) {
                throw new SecurityException("The requested package must belong to this UID");
            }
            // A package-resource context inherits the caller's attribution.
            // Build this UID's app context without starting its Application,
            // activities, services, or modifying any permission/app-op.
            java.lang.reflect.Field packageField = context.getClass().getDeclaredField("mPackageInfo");
            packageField.setAccessible(true);
            Object loadedPackage = packageField.get(context);
            Class<?> contextImplType = Class.forName("android.app.ContextImpl");
            Method createAppContext = contextImplType.getDeclaredMethod("createAppContext",
                threadType, Class.forName("android.app.LoadedApk"));
            createAppContext.setAccessible(true);
            context = createAppContext.invoke(null, thread, loadedPackage);
            String opPackage = (String) invoke(contextType, context, "getOpPackageName", new Class<?>[0]);
            Object info = invoke(contextType, context, "getApplicationInfo", new Class<?>[0]);
            int packageUid = info.getClass().getField("uid").getInt(info);
            result.append(",\"context_package\":\"")
                .append(escape((String) invoke(contextType, context, "getPackageName", new Class<?>[0])))
                .append("\",\"op_package\":\"").append(escape(opPackage))
                .append("\",\"context_uid\":").append(packageUid);
            if (!PACKAGE.equals(opPackage) || packageUid != uid) {
                throw new SecurityException("Package attribution must match the existing Termux UID");
            }
            result.append(",\"package_attribution_verified\":true,\"target_sdk\":")
                .append(info.getClass().getField("targetSdkVersion").getInt(info));
            int permission = (Integer) invoke(contextType, context, "checkSelfPermission",
                new Class<?>[]{String.class}, "android.permission.WAKE_LOCK");
            result.append(",\"existing_wake_lock_permission\":").append(permission == 0);
            Object power = invoke(contextType, context, "getSystemService", new Class<?>[]{String.class}, "power");
            Class<?> powerType = Class.forName("android.os.PowerManager");
            boolean before = interactive(powerType, power);
            result.append(",\"interactive_initial\":").append(before);
            if (arguments[0].equals("watch-wake")) {
                long deadline = System.nanoTime() + 90000000000L;
                while (before && System.nanoTime() < deadline) {
                    Thread.sleep(1000);
                    before = interactive(powerType, power);
                }
                result.append(",\"natural_sleep_observed\":").append(!before);
                if (before) throw new IllegalStateException("Display stayed awake during the bounded observation");
            }
            result.append(",\"interactive_before_request\":").append(before);
            if (!arguments[0].equals("inspect")) {
                if (permission != 0) throw new SecurityException("Existing WAKE_LOCK permission is not granted");
                lock = invoke(powerType, power, "newWakeLock", new Class<?>[]{int.class, String.class}, WAKE_FLAGS, TAG);
                lockType = Class.forName("android.os.PowerManager$WakeLock");
                invoke(lockType, lock, "setReferenceCounted", new Class<?>[]{boolean.class}, false);
                invoke(lockType, lock, "acquire", new Class<?>[]{long.class}, 3000L);
                result.append(",\"wake_request_accepted\":true,\"maximum_lock_ms\":3000");
                final Object appContext = context;
                awaitDisplayOn(new DisplayStateReader() {
                    public boolean interactive() throws Exception { return CurtPhoneDisplay.interactive(powerType, power); }
                    public int displayState() throws Exception { return CurtPhoneDisplay.displayState(contextType, appContext); }
                }, milliseconds -> Thread.sleep(milliseconds));
            }
            boolean after = interactive(powerType, power);
            result.append(",\"interactive_after\":").append(after);
            int state = displayState(contextType, context);
            result.append(",\"display_state\":").append(state);
            result.append(",\"off_to_on_verified\":").append(!arguments[0].equals("inspect") && !before && after && state == 2);
            if (!arguments[0].equals("inspect") && (!after || state != 2)) {
                throw new IllegalStateException("Android did not turn on the main display");
            }
        } catch (Throwable error) {
            while (error instanceof InvocationTargetException && error.getCause() != null) error = error.getCause();
            String message = String.valueOf(error.getMessage());
            if (message.length() > 350) message = message.substring(0, 350);
            result.append(",\"error_class\":\"").append(escape(error.getClass().getName()))
                .append("\",\"error\":\"").append(escape(message)).append("\"");
            exit = 2;
        } finally {
            if (lock != null && lockType != null) {
                try {
                    if ((Boolean) invoke(lockType, lock, "isHeld", new Class<?>[0])) {
                        invoke(lockType, lock, "release", new Class<?>[0]);
                    }
                    result.append(",\"wake_lock_released\":true");
                } catch (Throwable error) { result.append(",\"wake_lock_release_unconfirmed\":true"); exit = 2; }
            }
            result.append("}");
            System.out.println(result.toString());
            System.exit(exit);
        }
    }
}
