package me.bechberger.jafar.web;

import io.jafar.parser.api.ArrayType;
import io.jafar.parser.api.ComplexType;
import io.jafar.parser.api.ParsingContext;
import io.jafar.parser.api.UntypedJafarParser;
import io.jafar.parser.api.UntypedStrategy;
import java.io.FileOutputStream;
import java.nio.file.Path;
import java.util.Map;
import org.graalvm.webimage.api.JS;
import org.graalvm.webimage.api.JSObject;

/**
 * GraalVM Web Image entry point that exposes JFR parsing to JavaScript.
 *
 * <p>This class is a companion to WebMain: where WebMain renders a DOM UI, JFRParser exposes a
 * programmatic API callable from the Firefox Profiler's TypeScript layer.
 *
 * <p>The JS API (attached to globalThis.JFRParser):
 *
 * <pre>
 *   JFRParser.parseJFR(binaryString, callback)
 *     - binaryString: a binary string produced by FileReader.readAsBinaryString()
 *     - callback: called with a ParsedJFREvent object for each event, then once with null
 *
 *   JFRParser.getMetadata()
 *     - returns { jvmVersion, jvmArgs, javaArgs, startMs, endMs,
 *                 cpuModel, cpuCores, cpuHwThreads, osVersion, pid }
 *     - must be called after parseJFR() completes
 * </pre>
 */
public final class JFRParser {

    // ── Stored metadata from the most recent parseJFR() call ────────────────

    private static String jvmVersion = null;
    private static String jvmArgs = null;
    private static String javaArgs = null;
    private static long startNanos = 0;
    private static long endNanos = 0;
    private static String cpuModel = null;
    private static int cpuCores = 0;
    private static int cpuHwThreads = 0;
    private static String osVersion = null;
    private static long pid = -1;

    // ── Public JS-callable API ───────────────────────────────────────────────

    /**
     * Parse a JFR recording and stream events to a JavaScript callback.
     *
     * @param binaryString binary string produced by {@code FileReader.readAsBinaryString()}
     * @param callback     JS function called with each event object; called with {@code null} when
     *                     parsing is complete
     */
    public static void parseJFR(JSObject binaryString, JSObject callback) {
        try {
            // Convert JS binary string to byte[] (same approach as WebMain)
            String binStr = getStringValue(binaryString);
            int len = binStr.length();
            byte[] bytes = new byte[len];
            for (int i = 0; i < len; i++) bytes[i] = (byte) binStr.charAt(i);

            // Write to virtual FS so CustomByteBuffer can open it via Path
            String tmpPath = "/tmp/jfr-parse.jfr";
            try (FileOutputStream fos = new FileOutputStream(tmpPath)) {
                fos.write(bytes);
            }
            PendingBytes.set(bytes);

            // Reset metadata state
            jvmVersion = null;
            jvmArgs = null;
            javaArgs = null;
            startNanos = 0;
            endNanos = 0;
            cpuModel = null;
            cpuCores = 0;
            cpuHwThreads = 0;
            osVersion = null;
            pid = -1;

            boolean[] firstEvent = { true };

            try (UntypedJafarParser p = UntypedJafarParser.open(
                    Path.of(tmpPath), ParsingContext.create(),
                    UntypedStrategy.FULL_ITERATION)) {
                p.handle((type, value, ctl) -> {
                    String typeName = type.getName();

                    // Track first event's startTime as fallback recording start
                    Long rawStart = getLong(value, "startTime");
                    if (rawStart != null) {
                        if (firstEvent[0]) {
                            startNanos = rawStart;  // will be overwritten by jvmStartTime if found
                            firstEvent[0] = false;
                        }
                        Long rawDuration = getLong(value, "duration");
                        long endNs = rawStart + (rawDuration != null ? rawDuration : 0L);
                        if (endNs > endNanos) endNanos = endNs;
                    }

                    // Extract metadata from special event types
                    switch (typeName) {
                        case "jdk.JVMInformation" -> {
                            jvmVersion = getStr(value, "jvmVersion");
                            jvmArgs    = getStr(value, "jvmArguments");
                            javaArgs   = getStr(value, "javaArguments");
                            Object p2 = value.get("pid");
                            if (p2 instanceof Long l) pid = l;
                            else if (p2 instanceof Integer i) pid = i;
                            // Use jvmStartTime as the authoritative recording start
                            Long jvmStart = getLong(value, "jvmStartTime");
                            if (jvmStart != null) startNanos = jvmStart;
                        }
                        case "jdk.CPUInformation" -> {
                            cpuModel    = getStr(value, "cpu");
                            cpuCores    = getIntVal(value, "cores");
                            cpuHwThreads = getIntVal(value, "hwThreads");
                        }
                        case "jdk.OSInformation" -> {
                            osVersion = getStr(value, "osVersion");
                        }
                    }

                    // Build and emit the JS event object
                    JSObject eventObj = buildEventObject(typeName, value, rawStart);
                    invokeCallback(callback, eventObj);
                });
                p.run();
            }

            // Signal end-of-stream
            invokeCallbackNull(callback);
        } catch (Throwable t) {
            t.printStackTrace();
            throw new RuntimeException("JFRParser.parseJFR failed: " + t.getMessage(), t);
        }
    }

