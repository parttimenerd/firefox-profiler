package me.bechberger.jafar.web;

import io.jafar.parser.api.ArrayType;
import io.jafar.parser.api.ComplexType;
import io.jafar.parser.api.ParsingContext;
import io.jafar.parser.api.UntypedJafarParser;
import io.jafar.parser.api.UntypedStrategy;
import io.jafar.parser.internal_api.metadata.AbstractMetadataElement;
import io.jafar.parser.internal_api.metadata.MetadataAnnotation;
import io.jafar.parser.internal_api.metadata.MetadataClass;
import io.jafar.parser.internal_api.metadata.MetadataField;
import java.io.FileOutputStream;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import me.bechberger.jafar.web.converter.JsonWriter;
import me.bechberger.jafar.web.converter.MarkerSchemas;
import me.bechberger.jafar.web.converter.Processor;
import org.graalvm.webimage.api.JS;
import org.graalvm.webimage.api.JSObject;

/**
 * GraalVM Web Image entry point. Single JS-callable method:
 *
 * <pre>
 *   JFRParser.parseToProfileJSON(binaryString) → string
 * </pre>
 *
 * <p>Parses the JFR binary AND runs the full Profile conversion in a single
 * streaming pass through the events. No in-memory event buffer — each event is
 * fed directly to {@link Processor#process} as it is decoded.
 */
public final class JFRParser {

    public static String parseToProfileJSON(JSObject wrapped) {
        try {
            String binaryString = getStringProperty(wrapped, "value");
            int len = binaryString.length();
            byte[] bytes = new byte[len];
            for (int i = 0; i < len; i++) bytes[i] = (byte) binaryString.charAt(i);
            // Drop the string reference so the JVM can collect it.
            binaryString = null;

            String tmpPath = "/tmp/jfr-parse.jfr";
            try (FileOutputStream fos = new FileOutputStream(tmpPath)) {
                fos.write(bytes);
            }
            PendingBytes.set(bytes);

            // Metadata accumulators — populated from special metadata events as
            // they appear in the parser stream.
            String[] jvmVersion = { null };
            String[] jvmArgs = { null };
            String[] javaArgs = { null };
            long[] startNanos = { 0L };
            long[] endNanos = { 0L };
            String[] cpuModel = { null };
            int[] cpuCores = { 0 };
            int[] cpuHwThreads = { 0 };
            String[] osVersion = { null };
            long[] pid = { -1L };
            boolean[] firstEvent = { true };

            // Reusable scratch event so we don't allocate per-event.
            Processor.ParsedEvent scratch = new Processor.ParsedEvent();
            // Reusable scratch fields map. Cleared each event.
            HashMap<String, Object> scratchFields = new HashMap<>();
            // Remember every type seen so we can register them with the Processor
            // once it's constructed. Keyed by type name; value is the MetadataClass
            // captured on first encounter.
            LinkedHashMap<String, MetadataClass> seenTypes = new LinkedHashMap<>();

            // We need metadata.startMs known before constructing Processor —
            // but the JVM start time may arrive on the very first event or via
            // jdk.JVMInformation. Defer Processor construction until we have a
            // sensible start time, by buffering the first few events into a
            // tiny prebuffer just for that.
            // Simpler: snapshot start time on first event with a startTime,
            // then build Processor lazily.
            Processor[] procRef = { null };
            // Tiny prebuffer for events seen before we have meta start time.
            // In practice only a handful of events appear before jdk.JVMInformation.
            ArrayList<ParserShared.PrebufferedEvent> prebuffer = new ArrayList<>();

            try (UntypedJafarParser p = UntypedJafarParser.open(
                    Path.of(tmpPath), ParsingContext.create(),
                    UntypedStrategy.FULL_ITERATION)) {
                p.handle((type, value, ctl) -> {
                    String typeName = type.getName();

                    // Lazily register event type info on first encounter.
                    if (!seenTypes.containsKey(typeName)) {
                        seenTypes.put(typeName, type);
                        if (procRef[0] != null) {
                            procRef[0].registerEventTypeInfo(buildEventTypeInfo(typeName, type));
                        }
                    }

                    Long rawStart = getLong(value, "startTime");
                    if (rawStart != null) {
                        if (firstEvent[0]) {
                            startNanos[0] = rawStart;
                            firstEvent[0] = false;
                        }
                        Long rawDuration = getLong(value, "duration");
                        long endNs = rawStart + (rawDuration != null ? rawDuration : 0L);
                        if (endNs > endNanos[0]) endNanos[0] = endNs;
                    }

                    // Capture metadata-bearing events.
                    switch (typeName) {
                        case "jdk.JVMInformation" -> {
                            jvmVersion[0] = getStr(value, "jvmVersion");
                            jvmArgs[0]    = getStr(value, "jvmArguments");
                            javaArgs[0]   = getStr(value, "javaArguments");
                            Object p2 = value.get("pid");
                            if (p2 instanceof Long l) pid[0] = l;
                            else if (p2 instanceof Integer i) pid[0] = i;
                            Long jvmStart = getLong(value, "jvmStartTime");
                            if (jvmStart != null) startNanos[0] = jvmStart;
                        }
                        case "jdk.CPUInformation" -> {
                            cpuModel[0]    = getStr(value, "cpu");
                            cpuCores[0]    = getIntVal(value, "cores");
                            cpuHwThreads[0] = getIntVal(value, "hwThreads");
                        }
                        case "jdk.OSInformation" -> {
                            osVersion[0] = getStr(value, "osVersion");
                        }
                    }

                    if (procRef[0] == null) {
                        // Defer event processing until we can build Processor.
                        // After ~64 events we commit even without JVMInformation.
                        prebuffer.add(snapshotEvent(typeName, value, rawStart));
                        if (prebuffer.size() >= 64
                                || "jdk.JVMInformation".equals(typeName)
                                || "jdk.CPUInformation".equals(typeName)
                                || "jdk.OSInformation".equals(typeName)) {
                            // If we have any candidate start time, build now.
                            if (startNanos[0] != 0L) {
                                ParserShared.buildProcessorAndDrain(procRef, prebuffer, scratch,
                                    () -> seenTypes.forEach((n, t) -> procRef[0].registerEventTypeInfo(buildEventTypeInfo(n, t))),
                                    jvmVersion, jvmArgs, javaArgs,
                                    startNanos, endNanos,
                                    cpuModel, cpuCores, cpuHwThreads,
                                    osVersion, pid);
                                scratch.frameClassNames = null;
                                scratch.frameMethodNames = null;
                                scratch.frameDescriptors = null;
                                scratch.frameLineNumbers = null;
                                scratch.frameIsJava = null;
                                scratch.stackDepth = 0;
                            }
                        }
                        return;
                    }

                    fillScratch(scratch, scratchFields, typeName, value, rawStart);
                    procRef[0].process(scratch);
                });
                p.run();
            }

            // If still no Processor, build with whatever we have and drain.
            if (procRef[0] == null) {
                ParserShared.buildProcessorAndDrain(procRef, prebuffer, scratch,
                    () -> seenTypes.forEach((n, t) -> procRef[0].registerEventTypeInfo(buildEventTypeInfo(n, t))),
                    jvmVersion, jvmArgs, javaArgs,
                    startNanos, endNanos,
                    cpuModel, cpuCores, cpuHwThreads,
                    osVersion, pid);
            }

            JsonWriter w = new JsonWriter(1 << 20);
            procRef[0].writeProfile(w);
            return w.toJson();
        } catch (Throwable t) {
            t.printStackTrace();
            throw new RuntimeException("JFRParser.parseToProfileJSON failed: " + t.getMessage(), t);
        }
    }

