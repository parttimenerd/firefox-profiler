package me.bechberger.jafar.web;

import com.oracle.svm.core.annotate.Substitute;
import com.oracle.svm.core.annotate.TargetClass;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;

import io.jafar.utils.CustomByteBuffer;

/**
 * WASM doesn't support {@link java.io.RandomAccessFile} (its static initializer requires JNI).
 * Replace {@link io.jafar.utils.CustomByteBuffer#map(Path, int)} with a heap-buffer version.
 * When pending bytes are stored in {@link PendingBytes}, use them directly to avoid a
 * filesystem round-trip; otherwise fall back to {@link Files#readAllBytes(Path)}.
 */
@TargetClass(CustomByteBuffer.class)
final class Target_io_jafar_utils_CustomByteBuffer {

    @Substitute
    static CustomByteBuffer map(Path path) throws IOException {
        return new HeapCustomByteBuffer(ByteBuffer.wrap(PendingBytes.consume(path)));
    }

    @Substitute
    static CustomByteBuffer map(Path path, int chunkSize) throws IOException {
        return new HeapCustomByteBuffer(ByteBuffer.wrap(PendingBytes.consume(path)));
    }
}

/** Holds bytes pre-loaded by JS so the CustomByteBuffer substitution can skip disk I/O. */
final class PendingBytes {
    private static byte[] pending = null;

    static void set(byte[] bytes) { pending = bytes; }

    static byte[] consume(Path path) throws IOException {
        if (pending != null) {
            byte[] b = pending;
            pending = null;
            return b;
        }
        return Files.readAllBytes(path);
    }
}

/** A heap-backed CustomByteBuffer that doesn't require RandomAccessFile / FileChannel. */
final class HeapCustomByteBuffer implements CustomByteBuffer {
    private final ByteBuffer buf;
    private long markPos = -1;

    HeapCustomByteBuffer(ByteBuffer buf) {
        this.buf = buf;
        // BufferBackedRecordingStreamReader does raw getInt() / getLong() / etc. and then
        // conditionally byte-swaps based on isNativeOrder(). For that contract, the buffer's
        // own order must be native (so reads come out as raw memory bytes interpreted natively).
        // We then report isNativeOrder() = (fileOrder == nativeOrder). JFR is big-endian.
        this.buf.order(ByteOrder.nativeOrder());
    }

    @Override public CustomByteBuffer slice() {
        ByteBuffer s = buf.slice();
        s.order(ByteOrder.nativeOrder());
        return new HeapCustomByteBuffer(s);
    }

    @Override public CustomByteBuffer slice(long offset, long length) {
        ByteBuffer dup = buf.duplicate();
        dup.position((int) offset);
        dup.limit((int) (offset + length));
        ByteBuffer s = dup.slice();
        s.order(ByteOrder.nativeOrder());
        return new HeapCustomByteBuffer(s);
    }

    @Override public CustomByteBuffer order(ByteOrder order) {
        // The internal buf must stay in native order so getInt()/getLong() return raw memory bytes;
        // the reader applies its own byte-swap based on isNativeOrder().
        return this;
    }

    @Override public ByteOrder order() { return ByteOrder.BIG_ENDIAN; /* JFR wire format */ }
    @Override public boolean isNativeOrder() { return ByteOrder.BIG_ENDIAN == ByteOrder.nativeOrder(); }
    @Override public void position(long p) { buf.position((int) p); }
    @Override public long position() { return buf.position(); }
    @Override public long remaining() { return buf.remaining(); }
    @Override public long limit() { return buf.limit(); }
    @Override public void get(byte[] dst, int offset, int length) { buf.get(dst, offset, length); }
    @Override public byte get() { return buf.get(); }
    @Override public byte get(long index) { return buf.get((int) index); }
    @Override public short getShort() { return buf.getShort(); }
    @Override public int getInt() { return buf.getInt(); }
    @Override public int getInt(long index) { return buf.getInt((int) index); }
    @Override public long getLong() { return buf.getLong(); }
    @Override public long getLong(long index) { return buf.getLong((int) index); }
    @Override public float getFloat() { return buf.getFloat(); }
    @Override public double getDouble() { return buf.getDouble(); }
    @Override public void mark() { markPos = buf.position(); }
    @Override public void reset() {
        if (markPos < 0) throw new java.nio.InvalidMarkException();
        buf.position((int) markPos);
    }
    @Override public void close() {}
}