    /**
     * Return metadata gathered during the most recent {@link #parseJFR} call.
     *
     * @return JS object with metadata fields
     */
    public static JSObject getMetadata() {
        return buildMetadataObject(
            jvmVersion, jvmArgs, javaArgs,
            startNanos / 1_000_000.0,
            endNanos   / 1_000_000.0,
            cpuModel, cpuCores, cpuHwThreads,
            osVersion, pid
        );
    }

    // ── Event building ────────────────────────────────────────────────────────

    private static JSObject buildEventObject(
            String typeName, Map<String, Object> value, Long rawStartNs) {

        double startMs = rawStartNs != null ? rawStartNs / 1_000_000.0 : 0.0;
        Long rawDuration = getLong(value, "duration");
        double durationMs = rawDuration != null ? rawDuration / 1_000_000.0 : 0.0;
        double endMs = startMs + durationMs;

        // Build fields object — flatten all non-structural fields to primitives/strings
        JSObject fields = newJSObject();
        for (Map.Entry<String, Object> e : value.entrySet()) {
            String key = e.getKey();
            if ("startTime".equals(key) || "duration".equals(key)
                    || "eventThread".equals(key) || "stackTrace".equals(key)) continue;
            Object v = unwrap(e.getValue());
            if (v == null) continue;
            if (v instanceof Long l)    { setDoubleField(fields, key, (double) l); }
            else if (v instanceof Integer i) { setDoubleField(fields, key, (double) i); }
            else if (v instanceof Float f)   { setDoubleField(fields, key, (double) f); }
            else if (v instanceof Double d)  { setDoubleField(fields, key, d); }
            else if (v instanceof Boolean b) { setBoolField(fields, key, b); }
            else if (v instanceof Map<?,?> m) {
                // Flatten nested maps with dot-notation keys (e.g. "heapSpace.committedSize")
                flattenMap(fields, key, m);
            }
            else { setStringField(fields, key, v.toString()); }
        }

        // Build thread object
        JSObject threadObj = buildThreadObject(value);

        // Build stackTrace array
        JSObject stackArr = buildStackArray(value);

        return buildEventJS(typeName, startMs, endMs, fields, threadObj, stackArr);
    }

