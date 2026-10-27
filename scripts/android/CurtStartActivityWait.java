import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URI;
import java.util.Locale;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** One ordinary same-UID request; never grants authority or retries a launch. */
public final class CurtStartActivityWait {
    private static final String PACKAGE = "com.termux";
    private static final String TERMUX_ACTIVITY = "com.termux.app.TermuxActivity";
    private static final int WAIT_SECONDS = 10;
    private static final int VISIBILITY_WAIT_SECONDS = 2;

    private static String escape(String value) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch == '\\' || ch == '"') out.append('\\').append(ch);
            else if (ch < 32 || ch == 127) out.append(' ');
            else out.append(ch);
        }
        return out.toString();
    }

    private static Object invoke(Class<?> type, Object target, String name,
                                 Class<?>[] signature, Object... arguments) throws Exception {
        return type.getMethod(name, signature).invoke(target, arguments);
    }

    private static String validatedUrl(String value) throws Exception {
        if (value == null || value.length() == 0 || value.length() > 2048) throw new IllegalArgumentException("URL length");
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch <= 32 || ch == 127 || ch == '\\') throw new IllegalArgumentException("URL characters");
        }
        int fragment = value.indexOf('#');
        URI uri = new URI(fragment < 0 ? value : value.substring(0, fragment));
        String host = uri.getHost();
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getRawUserInfo() != null
                || host == null || host.length() > 253 || host.endsWith(".")
                || (uri.getPort() != -1 && uri.getPort() != 443)) throw new IllegalArgumentException("Public HTTPS URL required");
        host = host.toLowerCase(Locale.ROOT);
        String[] labels = host.split("\\.", -1);
        if (labels.length < 2 || labels[labels.length - 1].matches("[0-9]+")) throw new IllegalArgumentException("Public hostname required");
        for (String label : labels) {
            if (!label.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")) throw new IllegalArgumentException("Hostname label");
        }
        String reserved = "|localhost|local|localdomain|home|lan|internal|test|invalid|onion|example|";
        if (reserved.contains("|" + labels[labels.length - 1] + "|")) throw new IllegalArgumentException("Reserved hostname");
        return value;
    }

    private static String classification(int result) {
        if (result == 0) return "START_SUCCESS";
        if (result == 2) return "START_TASK_TO_FRONT";
        if (result == 3) return "START_DELIVERED_TO_TOP";
        if (result == 102) return "START_ABORTED";
        return "UNRECOGNIZED_RESULT";
    }

    private static final class VisibilitySnapshot {
        final boolean complete;
        final int focusedVisible;
        VisibilitySnapshot(boolean complete, int focusedVisible) {
            this.complete = complete;
            this.focusedVisible = focusedVisible;
        }
        String toJson(int samples) {
            return "{\"query_succeeded\":true,\"task_snapshot_complete\":" + complete
                + ",\"focused_visible_termux_task_count\":" + focusedVisible + ",\"visibility_samples\":" + samples + "}";
        }
    }

    private static VisibilitySnapshot ownTermuxVisibility(Class<?> contextType, Object context) throws Exception {
        Object manager = invoke(contextType, context, "getSystemService", new Class<?>[]{ String.class }, "activity");
        java.util.List<?> tasks = (java.util.List<?>) invoke(Class.forName("android.app.ActivityManager"), manager, "getAppTasks", new Class<?>[0]);
        if (tasks == null) throw new IllegalStateException("Own task query unavailable");
        Class<?> appTaskType = Class.forName("android.app.ActivityManager$AppTask");
        Class<?> componentType = Class.forName("android.content.ComponentName");
        int inspected = 0, focusedVisible = 0;
        for (Object task : tasks) {
            if (inspected++ >= 16) break;
            Object info = invoke(appTaskType, task, "getTaskInfo", new Class<?>[0]);
            Object top = info.getClass().getField("topActivity").get(info);
            // Own-app tasks may contain another app's activity. Ignore those
            // components without including their names or details in the result.
            if (top == null || !PACKAGE.equals(invoke(componentType, top, "getPackageName", new Class<?>[0]))) continue;
            if (!TERMUX_ACTIVITY.equals(invoke(componentType, top, "getClassName", new Class<?>[0]))) continue;
            boolean visible = info.getClass().getField("isVisible").getBoolean(info);
            boolean focused = info.getClass().getField("isFocused").getBoolean(info);
            int displayId = info.getClass().getField("displayId").getInt(info);
            boolean sleeping = info.getClass().getField("isSleeping").getBoolean(info);
            // One exact Termux task must be focused and visible on the awake
            // main phone display. Focus on another display is insufficient.
            if (visible && focused && displayId == 0 && !sleeping) focusedVisible++;
        }
        return new VisibilitySnapshot(tasks.size() <= 16, focusedVisible);
    }

    private static String boundedTermuxVisibility(final Class<?> contextType, final Object context) {
        FutureTask<String> inspection = new FutureTask<String>(new Callable<String>() {
            public String call() throws Exception {
                for (int sample = 1; sample <= 4; sample++) {
                    VisibilitySnapshot snapshot = ownTermuxVisibility(contextType, context);
                    if (snapshot.focusedVisible > 0 || !snapshot.complete || sample == 4) return snapshot.toJson(sample);
                    // Observe a possible UI transition; never send another
                    // launch or move a task while waiting for the snapshot.
                    Thread.sleep(150);
                }
                throw new IllegalStateException("Own visibility observation did not finish");
            }
        });
        Thread worker = new Thread(inspection, "CurtOwnTermuxVisibility");
        worker.setDaemon(true);
        worker.start();
        try {
            return inspection.get(VISIBILITY_WAIT_SECONDS, TimeUnit.SECONDS);
        } catch (TimeoutException error) {
            return "{\"query_succeeded\":false,\"task_snapshot_complete\":false,\"focused_visible_termux_task_count\":0,\"query_timed_out\":true}";
        } catch (Exception error) {
            return "{\"query_succeeded\":false,\"task_snapshot_complete\":false,\"focused_visible_termux_task_count\":0}";
        }
    }

    public static void main(String[] arguments) {
        StringBuilder report = new StringBuilder("{\"kind\":\"cluster-android-start-result\",\"permissions_changed\":false,\"settings_changed\":false,\"identity_changed\":false,\"visible_screen_verified\":false");
        int exit = 0;
        boolean entered = false;
        try {
            if (arguments.length < 1) throw new IllegalArgumentException("Action required");
            final String action = arguments[0];
            final String url;
            if (action.equals("open-website") && arguments.length == 2) url = validatedUrl(arguments[1]);
            else if (action.equals("return-termux") && arguments.length == 1) url = null;
            else throw new IllegalArgumentException("Unsupported fixed action");
            report.append(",\"action\":\"").append(action).append('"');
            if (url != null) report.append(",\"url\":\"").append(escape(url)).append('"');

            Class<?> processType = Class.forName("android.os.Process");
            int uid = (Integer) invoke(processType, null, "myUid", new Class<?>[0]);
            int appId = uid % 100000;
            if (uid < 10000 || appId < 10000 || appId >= 99000) throw new SecurityException("Ordinary installed app UID required");
            int sdk = Class.forName("android.os.Build$VERSION").getField("SDK_INT").getInt(null);
            if (sdk != 35) throw new UnsupportedOperationException("Reviewed Android API35 signature required");
            int userId = uid / 100000;
            report.append(",\"uid\":").append(uid).append(",\"user_id\":").append(userId).append(",\"sdk\":").append(sdk);
            Class<?> looperType = Class.forName("android.os.Looper");
            if (invoke(looperType, null, "getMainLooper", new Class<?>[0]) == null) invoke(looperType, null, "prepareMainLooper", new Class<?>[0]);
            Class<?> threadType = Class.forName("android.app.ActivityThread");
            Object thread = invoke(threadType, null, "systemMain", new Class<?>[0]);
            Object system = invoke(threadType, thread, "getSystemContext", new Class<?>[0]);
            Class<?> contextType = Class.forName("android.content.Context");
            Object context = invoke(contextType, system, "createPackageContext", new Class<?>[]{ String.class, int.class }, PACKAGE, 0);
            Object info = invoke(contextType, context, "getApplicationInfo", new Class<?>[0]);
            if (info.getClass().getField("uid").getInt(info) != uid) throw new SecurityException("Package must belong to the actual invoking UID");
            java.lang.reflect.Field packageField = context.getClass().getDeclaredField("mPackageInfo");
            packageField.setAccessible(true);
            Object loadedPackage = packageField.get(context);
            Method appContext = Class.forName("android.app.ContextImpl").getDeclaredMethod("createAppContext", threadType, Class.forName("android.app.LoadedApk"));
            appContext.setAccessible(true);
            context = appContext.invoke(null, thread, loadedPackage);
            String opPackage = (String) invoke(contextType, context, "getOpPackageName", new Class<?>[0]);
            String contextPackage = (String) invoke(contextType, context, "getPackageName", new Class<?>[0]);
            info = invoke(contextType, context, "getApplicationInfo", new Class<?>[0]);
            if (!PACKAGE.equals(opPackage) || !PACKAGE.equals(contextPackage) || info.getClass().getField("uid").getInt(info) != uid) throw new SecurityException("Same UID Termux attribution required");
            report.append(",\"calling_package\":\"com.termux\",\"package_attribution_verified\":true,\"caller_thread_is_null\":true,\"options_are_null\":true");

            Class<?> intentType = Class.forName("android.content.Intent");
            Object intent;
            if (url != null) {
                Class<?> uriType = Class.forName("android.net.Uri");
                intent = intentType.getConstructor(String.class).newInstance("android.intent.action.VIEW");
                invoke(intentType, intent, "setData", new Class<?>[]{ uriType }, invoke(uriType, null, "parse", new Class<?>[]{ String.class }, url));
                invoke(intentType, intent, "addFlags", new Class<?>[]{ int.class }, 0x18000000);
                // The default browser resolves this Intent. com.termux is only
                // the verified calling package, never the website target.
            } else {
                intent = intentType.getConstructor(String.class).newInstance("android.intent.action.MAIN");
                invoke(intentType, intent, "addCategory", new Class<?>[]{ String.class }, "android.intent.category.LAUNCHER");
                invoke(intentType, intent, "setClassName", new Class<?>[]{ String.class, String.class }, PACKAGE, TERMUX_ACTIVITY);
                invoke(intentType, intent, "addFlags", new Class<?>[]{ int.class }, 0x10000000);
            }
            final Object service = invoke(Class.forName("android.app.ActivityTaskManager"), null, "getService", new Class<?>[0]);
            Class<?> managerType = Class.forName("android.app.IActivityTaskManager");
            if (!managerType.isInstance(service)) throw new SecurityException("Activity task manager interface unavailable");
            final Method start = managerType.getMethod("startActivityAndWait", new Class<?>[]{
                Class.forName("android.app.IApplicationThread"), String.class, String.class, intentType, String.class,
                Class.forName("android.os.IBinder"), String.class, int.class, int.class,
                Class.forName("android.app.ProfilerInfo"), Class.forName("android.os.Bundle"), int.class });
            final Object[] callArguments = { null, PACKAGE, null, intent, null, null, null, -1, 0, null, null, userId };
            FutureTask<Object> call = new FutureTask<Object>(new Callable<Object>() {
                public Object call() throws Exception { return start.invoke(service, callArguments); }
            });
            Thread worker = new Thread(call, "CurtSameUidStartWait");
            worker.setDaemon(true);
            entered = true;
            worker.start();
            Object wait = call.get(WAIT_SECONDS, TimeUnit.SECONDS);
            Class<?> waitType = Class.forName("android.app.WaitResult");
            if (wait == null || !waitType.isInstance(wait)) throw new IllegalStateException("No Android WaitResult");
            int raw = waitType.getField("result").getInt(wait);
            boolean waitTimedOut = waitType.getField("timeout").getBoolean(wait);
            Object who = waitType.getField("who").get(wait);
            String component = who == null ? null : (String) invoke(Class.forName("android.content.ComponentName"), who, "flattenToShortString", new Class<?>[0]);
            report.append(",\"wait_result_received\":true,\"raw_start_result\":").append(raw)
                .append(",\"classification\":\"").append(classification(raw)).append("\",\"wait_timed_out\":").append(waitTimedOut)
                .append(",\"reported_component\":");
            if (component == null) report.append("null");
            else report.append('"').append(escape(component.substring(0, Math.min(component.length(), 180)))).append('"');
            report.append(",\"reported_total_time_ms\":").append(waitType.getField("totalTime").getLong(wait));
            if (action.equals("return-termux") && !waitTimedOut && (raw == 0 || raw == 2 || raw == 3)) {
                report.append(",\"termux_visibility\":").append(boundedTermuxVisibility(contextType, context));
            }
        } catch (TimeoutException error) {
            report.append(",\"binder_call_timed_out\":true,\"wait_result_received\":false");
            exit = 2;
        } catch (Throwable error) {
            while ((error instanceof InvocationTargetException || error instanceof ExecutionException) && error.getCause() != null) error = error.getCause();
            report.append(",\"error_class\":\"").append(escape(error.getClass().getName())).append('"');
            exit = 2;
        } finally {
            report.append(",\"activity_request_entered\":").append(entered).append(",\"maximum_activity_requests\":1,\"no_retry\":true}");
            System.out.println(report.toString());
            System.exit(exit);
        }
    }
}
