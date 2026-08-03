package me.bechberger.jafar.web;

import io.jafar.parser.api.UntypedJafarParser;
import io.jafar.parser.internal_api.metadata.MetadataClass;
import java.io.FileOutputStream;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import org.graalvm.webimage.api.JS;
import org.graalvm.webimage.api.JSBoolean;
import org.graalvm.webimage.api.JSObject;

/** GraalVM Web Image entry point — wires JFR parsing into the browser DOM. */
public class WebMain {

    // The WASM is loaded both by the standalone jafar webapp (where these DOM
    // elements exist and the drag-drop UI runs) and by the firefox-profiler
    // bundle (where they don't, and only the JFRParser API is needed). Resolve
    // them lazily inside main() — keeping them as static finals would NPE at
    // class-init in the embedded case (and triggers a CSP-blocked inline-script
    // workaround upstream).
    private static JSObject DROP_ZONE;
    private static JSObject FILE_NAME;
    private static JSObject STATUS;
    private static JSObject SUMMARY;
    private static JSObject FILE_INPUT;

    public static void main(String[] args) {
        // Always register the JS-callable parse API. This is the only thing
        // firefox-profiler needs.
        JFRParser.register();
        CJFRParser.register();

        // The drag-drop UI is only useful when the standalone jafar/index.html
        // is the host page. If the elements aren't present (firefox-profiler
        // case), bail out before touching them — addEventListener on null
        // throws and would otherwise crash the whole WASM bootstrap.
        DROP_ZONE  = getElementById("drop-zone");
        FILE_INPUT = getElementById("file-input");
        if (DROP_ZONE == null || FILE_INPUT == null) {
            return;
        }
        FILE_NAME  = getElementById("file-name");
        STATUS     = getElementById("status");
        SUMMARY    = getElementById("summary");

        addEventListener(DROP_ZONE, "dragover", WebMain::onDragOver);
        addEventListener(DROP_ZONE, "dragleave", WebMain::onDragLeave);
        addEventListener(DROP_ZONE, "drop", WebMain::onDrop);
        addEventListener(FILE_INPUT, "change", WebMain::onFileInputChange);
        setStatus("Drop a .jfr file or click to select one.");
    }

    // ── drag & drop ──────────────────────────────────────────────────────────

    private static void onDragOver(JSObject e) {
        preventDefault(e);
        addClass(DROP_ZONE, "drag-over");
    }

    private static void onDragLeave(JSObject e) {
        preventDefault(e);
        removeClass(DROP_ZONE, "drag-over");
    }

    private static void onDrop(JSObject e) {
        preventDefault(e);
        removeClass(DROP_ZONE, "drag-over");
        JSObject dt = getJSProperty(e, "dataTransfer");
        JSObject files = getJSProperty(dt, "files");
        handleFile(getArrayItem(files, 0));
    }

    private static void onFileInputChange(JSObject e) {
        JSObject target = getJSProperty(e, "target");
        JSObject files = getJSProperty(target, "files");
        handleFile(getArrayItem(files, 0));
    }

    private static void handleFile(JSObject file) {
        if (file == null) return;
        String name = getStringProperty(file, "name");
        setTextContent(FILE_NAME, name);
        setDisplay(FILE_NAME, "inline");
        setStatus("Reading file…");
        setDisplay(SUMMARY, "none");
        readFileAsBinaryString(file, wrapper -> {
            try {
                setStatus("Parsing…");
                String binStr = getStringProperty(wrapper, "value");
                processBytes(binStr, name);
            } catch (Throwable t) {
                setStatus("Error: " + t.getMessage());
            }
        });
    }

    // Called when FileReader gives us a binary string (readAsBinaryString)
    private static void processBytes(String binaryString, String filename) {
        try {
            int len = binaryString.length();
            byte[] bytes = new byte[len];
            for (int i = 0; i < len; i++) bytes[i] = (byte) binaryString.charAt(i);
            // Write to virtual FS so Files.size() works; PendingBytes avoids the readAllBytes
            String tmpPath = "/tmp/upload.jfr";
            try (FileOutputStream fos = new FileOutputStream(tmpPath)) {
                fos.write(bytes);
            }
            PendingBytes.set(bytes);
            JfrSummary summary = parseSummary(Path.of(tmpPath));
            String html = summary.toHtml(filename, len);
            setInnerHTML(SUMMARY, html);
            setDisplay(SUMMARY, "block");
            setStatus("Parsed " + filename + " (" + formatSize(len) + ")");
        } catch (Exception ex) {
            ex.printStackTrace();
            Throwable root = ex;
            while (root.getCause() != null) root = root.getCause();
            String detail = ex.getClass().getSimpleName() + ": " + ex.getMessage();
            if (root != ex) detail += " (caused by " + root.getClass().getSimpleName() + ": " + root.getMessage() + ")";
            setStatus("Error: " + detail);
            setDisplay(SUMMARY, "none");
        }
    }