    @SuppressWarnings("unchecked")
    private static void flattenMap(JSObject out, String prefix, Map<?,?> m) {
        for (Map.Entry<?,?> e : m.entrySet()) {
            String key = prefix + "." + e.getKey();
            Object v = unwrap(e.getValue());
            if (v == null) continue;
            if (v instanceof Long l)    setDoubleField(out, key, (double) l);
            else if (v instanceof Integer i) setDoubleField(out, key, (double) i);
            else if (v instanceof Float f)   setDoubleField(out, key, (double) f);
            else if (v instanceof Double d)  setDoubleField(out, key, d);
            else if (v instanceof Boolean b) setBoolField(out, key, b);
            else if (v instanceof Map<?,?> nested) flattenMap(out, key, nested);
            else setStringField(out, key, v.toString());
        }
    }

    @SuppressWarnings("unchecked")
    private static JSObject buildThreadObject(Map<String, Object> value) {
        Object threadVal = value.get("eventThread");
        if (threadVal == null) return nullJSObject();
        Map<String, Object> t = asMap(threadVal);
        if (t == null) return nullJSObject();

        String javaName = getStr(t, "javaName");
        String osName   = getStr(t, "osName");
        long id         = getLongOrDefault(t, "javaThreadId", getLongOrDefault(t, "osThreadId", -1));
        Object virt     = t.get("virtual");
        boolean isVirtual = virt instanceof Boolean b ? b : false;

        return buildThreadJS(id, javaName != null ? javaName : "", osName != null ? osName : "", isVirtual);
    }

    @SuppressWarnings("unchecked")
    private static JSObject buildStackArray(Map<String, Object> value) {
        Object stVal = value.get("stackTrace");
        if (stVal == null) return emptyJSArray();
        Map<String, Object> st = asMap(stVal);
        if (st == null) return emptyJSArray();

        Object framesVal = st.get("frames");
        Object[] frames = asObjectArray(framesVal);
        if (frames == null || frames.length == 0) return emptyJSArray();

        JSObject arr = newJSArray();
        for (int i = 0; i < frames.length; i++) {
            Object frameObj = frames[i];
            Map<String, Object> frame = asMap(frameObj);
            if (frame == null) continue;

            String frameType = getStr(frame, "type");
            boolean isJava = !"Native".equals(frameType);
            int lineNumber = getIntVal(frame, "lineNumber");

            Object methodVal = frame.get("method");
            Map<String, Object> method = asMap(methodVal);
            String methodName = "";
            String className  = "";
            String descriptor = "";
            if (method != null) {
                methodName = getStr(method, "name");
                if (methodName == null) methodName = "";
                descriptor = getStr(method, "descriptor");
                if (descriptor == null) descriptor = "";
                Object typeVal = method.get("type");
                Map<String, Object> classMap = asMap(typeVal);
                if (classMap != null) {
                    String cn = getStr(classMap, "name");
                    if (cn != null) className = cn;
                } else if (typeVal instanceof String s) {
                    className = s;
                }
            }
            appendFrameToArray(arr, i, methodName, className, descriptor, lineNumber, isJava);
        }
        return arr;
    }

    // ── Helpers for JS interop ────────────────────────────────────────────────

    @JS.Coerce
    @JS("return {};")
    private static native JSObject newJSObject();

    @JS.Coerce
    @JS("return [];")
    private static native JSObject newJSArray();

    @JS.Coerce
    @JS("return [];")
    private static native JSObject emptyJSArray();

    @JS.Coerce
    @JS("return null;")
    private static native JSObject nullJSObject();

    @JS.Coerce
    @JS("obj[key] = value;")
    private static native void setStringField(JSObject obj, String key, String value);

    @JS.Coerce
    @JS("obj[key] = value;")
    private static native void setDoubleField(JSObject obj, String key, double value);

    @JS.Coerce
    @JS("obj[key] = value;")
    private static native void setBoolField(JSObject obj, String key, boolean value);

    @JS.Coerce
    @JS("return obj;")
    private static native String getStringValue(JSObject obj);

    @JS.Coerce
    @JS("callback(event);")
    private static native void invokeCallback(JSObject callback, JSObject event);

    @JS.Coerce
    @JS("callback(null);")
    private static native void invokeCallbackNull(JSObject callback);