    private static ParserShared.PrebufferedEvent snapshotEvent(
            String typeName, Map<String, Object> value, Long rawStartNs) {
        ParserShared.PrebufferedEvent pe = new ParserShared.PrebufferedEvent();
        pe.typeName = typeName;
        double sm = rawStartNs != null ? rawStartNs / 1_000_000.0 : 0.0;
        Long rawDuration = getLong(value, "duration");
        double dm = rawDuration != null ? rawDuration / 1_000_000.0 : 0.0;
        pe.startMs = sm;
        pe.endMs = sm + dm;
        pe.fields = extractFields(value);
        pe.thread = extractThread(value);
        // Snapshot allocates fresh arrays sized exactly to the stack depth —
        // the prebuffer owns these until drain.
        Object stVal = value.get("stackTrace");
        Map<String, Object> stMap = asMap(stVal);
        if (stMap != null) {
            Object[] rawFrames = asObjectArray(stMap.get("frames"));
            if (rawFrames != null && rawFrames.length > 0) {
                int n = rawFrames.length;
                pe.frameClassNames = new String[n];
                pe.frameMethodNames = new String[n];
                pe.frameDescriptors = new String[n];
                pe.frameLineNumbers = new int[n];
                pe.frameIsJava = new boolean[n];
                fillFrames(rawFrames, n,
                    pe.frameClassNames, pe.frameMethodNames, pe.frameDescriptors,
                    pe.frameLineNumbers, pe.frameIsJava);
                pe.stackDepth = n;
            }
        }
        return pe;
    }