    // ── JFR parsing ──────────────────────────────────────────────────────────

    private static JfrSummary parseSummary(Path path) throws Exception {
        JfrSummary s = new JfrSummary();
        try (UntypedJafarParser p = UntypedJafarParser.open(path)) {
            p.handle((type, value, ctl) -> {
                String typeName = type.getName();
                s.eventCounts.merge(typeName, 1L, Long::sum);
                s.totalEvents++;

                switch (typeName) {
                    case "jdk.JVMInformation" -> {
                        s.jvmName    = str(value, "jvmName");
                        s.jvmVersion = str(value, "jvmVersion");
                    }
                    case "jdk.OSInformation" -> {
                        s.osVersion = str(value, "osVersion");
                    }
                    case "jdk.ActiveRecording" -> {
                        if (s.recordingName == null) s.recordingName = str(value, "name");
                        Object dur = value.get("duration");
                        if (dur instanceof Long d && d > 0) s.durationNanos = d;
                    }
                    case "jdk.CPULoad" -> {
                        Object jvm = value.get("jvmUser");
                        if (jvm instanceof Float f) {
                            s.cpuSamples++;
                            s.cpuSum += f;
                            if (f > s.cpuMax) s.cpuMax = f;
                            if (s.cpuMin < 0 || f < s.cpuMin) s.cpuMin = f;
                        }
                    }
                    case "jdk.GCHeapSummary" -> {
                        Object used = value.get("heapUsed");
                        Object committed = value.get("heapSpace");
                        if (used instanceof Long u) {
                            if (u > s.heapUsedMax) s.heapUsedMax = u;
                            s.heapUsedLast = u;
                        }
                        if (committed instanceof Map<?,?> m) {
                            Object c = m.get("committedSize");
                            if (c instanceof Long cv && cv > s.heapCommitted) s.heapCommitted = cv;
                        }
                    }
                    case "jdk.JavaThreadStatistics" -> {
                        Object peak = value.get("peakCount");
                        if (peak instanceof Long pk && pk > s.threadPeak) s.threadPeak = pk;
                    }
                }
            });
            p.run();
        }
        return s;
    }

    private static String str(Map<String, Object> m, String key) {
        Object v = m.get(key);
        return v != null ? v.toString() : null;
    }

    // ── Summary model ─────────────────────────────────────────────────────────

    private static class JfrSummary {
        long totalEvents = 0;
        Map<String, Long> eventCounts = new HashMap<>();
        String jvmName, jvmVersion, osVersion, recordingName;
        long durationNanos = 0;
        int cpuSamples = 0;
        float cpuSum = 0, cpuMax = 0, cpuMin = -1;
        long heapUsedMax = 0, heapUsedLast = 0, heapCommitted = 0;
        long threadPeak = 0;

        String toHtml(String filename, int fileSize) {
            StringBuilder sb = new StringBuilder();

            // Recording info card
            sb.append("<div class='card'>");
            sb.append("<h2>Recording Info</h2>");
            sb.append("<table>");
            row(sb, "File", escHtml(filename));
            row(sb, "Size", formatSize(fileSize));
            if (recordingName != null) row(sb, "Name", escHtml(recordingName));
            if (durationNanos > 0) row(sb, "Duration", formatDuration(durationNanos));
            row(sb, "Total Events", Long.toString(totalEvents));
            if (jvmName != null) row(sb, "JVM", escHtml(jvmName));
            if (jvmVersion != null) row(sb, "JVM Version", escHtml(jvmVersion));
            if (osVersion != null) row(sb, "OS", escHtml(osVersion).replace("\n", "<br>"));
            sb.append("</table></div>");

            // Top event types card
            sb.append("<div class='card'>");
            sb.append("<h2>Top Event Types</h2>");
            sb.append("<table><thead><tr><th>Event Type</th><th class='num'>Count</th><th class='num'>%</th></tr></thead><tbody>");
            eventCounts.entrySet().stream()
                .sorted(Map.Entry.<String, Long>comparingByValue().reversed())
                .limit(20)
                .forEach(e -> {
                    double pct = totalEvents > 0 ? 100.0 * e.getValue() / totalEvents : 0;
                    sb.append("<tr><td class='mono'>").append(escHtml(e.getKey())).append("</td>")
                      .append("<td class='num'>").append(e.getValue()).append("</td>")
                      .append("<td class='num'>").append(String.format("%.1f", pct)).append("%</td></tr>");
                });
            sb.append("</tbody></table></div>");

            // CPU load card
            if (cpuSamples > 0) {
                sb.append("<div class='card'>");
                sb.append("<h2>JVM CPU Load</h2>");
                sb.append("<table>");
                row(sb, "Min", String.format("%.1f%%", cpuMin * 100));
                row(sb, "Avg", String.format("%.1f%%", (cpuSum / cpuSamples) * 100));
                row(sb, "Max", String.format("%.1f%%", cpuMax * 100));
                row(sb, "Samples", Integer.toString(cpuSamples));
                sb.append("</table></div>");
            }

            // Heap card
            if (heapUsedMax > 0 || heapCommitted > 0) {
                sb.append("<div class='card'>");
                sb.append("<h2>Heap Usage</h2>");
                sb.append("<table>");
                if (heapUsedMax > 0)  row(sb, "Max Used",  formatSize(heapUsedMax));
                if (heapUsedLast > 0) row(sb, "Last Used", formatSize(heapUsedLast));
                if (heapCommitted > 0) row(sb, "Committed", formatSize(heapCommitted));
                sb.append("</table></div>");
            }

            // Threads card
            if (threadPeak > 0) {
                sb.append("<div class='card'>");
                sb.append("<h2>Threads</h2>");
                sb.append("<table>");
                row(sb, "Peak Thread Count", Long.toString(threadPeak));
                sb.append("</table></div>");
            }

            return sb.toString();
        }