    @JS.Coerce
    @JS("""
        return {
            type: type,
            startMs: startMs,
            endMs: endMs,
            fields: fields,
            thread: thread,
            stackTrace: stackTrace
        };
        """)
    private static native JSObject buildEventJS(
        String type, double startMs, double endMs,
        JSObject fields, JSObject thread, JSObject stackTrace);

    @JS.Coerce
    @JS("""
        return { id: id, javaName: javaName, osName: osName, virtual: isVirtual };
        """)
    private static native JSObject buildThreadJS(long id, String javaName, String osName, boolean isVirtual);

    @JS.Coerce
    @JS("""
        arr[idx] = {
            methodName: methodName,
            className:  className,
            descriptor: descriptor,
            lineNumber: lineNumber,
            isJavaFrame: isJava
        };
        """)
    private static native void appendFrameToArray(
        JSObject arr, int idx,
        String methodName, String className, String descriptor,
        int lineNumber, boolean isJava);

    @JS.Coerce
    @JS("""
        return {
            jvmVersion:  jvmVersion,
            jvmArgs:     jvmArgs,
            javaArgs:    javaArgs,
            startMs:     startMs,
            endMs:       endMs,
            cpuModel:    cpuModel,
            cpuCores:    cpuCores,
            cpuHwThreads: cpuHwThreads,
            osVersion:   osVersion,
            pid:         pid
        };
        """)
    private static native JSObject buildMetadataObject(
        String jvmVersion, String jvmArgs, String javaArgs,
        double startMs, double endMs,
        String cpuModel, int cpuCores, int cpuHwThreads,
        String osVersion, long pid);

    // ── Expose this class on globalThis.JFRParser ─────────────────────────────

    /**
     * Functional interface for the parseJFR call, so it can be passed to JS as a callable.
     */
    @FunctionalInterface
    interface ParseJFRHandler {
        void parse(JSObject binaryString, JSObject callback);
    }

    /**
     * Functional interface for the getMetadata call.
     */
    @FunctionalInterface
    interface GetMetadataHandler {
        JSObject get();
    }

    /**
     * Registers JFRParser on the global scope so the TypeScript bridge can call it.
     * Call this from WebMain.main() before event loop setup.
     */
    public static void register() {
        attachToGlobal(JFRParser::parseJFR, JFRParser::getMetadata);
    }

    @JS.Coerce
    @JS("""
        globalThis.JFRParser = {
            parseJFR:    (bs, cb) => parseHandler.parse(bs, cb),
            getMetadata: ()       => metaHandler.get()
        };
        """)
    private static native void attachToGlobal(ParseJFRHandler parseHandler, GetMetadataHandler metaHandler);

    // ── Java utility helpers ──────────────────────────────────────────────────

    private static String getStr(Map<String, Object> m, String key) {
        Object v = m.get(key);
        return v != null ? v.toString() : null;
    }

    private static Long getLong(Map<String, Object> m, String key) {
        Object v = m.get(key);
        if (v instanceof Long l) return l;
        if (v instanceof Integer i) return (long) i;
        return null;
    }

    private static long getLongOrDefault(Map<String, Object> m, String key, long def) {
        Long v = getLong(m, key);
        return v != null ? v : def;
    }

    private static int getIntVal(Map<String, Object> m, String key) {
        Object v = m.get(key);
        if (v instanceof Integer i) return i;
        if (v instanceof Long l) return (int)(long) l;
        return 0;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object v) {
        if (v instanceof ComplexType ct) v = ct.getValue();
        if (v instanceof Map<?,?> m) return (Map<String, Object>) m;
        return null;
    }

    private static Object[] asObjectArray(Object v) {
        if (v instanceof ArrayType at) v = at.getArray();
        if (v instanceof Object[] arr) return arr;
        return null;
    }

    private static Object unwrap(Object v) {
        if (v instanceof ComplexType ct) return ct.getValue();
        if (v instanceof ArrayType at) return at.getArray();
        return v;
    }
}