    /** Fill the scratch ParsedEvent in-place from one parser callback. */
    private static void fillScratch(
            Processor.ParsedEvent scratch, HashMap<String, Object> scratchFields,
            String typeName, Map<String, Object> value, Long rawStartNs) {
        scratch.type = typeName;
        double sm = rawStartNs != null ? rawStartNs / 1_000_000.0 : 0.0;
        Long rawDuration = getLong(value, "duration");
        double dm = rawDuration != null ? rawDuration / 1_000_000.0 : 0.0;
        scratch.startMs = sm;
        scratch.endMs = sm + dm;

        scratchFields.clear();
        for (Map.Entry<String, Object> e : value.entrySet()) {
            String key = e.getKey();
            if ("startTime".equals(key) || "duration".equals(key)
                    || "eventThread".equals(key) || "stackTrace".equals(key)) continue;
            Object v = unwrap(e.getValue());
            if (v == null) continue;
            if (v instanceof Map<?, ?> m) {
                flatten(scratchFields, key, m);
            } else {
                scratchFields.put(key, v);
            }
        }
        scratch.fields = scratchFields;
        scratch.thread = extractThread(value);

        // Frames go directly into scratch's reusable parallel arrays.
        Object stVal = value.get("stackTrace");
        Map<String, Object> stMap = asMap(stVal);
        if (stMap == null) {
            scratch.stackDepth = 0;
            return;
        }
        Object[] rawFrames = asObjectArray(stMap.get("frames"));
        if (rawFrames == null || rawFrames.length == 0) {
            scratch.stackDepth = 0;
            return;
        }
        int n = rawFrames.length;
        scratch.ensureFrameCapacity(n);
        fillFrames(rawFrames, n,
            scratch.frameClassNames, scratch.frameMethodNames, scratch.frameDescriptors,
            scratch.frameLineNumbers, scratch.frameIsJava);
        scratch.stackDepth = n;
    }

    private static HashMap<String, Object> extractFields(Map<String, Object> value) {
        HashMap<String, Object> out = new HashMap<>(value.size());
        for (Map.Entry<String, Object> e : value.entrySet()) {
            String key = e.getKey();
            if ("startTime".equals(key) || "duration".equals(key)
                    || "eventThread".equals(key) || "stackTrace".equals(key)) continue;
            Object v = unwrap(e.getValue());
            if (v == null) continue;
            if (v instanceof Map<?, ?> m) flatten(out, key, m);
            else out.put(key, v);
        }
        return out;
    }

    private static Processor.JFRThread extractThread(Map<String, Object> value) {
        Object threadVal = value.get("eventThread");
        Map<String, Object> tMap = asMap(threadVal);
        if (tMap == null) return null;
        String javaName = getStr(tMap, "javaName");
        String osName = getStr(tMap, "osName");
        long id = getLongOrDefault(tMap, "javaThreadId",
                    getLongOrDefault(tMap, "osThreadId", -1L));
        Object virt = tMap.get("virtual");
        boolean isVirtual = virt instanceof Boolean b && b;
        return new Processor.JFRThread(id, javaName, osName, isVirtual);
    }

    /** Decode {@code n} JFR frame entries into the caller's parallel arrays. */
    private static void fillFrames(Object[] rawFrames, int n,
                                   String[] classNames, String[] methodNames,
                                   String[] descriptors, int[] lineNumbers,
                                   boolean[] isJava) {
        for (int i = 0; i < n; i++) {
            Map<String, Object> frame = asMap(rawFrames[i]);
            if (frame == null) {
                classNames[i] = "";
                methodNames[i] = "";
                descriptors[i] = "";
                lineNumbers[i] = -1;
                isJava[i] = true;
                continue;
            }
            String frameType = getStr(frame, "type");
            isJava[i] = !"Native".equals(frameType);
            lineNumbers[i] = getIntVal(frame, "lineNumber");
            String methodName = "";
            String className = "";
            String descriptor = "";
            Object methodVal = frame.get("method");
            Map<String, Object> method = asMap(methodVal);
            if (method != null) {
                String mn = getStr(method, "name");
                if (mn != null) methodName = mn;
                String dsc = getStr(method, "descriptor");
                if (dsc != null) descriptor = dsc;
                Object typeVal = method.get("type");
                Map<String, Object> classMap = asMap(typeVal);
                if (classMap != null) {
                    String cn = getStr(classMap, "name");
                    if (cn != null) className = cn;
                } else if (typeVal instanceof String s) {
                    className = s;
                }
            }
            classNames[i] = className;
            methodNames[i] = methodName;
            descriptors[i] = descriptor;
        }
    }

    private static void flatten(HashMap<String, Object> out, String prefix, Map<?, ?> m) {
        for (Map.Entry<?, ?> e : m.entrySet()) {
            String key = prefix + "." + e.getKey();
            Object v = unwrap(e.getValue());
            if (v == null) continue;
            if (v instanceof Map<?, ?> nested) flatten(out, key, nested);
            else out.put(key, v);
        }
    }

