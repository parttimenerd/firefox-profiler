package me.bechberger.jafar.web;

import com.oracle.svm.core.annotate.Substitute;
import com.oracle.svm.core.annotate.TargetClass;
import net.jpountz.lz4.LZ4Factory;

/**
 * GraalVM WASM has no JNI support. {@link LZ4Factory#fastestInstance()} tries to load a native
 * library, which fails at WASM runtime. Substitute it (and the unsafe variant) to always return
 * the pure-Java safe factory, which has no native dependencies.
 */
@TargetClass(LZ4Factory.class)
final class Target_net_jpountz_lz4_LZ4Factory {

    @Substitute
    public static LZ4Factory fastestInstance() {
        return LZ4Factory.safeInstance();
    }

    @Substitute
    public static LZ4Factory fastestJavaInstance() {
        return LZ4Factory.safeInstance();
    }

    @Substitute
    public static LZ4Factory unsafeInstance() {
        return LZ4Factory.safeInstance();
    }
}