        private void row(StringBuilder sb, String label, String value) {
            sb.append("<tr><td class='label'>").append(escHtml(label))
              .append("</td><td>").append(value).append("</td></tr>");
        }
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    private static String escHtml(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private static String formatSize(long bytes) {
        if (bytes >= 1024L * 1024 * 1024) return String.format("%.1f GB", bytes / (1024.0 * 1024 * 1024));
        if (bytes >= 1024L * 1024) return String.format("%.1f MB", bytes / (1024.0 * 1024));
        if (bytes >= 1024) return String.format("%.1f KB", bytes / 1024.0);
        return bytes + " B";
    }

    private static String formatDuration(long nanos) {
        long ms = nanos / 1_000_000;
        if (ms >= 60_000) return String.format("%.1f min", ms / 60000.0);
        if (ms >= 1_000)  return String.format("%.2f s", ms / 1000.0);
        return ms + " ms";
    }

    // ── JS bridge ─────────────────────────────────────────────────────────────

    @JS.Coerce
    @JS("return document.getElementById(id);")
    public static native JSObject getElementById(String id);

    @JS.Coerce
    @JS("return obj[prop];")
    public static native String getStringProperty(JSObject obj, String prop);

    @JS.Coerce
    @JS("return obj[prop];")
    public static native JSObject getJSProperty(JSObject obj, String prop);

    @JS.Coerce
    @JS("el.textContent = text;")
    public static native void setTextContent(JSObject el, String text);

    @JS.Coerce
    @JS("e.preventDefault(); e.stopPropagation();")
    public static native void preventDefault(JSObject e);

    @JS.Coerce
    @JS("el.classList.add(cls);")
    public static native void addClass(JSObject el, String cls);

    @JS.Coerce
    @JS("el.classList.remove(cls);")
    public static native void removeClass(JSObject el, String cls);

    @JS.Coerce
    @JS("el.style.display = value;")
    public static native void setDisplay(JSObject el, String value);

    @JS.Coerce
    @JS("el.innerHTML = html;")
    public static native void setInnerHTML(JSObject el, String html);

    @JS.Coerce
    @JS("return arr[idx];")
    public static native JSObject getArrayItem(JSObject arr, int idx);

    @JS.Coerce
    @JS("setTimeout(r, 0);")
    private static native void runAsync(Runnable r);

    @JS.Coerce
    @JS("o.addEventListener(event, (e) => handler(e));")
    static native void addEventListenerImpl(JSObject o, String event, EventHandler handler);

    static void addEventListener(JSObject o, String event, EventHandler handler) {
        addEventListenerImpl(o, event, e -> {
            try {
                handler.handleEvent(e);
            } catch (Throwable t) {
                setStatus("Error: " + t.getMessage());
            }
        });
    }

    // Read file as binary string via readAsBinaryString (no base64 encoding overhead)
    @JS.Coerce
    @JS("""
        var reader = new FileReader();
        reader.onload = function(ev) {
            callback({ value: ev.target.result });
        };
        reader.readAsBinaryString(file);
        """)
    private static native void readFileAsBinaryString(JSObject file, StringCallback callback);

    private static void setStatus(String msg) {
        setTextContent(STATUS, msg);
    }
}

@FunctionalInterface
interface EventHandler {
    void handleEvent(JSObject event);
}

@FunctionalInterface
interface StringCallback {
    void call(JSObject value);
}