    private static MarkerSchemas.JFREventTypeInfo buildEventTypeInfo(
            String name, MetadataClass type) {
        String label = annotationValue(type, "jdk.jfr.Label");
        String description = annotationValue(type, "jdk.jfr.Description");
        String category = annotationValue(type, "jdk.jfr.Category");
        String[] categoryNames = category != null ? new String[] { category } : new String[0];

        boolean hasStackTrace = false;
        java.util.ArrayList<MarkerSchemas.FieldInfo> fields = new java.util.ArrayList<>();
        List<MetadataField> mfields = type.getFields();
        if (mfields != null) {
            for (MetadataField f : mfields) {
                String fname = f.getName();
                if ("startTime".equals(fname) || "duration".equals(fname)
                        || "eventThread".equals(fname)) continue;
                if ("stackTrace".equals(fname)) {
                    hasStackTrace = true;
                    continue;
                }
                MetadataClass ftype = f.getType();
                String typeName = ftype != null ? ftype.getName() : "java.lang.String";
                String fieldLabel = annotationValue(f, "jdk.jfr.Label");
                String contentType = annotationValue(f, "jdk.jfr.ContentType");
                fields.add(new MarkerSchemas.FieldInfo(fname, typeName, contentType, fieldLabel));
            }
        }
        return new MarkerSchemas.JFREventTypeInfo(
            name, label, description, categoryNames,
            fields.toArray(new MarkerSchemas.FieldInfo[0]),
            hasStackTrace);
    }

    private static String annotationValue(AbstractMetadataElement el, String annotationName) {
        List<MetadataAnnotation> anns;
        try {
            if (el instanceof MetadataClass mc) anns = mc.getAnnotations();
            else if (el instanceof MetadataField mf) anns = mf.getAnnotations();
            else return null;
        } catch (Throwable t) {
            return null;
        }
        if (anns == null) return null;
        for (MetadataAnnotation a : anns) {
            MetadataClass at = a.getType();
            if (at != null && annotationName.equals(at.getName())) {
                return a.getValue();
            }
        }
        return null;
    }

    // ── Expose this class on globalThis.JFRParser ─────────────────────────────

    @FunctionalInterface
    interface ParseHandler {
        String parse(JSObject wrapped);
    }

    public static void register() {
        attachToGlobal(JFRParser::parseToProfileJSON);
    }

    @JS.Coerce
    @JS("""
        globalThis.JFRParser = {
            parseToProfileJSON: (bs) => {
                // parseHandler.parse returns a GraalVM Java-string proxy in
                // some interop modes; coerce to a primitive JS string so the
                // caller can JSON.parse it directly.
                var r = parseHandler.parse({ value: bs });
                return (typeof r === 'string') ? r : (r == null ? '' : String(r));
            }
        };
        """)
    private static native void attachToGlobal(ParseHandler parseHandler);

    @JS.Coerce
    @JS("return obj[prop];")
    private static native String getStringProperty(JSObject obj, String prop);

    // ── Java utility helpers ──────────────────────────────────────────────────

    private static String getStr(Map<String, Object> m, String key) {
        Object v = m.get(key);
        if (v == null) return null;
        // ComplexType string constants come back as Map{"string" -> actualValue}
        // after unwrap(). Extract the inner value rather than calling toString().
        if (v instanceof Map<?, ?> inner) {
            Object s = inner.get("string");
            if (s != null) return s.toString();
        }
        if (v instanceof ComplexType ct) {
            Object inner = ct.getValue();
            if (inner instanceof Map<?, ?> innerMap) {
                Object s = innerMap.get("string");
                if (s != null) return s.toString();
            }
            return inner != null ? inner.toString() : null;
        }
        return v.toString();
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
        if (v instanceof Long l) return (int) (long) l;
        return 0;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object v) {
        if (v instanceof ComplexType ct) v = ct.getValue();
        if (v instanceof Map<?, ?> m) return (Map<String, Object>) m;
        return null;
    }

    private static Object[] asObjectArray(Object v) {
        if (v instanceof ArrayType at) v = at.getArray();
        if (v instanceof Object[] arr) return arr;
        return null;
    }

    private static Object unwrap(Object v) {
        if (v instanceof ComplexType ct) v = ct.getValue();
        if (v instanceof ArrayType at) return at.getArray();
        // String constant-pool entries surface as Map{"string" -> actualValue} —
        // unwrap to the plain string so callers don't see the wrapper map.
        if (v instanceof Map<?, ?> m && m.size() == 1 && m.containsKey("string")) {
            return m.get("string");
        }
        return v;
    }
}
