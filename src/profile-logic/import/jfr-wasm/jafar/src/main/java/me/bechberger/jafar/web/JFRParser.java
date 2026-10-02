package me.bechberger.jafar.web;

import java.io.ByteArrayOutputStream;
import me.bechberger.jfrtofp.converter.JFRConverter;
import org.graalvm.webimage.api.JS;
import org.graalvm.webimage.api.JSObject;

/**
 * GraalVM Web Image entry point for standard JFR files.
 * Thin shim — all conversion logic is in jfrtofp's JFRConverter.
 */
public final class JFRParser {

    public static String parseToProfileJSON(JSObject wrapped) {
        try {
            String binaryString = getStringProperty(wrapped, "value");
            int len = binaryString.length();
            byte[] bytes = new byte[len];
            for (int i = 0; i < len; i++) bytes[i] = (byte) binaryString.charAt(i);
            binaryString = null;

            ByteArrayOutputStream baos = new ByteArrayOutputStream(1 << 20);
            JFRConverter.convert(bytes, ".jfr", baos);
            return baos.toString("UTF-8");
        } catch (Throwable t) {
            t.printStackTrace();
            throw new RuntimeException("JFRParser.parseToProfileJSON failed: " + t.getMessage(), t);
        }
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
}
