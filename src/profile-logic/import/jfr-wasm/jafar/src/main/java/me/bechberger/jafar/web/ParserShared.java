package me.bechberger.jafar.web;

import java.util.ArrayList;
import java.util.HashMap;
import me.bechberger.jafar.web.converter.Processor;

/**
 * Format-agnostic prebuffer + drain logic shared between {@link JFRParser} and
 * {@link CJFRParser}.
 *
 * <p>Both parsers use the same two-phase approach: buffer the first few events until
 * a JVM-start time is known, then construct the {@link Processor} and drain the buffer
 * before continuing in streaming mode.
 */
final class ParserShared {

    /** Lightweight snapshot of a parsed event stored in the prebuffer. */
    static final class PrebufferedEvent {
        String typeName;
        double startMs;
        double endMs;
        HashMap<String, Object> fields;
        Processor.JFRThread thread;
        int stackDepth;
        String[] frameClassNames;
        String[] frameMethodNames;
        String[] frameDescriptors;
        int[] frameLineNumbers;
        boolean[] frameIsJava;
    }

    /**
     * Construct a {@link Processor} from the accumulated metadata and drain all
     * buffered events through it. After this call, {@code procRef[0]} is non-null and
     * {@code prebuffer} is empty.
     *
     * <p>The drain re-points {@code scratch}'s frame arrays at prebuffer-owned arrays.
     * After returning, the caller must null out those arrays so the next {@code fillScratch}
     * allocates fresh ones rather than mutating the (now-cleared) prebuffer entries.
     */
    static void buildProcessorAndDrain(
            Processor[] procRef,
            ArrayList<PrebufferedEvent> prebuffer,
            Processor.ParsedEvent scratch,
            Runnable registerTypeInfos,
            String[] jvmVersion,
            String[] jvmArgs,
            String[] javaArgs,
            long[] startNanos,
            long[] endNanos,
            String[] cpuModel,
            int[] cpuCores,
            int[] cpuHwThreads,
            String[] osVersion,
            long[] pid) {
        Processor.JFRMetadata meta =
                new Processor.JFRMetadata(
                        jvmVersion[0],
                        jvmArgs[0],
                        javaArgs[0],
                        startNanos[0] / 1_000_000.0,
                        endNanos[0] / 1_000_000.0,
                        cpuModel[0],
                        cpuCores[0] != 0 ? cpuCores[0] : null,
                        cpuHwThreads[0] != 0 ? cpuHwThreads[0] : null,
                        osVersion[0],
                        pid[0]);
        procRef[0] = new Processor(me.bechberger.jafar.web.converter.ConverterConfig.defaults(), meta);

        registerTypeInfos.run();

        for (PrebufferedEvent e : prebuffer) {
            scratch.type = e.typeName;
            scratch.startMs = e.startMs;
            scratch.endMs = e.endMs;
            scratch.fields = e.fields;
            scratch.thread = e.thread;
            scratch.stackDepth = e.stackDepth;
            scratch.frameClassNames = e.frameClassNames;
            scratch.frameMethodNames = e.frameMethodNames;
            scratch.frameDescriptors = e.frameDescriptors;
            scratch.frameLineNumbers = e.frameLineNumbers;
            scratch.frameIsJava = e.frameIsJava;
            procRef[0].process(scratch);
        }
        prebuffer.clear();
        scratch.frameClassNames = null;
        scratch.frameMethodNames = null;
        scratch.frameDescriptors = null;
        scratch.frameLineNumbers = null;
        scratch.frameIsJava = null;
        scratch.stackDepth = 0;
    }

    private ParserShared() {}
}
